import {
  type CSSProperties,
  memo,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  type BoardCamera,
  boardBounds,
  FRAME_MAX,
  FRAME_MIN,
  regroupSections,
  SMALL_THUMB_WIDTH,
  sectionBounds,
} from '../../../shared/board'
import {
  type BoardViewPoint,
  type BoardViewRect,
  boardPoint,
  boardRectFrom,
  boardRectFromBoardView,
  boardViewFromBoard,
  boardViewPoint,
  boardViewRect,
  boardViewRectFromBoard,
} from '../../../shared/coords'
import { Spring } from '../../../shared/motion'
import { matchesShortcut } from '../../../shared/shortcuts'
import type { BoardFrame, BoardState, Rect } from '../../../shared/types'
import {
  centreIn,
  dragFrom,
  dragOffset,
  fitIn,
  inMarquee,
  marqueeRect,
  scrollBy,
  shownShare,
  zoomAbout,
} from '../board/camera'
import { GRID, GRID_MIN, HANDLE } from '../board-gl/scene'
import { BoardSurface, type BoardSurfaceHandle } from '../board-gl/surface'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { readableError } from '../lib/errors'
import { FIELD_LOOK, InlineError } from '../lib/field'
import { onFrames, prefersReducedMotion } from '../lib/motion'
import { Card } from '../lib/surface'
import { PromptButton, Spinner } from '../lib/ui'

/** The frame label's height above a frame, in screen pixels. */
const LABEL_HEIGHT = 22
/** A section's name's height, in screen pixels. */
const SECTION_LABEL_HEIGHT = LABEL_HEIGHT + 2
/** A press that moves less than this (screen pixels) is a click, not a drag. */
const DRAG_SLOP = 3
/** A section's name sits this far inside its top-left corner, in screen pixels. */
const SECTION_INSET = 10
/** A frame narrower than this on screen shows its name above it without its size. */
const SIZE_LABEL_MIN = 140
/** Zoomed out further, frames' names go without their sizes. */
const SIZE_LABEL_ZOOM = 0.5
/** Each ⌘+ or ⌘− step. */
const ZOOM_STEP = 1.25
/** Two clicks on a frame this close together open it. */
const DOUBLE_CLICK_MS = 400
/** Where the camera rests, saved this long after the last pan or zoom. */
const SAVE_CAMERA_MS = 400
/** A pinch's ⌃-wheel deltas are small; a mouse wheel's are ~100 a notch. One notch, one step. */
const PINCH_DELTA_MAX = 22
/** The floating chat is framed around only when what it leaves clear is at least this wide. */
const CLEAR_MIN_WIDTH = 320
/** macOS turns ⌃-click into a right-click: its menu, not a drag. */
const MAC = navigator.platform.toLowerCase().includes('mac')

/** How long a sent starter waits to see the agent start before the starters come back. */
const SENT_WAIT_MS = 10_000

/** Prompts for an empty canvas: the kinds of thing a board is good for. */
const STARTERS = [
  'Kiln, a booking app for pottery studios',
  'Three different pricing page options, side by side',
  'A mobile onboarding flow in three screens',
  'A dashboard for a small fitness studio',
]

interface Size {
  width: number
  height: number
}

// The board's camera, shared with the toolbar's zoom controls (`useBoardView`).
interface BoardView {
  camera: BoardCamera | null
  zoomBy: (factor: number) => void
  fit: () => void
}

let view: BoardView = { camera: null, zoomBy: () => undefined, fit: () => undefined }
const viewListeners = new Set<() => void>()

function publishView(next: BoardView) {
  view = next
  for (const listener of viewListeners) listener()
}

/** The board's zoom and its controls, for the toolbar. */
export function useBoardView() {
  return useSyncExternalStore(
    (listener) => {
      viewListeners.add(listener)
      return () => {
        viewListeners.delete(listener)
      }
    },
    () => view,
  )
}

/** What a drag on the board does: Move selects and moves frames, Hand pans, as in Figma. */
export type BoardTool = 'move' | 'hand'

// The board's tool, shared with the toolbar's Move/Hand control (`useBoardTool`).
let tool: BoardTool = 'move'
const toolListeners = new Set<() => void>()

export function setBoardTool(next: BoardTool) {
  if (next === tool) return
  tool = next
  for (const listener of toolListeners) listener()
}

export function useBoardTool() {
  return useSyncExternalStore(
    (listener) => {
      toolListeners.add(listener)
      return () => {
        toolListeners.delete(listener)
      }
    },
    () => tool,
  )
}

/** Where a frame (or a section) is on the board, in board pixels. */
type Area = Pick<BoardFrame, 'x' | 'y' | 'width' | 'height'>
/**
 * A frame moved or resized on the board before main has it, as it's drawn meanwhile: only what
 * the gesture changes, so its name and thumbnail stay main's.
 */
type Override = Partial<Area>

type Gesture =
  | {
      kind: 'move'
      start: BoardViewPoint
      ids: string[]
      /** The frame pressed, which a double-click opens */
      hit: string | null
      /** It was one of several selected, without ⇧: a click (no drag) selects it alone */
      narrow: boolean
      moved: boolean
      /** The press was on a frame already selected, with ⇧: a click deselects it */
      toggle: string | null
      /** The press was on this section's name, which moves all its frames */
      section?: string
    }
  | { kind: 'resize'; start: BoardViewPoint; id: string; from: Area }
  | { kind: 'pan'; start: BoardViewPoint; from: BoardCamera }
  | { kind: 'marquee'; start: BoardViewPoint; now: BoardViewPoint; add: string[] }

/**
 * A canvas's frames on a pannable, zoomable board, like Figma's: their thumbnails (main
 * captures them as their pages change), their names above them, and what's selected. Scroll
 * pans, ⌘-scroll or a pinch zooms, Space-drag pans; drag frames to move them, their corner to
 * resize them, across empty board to select several; double-click opens one live, as ⌘D does
 * to pick in it.
 */
export function Board({
  board,
  working = false,
  gl = false,
}: {
  board: BoardState
  working?: boolean
  /**
   * Development only (`GUI_BOARD_WEBGL=1`): the board's pixels (the grid, sections, frames and
   * their thumbnails, what's selected, the marquee) are drawn on a canvas under this DOM,
   * which keeps the names, the fields and what the pointer presses.
   */
  gl?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const surface = useRef<BoardSurfaceHandle>(null)
  /** WebGL2 couldn't start, so the canvas can't draw the board */
  const [unavailable, setUnavailable] = useState(false)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  const [camera, commitCamera] = useState<BoardCamera | null>(board.camera)
  const liveCamera = useRef(camera)
  const layer = useRef<HTMLDivElement>(null)
  const cameraTimers = useRef<{
    cull?: ReturnType<typeof setTimeout>
    rest?: ReturnType<typeof setTimeout>
  }>({})
  const drawCamera = () => {
    const current = liveCamera.current
    if (!current || !ref.current || !layer.current) return
    const { zoom } = current
    const origin = boardViewFromBoard(boardPoint(0, 0), current)
    layer.current.style.transform = `translate(${origin.x}px, ${origin.y}px) scale(${zoom})`
    // What's drawn at screen size in the layer reads these, so it keeps up with every frame of
    // a pan or pinch rather than with the throttled `camera`.
    layer.current.style.setProperty('--board-px', `${1 / zoom}px`)
    layer.current.style.setProperty('--board-zoom', String(zoom))
    layer.current.style.setProperty('--board-unzoom', String(1 / zoom))
    surface.current?.invalidate()
    if (gl) return
    ref.current.style.backgroundPosition = `${origin.x}px ${origin.y}px`
    ref.current.style.backgroundSize = `${GRID * zoom}px ${GRID * zoom}px`
  }
  const cameraFlight = useRef<(() => void) | null>(null)
  /** The camera's position on its way, kept while it glides so a new glide keeps its speed */
  const cameraSprings = useRef<{ x: Spring; y: Spring } | null>(null)
  const stopCameraFlight = () => {
    cameraFlight.current?.()
    cameraFlight.current = null
    cameraSprings.current = null
  }
  const setCamera = (
    next: BoardCamera | null | ((current: BoardCamera | null) => BoardCamera | null),
  ) => {
    stopCameraFlight()
    liveCamera.current = typeof next === 'function' ? next(liveCamera.current) : next
    commitCamera(liveCamera.current)
  }
  const updateCamera = (
    next: BoardCamera | null | ((current: BoardCamera | null) => BoardCamera | null),
  ) => {
    liveCamera.current = typeof next === 'function' ? next(liveCamera.current) : next
    drawCamera()
    unsaved.current = liveCamera.current
    const timers = cameraTimers.current
    // Refresh culling during long gestures without rebuilding the board for every event.
    timers.cull ??= setTimeout(() => {
      timers.cull = undefined
      commitCamera(liveCamera.current)
    }, 100)
    clearTimeout(timers.rest)
    timers.rest = setTimeout(() => commitCamera(liveCamera.current), 150)
  }
  const moveCamera = (
    next: BoardCamera | null | ((current: BoardCamera | null) => BoardCamera | null),
  ) => {
    stopCameraFlight()
    updateCamera(next)
  }
  useLayoutEffect(drawCamera)
  useEffect(
    () => () => {
      cameraFlight.current?.()
      revealing.current++
      clearTimeout(cameraTimers.current.cull)
      clearTimeout(cameraTimers.current.rest)
    },
    [],
  )
  const [overrides, setOverrides] = useState<Record<string, Override>>({})
  const [gesture, setGestureState] = useState<Gesture | null>(null)
  /** The gesture under way, for listeners that run between renders (pointer-up, the wheel) */
  const gestureRef = useRef<Gesture | null>(null)
  const setGesture = (next: Gesture | null) => {
    if (next) stopCameraFlight()
    gestureRef.current = next
    setGestureState(next)
  }
  /** Arrow keys held: the frames move as drawn, and land as one change when the key comes up */
  const nudge = useRef<{ ids: string[]; dx: number; dy: number } | null>(null)
  /** Frames added out of sight, to bring into it once no gesture holds the camera */
  const unseen = useRef<string[]>([])
  /** Counts reveals begun, so only the latest (and none after the board goes) moves the camera */
  const revealing = useRef(0)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renamingSection, setRenamingSection] = useState<string | null>(null)
  /** The section picked by its name, while its frames are what's selected */
  const [pickedSection, setPickedSection] = useState<string | null>(null)
  /**
   * Selects frames. Picking a section by its name selects its frames with it; selecting them
   * any other way (a marquee, ⌘A, a click) selects frames, not the section.
   */
  const select = (ids: string[], section: string | null = null) => {
    setPickedSection(section)
    gui.boardSelect(ids)
  }
  const [space, setSpace] = useState(false)
  /** What's selected, said to a screen reader as it changes */
  const [announcement, setAnnouncement] = useState('')
  // Space held is the Hand for as long as it's held.
  const hand = useBoardTool() === 'hand' || space
  // A frame without an override stays the object main sent, so its tile and name aren't drawn again.
  const frames = board.frames.map((frame) => {
    const override = overrides[frame.id]
    return override ? { ...frame, ...override } : frame
  })
  const selected = new Set(board.selection)
  // Frames being dragged leave or join sections as they would if dropped here.
  const sections =
    gesture?.kind === 'move' && gesture.moved
      ? regroupSections(board.sections, frames, gesture.ids, board.frames)
      : board.sections
  const picked = board.sections.find(
    (section) =>
      section.id === pickedSection &&
      section.frames.length === board.selection.length &&
      section.frames.every((id) => selected.has(id)),
  )
  /** The last click on a frame, to tell a double-click (the pointer is captured, so no dblclick) */
  const lastClick = useRef<{ id: string; at: number } | null>(null)
  // Every state from main is a new object; this changes only when the layout does.
  const layout = JSON.stringify(board.frames.map((f) => [f.id, f.x, f.y, f.width, f.height]))
  const selection = board.selection.join('\n')

  // What main has now replaces what was drawn ahead of it, unless a drag or a nudge is still
  // going: dropping its frames back mid-gesture (the agent moved something) would lose it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new layout from main is the trigger.
  useEffect(() => {
    if (!gestureRef.current && !nudge.current) setOverrides({})
  }, [layout])

  // A section stays picked only while its frames are exactly what's selected; selecting them
  // again some other way later (a marquee, ⌘A) selects frames, not the section.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new selection is the trigger.
  useEffect(() => {
    const section = board.sections.find((s) => s.id === pickedSection)
    const same =
      section?.frames.length === board.selection.length &&
      section.frames.every((id) => board.selection.includes(id))
    if (!same) setPickedSection(null)
    const names = board.selection.flatMap((id) => board.frames.find((f) => f.id === id)?.name ?? [])
    setAnnouncement(
      same
        ? `${section.name} selected`
        : names.length === 0
          ? ''
          : names.length === 1
            ? `${names[0]} selected`
            : `${names.length} frames selected`,
    )
  }, [selection])

  // A name field whose frame or section is gone (deleted, by the agent or ⌘Z) closes with it.
  useEffect(() => {
    if (renaming && !board.frames.some((frame) => frame.id === renaming)) setRenaming(null)
    if (renamingSection && !board.sections.some((section) => section.id === renamingSection))
      setRenamingSection(null)
  }, [board.frames, board.sections, renaming, renamingSection])

  // A name field that closes (Enter, Esc) gives the keyboard back to the board, rather than
  // leaving it nowhere.
  const naming = renaming ?? renamingSection
  const wasNaming = useRef(naming)
  useEffect(() => {
    const was = wasNaming.current
    wasNaming.current = naming
    if (was && !naming && document.activeElement === document.body) {
      ref.current?.focus({ preventScroll: true })
    }
  }, [naming])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight })
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [])

  const glideCamera = (target: BoardCamera) => {
    const from = liveCamera.current
    // Mid-glide, it turns toward the new spot at the speed it has.
    const springs = cameraSprings.current
    stopCameraFlight()
    if (!from || prefersReducedMotion() || document.visibilityState === 'hidden') {
      setCamera(target)
      return
    }
    const { x, y } = springs ?? { x: new Spring(from.x), y: new Spring(from.y) }
    x.retarget(target.x)
    y.retarget(target.y)
    cameraSprings.current = { x, y }
    // Half a screen pixel, in the board's units
    const precision = 0.5 / Math.max(target.zoom, 0.01)
    cameraFlight.current = onFrames((dt) => {
      x.step(dt)
      y.step(dt)
      if (!x.atRest(precision) || !y.atRest(precision)) {
        updateCamera({ ...target, x: x.value, y: y.value })
        return false
      }
      cameraFlight.current = null
      cameraSprings.current = null
      setCamera(target)
      return true
    })
  }

  // The latest of what the board's listeners read, without subscribing them again each render.
  const latest = useRef({ frames: board.frames, sections: board.sections, camera, size })
  latest.current = {
    frames: board.frames,
    sections: board.sections,
    camera: liveCamera.current,
    size,
  }
  // Everything in sight, around the floating chat when it covers part of the board.
  const fit = () => {
    const el = ref.current
    if (!el) return
    void clearArea(el, latest.current.size).then((area) => {
      const { frames, sections } = latest.current
      const areas = sections.flatMap((section) => sectionBounds(section, frames) ?? [])
      const bounds = boardBounds([...frames, ...areas])
      setCamera(fitIn(bounds && boardRectFrom(bounds), area))
    })
  }
  const zoomAt = (factor: number, at: BoardViewPoint) =>
    moveCamera((current) => current && zoomAbout(current, factor, at))
  /** Around the middle of the board, as the keys and the toolbar zoom. */
  const zoomCentred = (factor: number) => {
    const { size } = latest.current
    zoomAt(factor, boardViewPoint(size.width / 2, size.height / 2))
  }
  /** Brings a frame into sight, at the zoom there is, unless most of it shows already. */
  const reveal = (frame: Area) => {
    const { camera, size } = latest.current
    if (!camera) return
    const rect = boardRectFrom(frame)
    const view = boardViewRect(0, 0, size.width, size.height)
    if (shownShare(boardViewRectFromBoard(rect, camera), view) >= 0.5) return
    setCamera(centreIn(rect, view, camera.zoom))
  }

  // Opened without a saved camera: everything in sight, once the board has a size.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fit reads the latest frames itself.
  useEffect(() => {
    if (!camera && size.width) fit()
  }, [camera, size.width])

  // The board takes the keyboard as it opens (Delete, arrows, H and V work at once), unless
  // something else in the window has it.
  const hasCamera = camera !== null
  useEffect(() => {
    if (hasCamera && document.activeElement === document.body)
      ref.current?.focus({ preventScroll: true })
  }, [hasCamera])

  // New frames (the agent's, or added from the menu) come into sight when they land out of
  // it, or under the floating chat. Not while a drag, resize or marquee holds the camera: the
  // frame under the pointer would slide away from it. They come into sight as it ends.
  const revealAdded = () => {
    const el = ref.current
    const { size } = latest.current
    if (!unseen.current.length || !el || !liveCamera.current || !size.width) return
    if (gestureRef.current) return
    const token = ++revealing.current
    void clearArea(el, size).then((area) => {
      // A later reveal has them all, or a gesture began meanwhile (this runs again as it ends).
      if (token !== revealing.current || gestureRef.current) return
      const camera = liveCamera.current
      const ids = unseen.current
      unseen.current = []
      const added = latest.current.frames.filter((frame) => ids.includes(frame.id))
      if (!camera) return
      const inSight = added.some(
        (frame) => shownShare(boardViewRectFromBoard(boardRectFrom(frame), camera), area) >= 0.5,
      )
      const bounds = boardBounds(added)
      if (inSight || !bounds) return
      glideCamera(centreIn(boardRectFrom(bounds), area, camera.zoom))
    })
  }
  const known = useRef(new Set(board.frames.map((frame) => frame.id)))
  // biome-ignore lint/correctness/useExhaustiveDependencies: the layout is the trigger; the rest is read as it is.
  useEffect(() => {
    const { frames, camera, size } = latest.current
    const added = frames.filter((frame) => !known.current.has(frame.id))
    known.current = new Set(frames.map((frame) => frame.id))
    if (!added.length || !camera || !size.width) return
    unseen.current = [...unseen.current, ...added.map((frame) => frame.id)]
    revealAdded()
  }, [layout])

  // Saved once it rests, for the next time the canvas opens, and as the board goes (opening a
  // frame, another tab): main keeps it only for this canvas.
  const unsaved = useRef<BoardCamera | null>(null)
  useEffect(() => {
    if (!camera) return
    unsaved.current = camera
    const timer = setTimeout(() => {
      unsaved.current = null
      gui.boardCamera(camera, board.id)
    }, SAVE_CAMERA_MS)
    return () => clearTimeout(timer)
  }, [camera, board.id])
  // biome-ignore lint/correctness/useExhaustiveDependencies: only as the board goes.
  useEffect(
    () => () => {
      if (unsaved.current) gui.boardCamera(liveCamera.current ?? unsaved.current, board.id)
    },
    [],
  )

  // The toolbar's zoom controls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: zoomCentred and fit read the latest state themselves.
  useEffect(() => {
    publishView({
      camera,
      zoomBy: zoomCentred,
      fit,
    })
  }, [camera])
  useEffect(
    () => () => publishView({ camera: null, zoomBy: () => undefined, fit: () => undefined }),
    [],
  )

  // biome-ignore lint/correctness/useExhaustiveDependencies: fit reads the latest frames itself.
  useEffect(
    () =>
      gui.onBoardCommand((command) => {
        if (command.type === 'renameFrame') setRenaming(command.id)
        else if (command.type === 'renameSection') setRenamingSection(command.id)
        else if (command.type === 'fit' || (command.type === 'zoom' && command.step === 0)) fit()
        else if (command.type === 'zoom')
          zoomCentred(command.step === 1 ? ZOOM_STEP : 1 / ZOOM_STEP)
      }),
    [],
  )

  // Scrolling pans; ⌘ or a pinch (which arrives as ⌃-wheel) zooms around the pointer. Bound
  // again only when the board's element is (it's another before the camera is known).
  // biome-ignore lint/correctness/useExhaustiveDependencies: zoomAt and setCamera only update the camera.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      // Mid-drag, the drag's offsets would come apart from the pointer.
      if (gestureRef.current) return
      const box = el.getBoundingClientRect()
      const at = boardViewPoint(event.clientX - box.left, event.clientY - box.top)
      if (event.ctrlKey || event.metaKey) {
        // A mouse wheel with ⌃ held turns in big notches: each is one step, as ⌘+ is.
        const delta = event.ctrlKey
          ? Math.max(-PINCH_DELTA_MAX, Math.min(PINCH_DELTA_MAX, event.deltaY))
          : event.deltaY
        zoomAt(Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)), at)
        return
      }
      moveCamera(
        (current) => current && scrollBy(current, boardViewPoint(event.deltaX, event.deltaY)),
      )
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [hasCamera])

  // Space held: dragging pans, as in every design tool. Only for the board (or nothing
  // focused): Space still presses the toolbar's buttons.
  useEffect(() => {
    const forBoard = (target: EventTarget | null) =>
      target === document.body || (!!ref.current && target === ref.current)
    const down = (event: KeyboardEvent) => {
      if (event.code === 'Space' && forBoard(event.target)) {
        event.preventDefault()
        setSpace(true)
      }
    }
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpace(false)
    }
    // Let go while in another app: no keyup comes.
    const blur = () => setSpace(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  // What the names do, by id: the same functions every render, so a name redraws only when
  // something it shows changes (not at every step of a drag).
  const labelActions = useRef<LabelActions | null>(null)
  labelActions.current = {
    selectFrame: (id, add) => {
      // ⇧ on a selected frame's name deselects it, as on the frame.
      if (!add) select([id])
      else if (board.selection.includes(id)) select(board.selection.filter((other) => other !== id))
      else select([...board.selection, id])
    },
    renameFrame: (id) => setRenaming(id),
    renamedFrame: (id, name) => {
      setRenaming(null)
      const frame = board.frames.find((f) => f.id === id)
      if (name && frame && name !== frame.name) gui.boardRenameFrame(id, name)
    },
    renamedSection: (id, name) => {
      setRenamingSection(null)
      const section = board.sections.find((s) => s.id === id)
      if (name && section && name !== section.name) gui.boardRenameSection(id, name)
    },
  }
  const [labels] = useState<LabelActions>(() => ({
    selectFrame: (id, add) => labelActions.current?.selectFrame(id, add),
    renameFrame: (id) => labelActions.current?.renameFrame(id),
    renamedFrame: (id, name) => labelActions.current?.renamedFrame(id, name),
    renamedSection: (id, name) => labelActions.current?.renamedSection(id, name),
  }))

  if (!camera) return <div ref={ref} className="absolute inset-0" />
  if (gl && unavailable) return <BoardUnavailable />

  // The camera as drawn this moment, which `camera` follows a little behind during a pan or pinch.
  const drawnCamera = () => liveCamera.current ?? camera
  const local = (event: { clientX: number; clientY: number }) => {
    const box = ref.current?.getBoundingClientRect()
    return boardViewPoint(event.clientX - (box?.left ?? 0), event.clientY - (box?.top ?? 0))
  }
  /** A menu opened from the keyboard: at the area's top-left corner, kept on the board, in the window. */
  const menuAt = (area: Area | null | undefined) => {
    const box = ref.current?.getBoundingClientRect()
    if (!area || !box) return undefined
    const { x, y } = boardViewRectFromBoard(boardRectFrom(area), drawnCamera())
    return {
      x: box.left + Math.min(Math.max(x, 0), box.width),
      y: box.top + Math.min(Math.max(y, 0), box.height),
    }
  }

  /** The arrow keys' moves land: one change, so one ⌘Z, however long they were held. */
  const commitNudge = () => {
    const held = nudge.current
    nudge.current = null
    if (!held) return
    // Back where they started: nothing lands, and what was drawn ahead of main goes.
    if (!held.dx && !held.dy) {
      setOverrides({})
      return
    }
    gui.boardArrange(
      board.frames
        .filter((frame) => held.ids.includes(frame.id))
        .map((frame) => ({ id: frame.id, x: frame.x + held.dx, y: frame.y + held.dy })),
    )
  }

  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.button === 2) return
    // ⌃-click on a Mac is a right-click: its menu opens, and nothing drags.
    if (MAC && event.ctrlKey && event.button === 0) return
    // Another finger or button while one gesture is going doesn't start a second.
    if (gestureRef.current) return
    const target = event.target as HTMLElement
    // A press on empty board, as a press in the page: the floating chat, not in use, gets out of
    // the way. Not on a frame, a name or a handle: selecting a frame is how a message starts.
    if (!target.closest('[data-frame], [data-frame-label], [data-section], [data-resize]'))
      gui.boardPressed()
    commitNudge()
    ref.current?.focus({ preventScroll: true })
    const at = local(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    if (hand || event.button === 1) {
      setGesture({ kind: 'pan', start: at, from: drawnCamera() })
      return
    }
    const handle = target.closest<HTMLElement>('[data-resize]')?.dataset.resize
    const frameId = target.closest<HTMLElement>('[data-frame]')?.dataset.frame
    const sectionId = target.closest<HTMLElement>('[data-section]')?.dataset.section
    const section = board.sections.find((s) => s.id === sectionId)
    if (section) {
      // Its name picks the section, selecting its frames, and drags them all.
      select(section.frames, section.id)
      setGesture({
        kind: 'move',
        start: at,
        ids: section.frames,
        hit: null,
        narrow: false,
        moved: false,
        toggle: null,
        section: section.id,
      })
      return
    }
    if (handle) {
      const frame = frames.find((f) => f.id === handle)
      if (frame) setGesture({ kind: 'resize', start: at, id: handle, from: frame })
      return
    }
    if (frameId) {
      let ids = board.selection
      let toggle: string | null = null
      if (event.shiftKey) {
        if (selected.has(frameId)) toggle = frameId
        else ids = [...ids, frameId]
      } else if (!selected.has(frameId)) ids = [frameId]
      if (ids !== board.selection) select(ids)
      // Pressing one of several selected frames drags them all; a click selects it alone.
      const narrow = !event.shiftKey && selected.has(frameId) && board.selection.length > 1
      setGesture({ kind: 'move', start: at, ids, hit: frameId, narrow, moved: false, toggle })
      return
    }
    setGesture({ kind: 'marquee', start: at, now: at, add: event.shiftKey ? board.selection : [] })
  }

  const onPointerMove = (event: ReactPointerEvent) => {
    const current = gestureRef.current
    if (!current) return
    // The button came up where the board didn't hear it (a menu took the release): it ends.
    if (event.buttons === 0) {
      finish()
      return
    }
    const at = local(event)
    const { dx, dy } = dragOffset(current.start, at, drawnCamera())
    if (current.kind === 'pan') {
      moveCamera(dragFrom(current.from, current.start, at))
    } else if (current.kind === 'move') {
      const far = Math.hypot(at.x - current.start.x, at.y - current.start.y) > DRAG_SLOP
      if (!current.moved && !far) return
      if (!current.moved) setGesture({ ...current, moved: true })
      const next: Record<string, Override> = {}
      for (const frame of board.frames) {
        if (!current.ids.includes(frame.id)) continue
        next[frame.id] = { x: Math.round(frame.x + dx), y: Math.round(frame.y + dy) }
      }
      setOverrides(next)
    } else if (current.kind === 'resize') {
      const edge = (value: number) => Math.round(Math.min(FRAME_MAX, Math.max(FRAME_MIN, value)))
      setOverrides({
        [current.id]: {
          width: edge(current.from.width + dx),
          height: edge(current.from.height + dy),
        },
      })
    } else {
      setGesture({ ...current, now: at })
    }
  }

  /**
   * The frames a gesture changed from what main has, as they'd land. When it changed none (it
   * ended where it began), what was drawn ahead of main goes now: no new layout will clear it.
   */
  const landed = (ids: string[]) => {
    const changed = board.frames.flatMap((frame) => {
      const override = overrides[frame.id]
      if (!override || !ids.includes(frame.id)) return []
      const next = { ...frame, ...override }
      const same =
        next.x === frame.x &&
        next.y === frame.y &&
        next.width === frame.width &&
        next.height === frame.height
      return same ? [] : [next]
    })
    if (!changed.length) setOverrides({})
    return changed
  }

  /** The gesture ends: what it did lands. Once, however many events say so. */
  const finish = () => {
    const done = gestureRef.current
    if (!done) return
    setGesture(null)
    // Frames the agent added during it come into sight now.
    revealAdded()
    if (done.kind === 'pan') setCamera(liveCamera.current)
    if (done.kind === 'move') {
      if (done.moved) {
        const moved = landed(done.ids)
        if (moved.length) gui.boardArrange(moved.map(({ id, x, y }) => ({ id, x, y })))
      } else if (done.toggle) {
        select(board.selection.filter((id) => id !== done.toggle))
      } else if (done.section) {
        // A second click on its name soon after: rename it.
        const id = `section:${done.section}`
        const now = performance.now()
        const last = lastClick.current
        lastClick.current = { id, at: now }
        if (last?.id === id && now - last.at < DOUBLE_CLICK_MS) {
          lastClick.current = null
          setRenamingSection(done.section)
        }
      } else if (done.hit) {
        // A second click on the same frame soon after: open it, the one clicked.
        const id = done.hit
        if (done.narrow) select([id])
        const now = performance.now()
        const last = lastClick.current
        lastClick.current = { id, at: now }
        if (last?.id === id && now - last.at < DOUBLE_CLICK_MS) {
          lastClick.current = null
          gui.boardOpenFrame(id)
        }
      }
    } else if (done.kind === 'resize') {
      // The size alone: where the frame is stays main's, which the agent may have moved since.
      const [frame] = landed([done.id])
      if (frame) {
        const { id, width, height } = frame
        gui.boardArrange([{ id, width, height }])
      }
    } else if (done.kind === 'marquee') {
      const box = marqueeRect(done.start, done.now)
      if (box.width < DRAG_SLOP && box.height < DRAG_SLOP) {
        if (board.selection.length && !done.add.length) select([])
        return
      }
      const hit = frames
        .filter((frame) => inMarquee(boardRectFrom(frame), box, drawnCamera()))
        .map((frame) => frame.id)
      select([...done.add, ...hit.filter((id) => !done.add.includes(id))])
    }
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (isTyping(event.target)) return
    const command = event.metaKey || event.ctrlKey
    // Keys with ⌘, ⌃ or ⌥ that the board doesn't use go on to the menu (⌘⌫ is Don't Allow).
    const plain = !command && !event.altKey
    const ids = board.selection
    const step = event.shiftKey ? 10 : 1
    const arrows: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }
    let handled = true
    const deleting = plain && (event.key === 'Backspace' || event.key === 'Delete')
    // A section picked by its name goes on its own; its frames stay.
    if (deleting && picked) gui.boardDeleteSection(picked.id)
    else if (deleting && ids.length) gui.boardDelete(ids)
    else if (command && event.altKey && event.code === 'KeyG' && ids.length)
      gui.boardAddSection(ids)
    // ⌘D is Design Mode, as everywhere in Gui (the menu's); ⌥⌘D duplicates.
    else if (command && event.altKey && event.code === 'KeyD' && ids.length) gui.boardDuplicate(ids)
    else if (command && event.shiftKey && event.code === 'KeyE' && ids.length) gui.boardExport(ids)
    else if (command && !event.altKey && !event.shiftKey && event.code === 'KeyA')
      select(board.frames.map((frame) => frame.id))
    else if (command && event.key === '0') fit()
    else if (command && (event.key === '=' || event.key === '+')) zoomCentred(ZOOM_STEP)
    else if (command && event.key === '-') zoomCentred(1 / ZOOM_STEP)
    else if (plain && event.code === 'KeyH') setBoardTool('hand')
    else if (plain && event.code === 'KeyV') setBoardTool('move')
    else if (plain && event.key === 'Enter' && ids.length === 1) gui.boardOpenFrame(ids[0])
    else if (event.key === 'Escape' && ids.length) select([])
    // What a double-click and a right-click do, from the keyboard: on the section picked by
    // its name, or the one frame selected.
    else if (matchesShortcut(event, 'canvasRename') && (picked || ids.length === 1)) {
      if (picked) setRenamingSection(picked.id)
      else setRenaming(ids[0])
    } else if (
      (matchesShortcut(event, 'canvasMenu') || (plain && event.key === 'ContextMenu')) &&
      (picked || ids.length === 1)
    ) {
      if (picked) gui.showSectionMenu(picked.id, menuAt(sectionBounds(picked, frames)))
      else gui.showFrameMenu(ids[0], menuAt(frames.find((frame) => frame.id === ids[0])))
    } else if (plain && event.key === 'Tab' && board.frames.length) {
      // Tab and ⇧Tab step through the sections, each before its first frame, and the frames;
      // past the last, focus leaves the board.
      const listed = new Set<string>()
      const stops = board.frames.flatMap((frame) => {
        const section = board.sections.find((s) => s.frames.includes(frame.id))
        if (!section || listed.has(section.id)) return [{ frame, section: null }]
        listed.add(section.id)
        return [
          { frame: null, section },
          { frame, section: null },
        ]
      })
      const at = stops.findIndex((stop) =>
        picked ? stop.section?.id === picked.id : ids.length === 1 && stop.frame?.id === ids[0],
      )
      const next = stops[event.shiftKey ? (at === -1 ? stops.length - 1 : at - 1) : at + 1]
      const area = next?.section ? sectionBounds(next.section, board.frames) : next?.frame
      if (next?.section) select(next.section.frames, next.section.id)
      else if (next?.frame) select([next.frame.id])
      if (area) reveal(area)
      else handled = false
    } else if (arrows[event.key] && ids.length && !command && !event.altKey) {
      const [dx, dy] = arrows[event.key]
      if (nudge.current && nudge.current.ids.join('\n') !== ids.join('\n')) commitNudge()
      const held = nudge.current ?? { ids, dx: 0, dy: 0 }
      held.dx += dx
      held.dy += dy
      nudge.current = held
      setOverrides(
        Object.fromEntries(
          board.frames
            .filter((frame) => ids.includes(frame.id))
            .map((frame) => [frame.id, { x: frame.x + held.dx, y: frame.y + held.dy }]),
        ),
      )
    } else handled = false
    if (handled) event.preventDefault()
  }

  const grid = GRID * camera.zoom
  const marquee = gesture?.kind === 'marquee' ? marqueeRect(gesture.start, gesture.now) : null
  const single = board.selection.length === 1 ? board.selection[0] : null
  // What's drawn: frames and sections near the view, in board pixels. The margin keeps a pan
  // from adding and dropping them at every step. A name being edited stays, wherever it is.
  const reach = boardRectFromBoardView(
    boardViewRect(
      -size.width / 2,
      -size.height / 2 - LABEL_HEIGHT,
      size.width * 2,
      size.height * 2 + LABEL_HEIGHT,
    ),
    camera,
  )
  const near = (area: Area) =>
    area.x <= reach.x + reach.width &&
    area.y <= reach.y + reach.height &&
    area.x + area.width >= reach.x &&
    area.y + area.height >= reach.y
  const shown = frames.filter((frame) => near(frame) || frame.id === renaming)
  const count = board.frames.length
  const zoom = camera.zoom
  const origin = boardViewFromBoard(boardPoint(0, 0), camera)
  const areas = sections.flatMap((section) => {
    const area = sectionBounds(section, frames)
    return area && (near(area) || section.id === renamingSection) ? [{ section, area }] : []
  })
  const sectionOf = new Map<string, Area>()
  for (const { section, area } of areas) for (const id of section.frames) sectionOf.set(id, area)
  // Zoomed out, a frame's name goes where there's no room for it above the frame: it would
  // cover its section's name, or the frame above it (and take its clicks).
  const nameBand = LABEL_HEIGHT / zoom
  const sectionName = (SECTION_INSET + SECTION_LABEL_HEIGHT) / zoom
  const hasRoom = (frame: BoardFrame) => {
    const top = frame.y - nameBand
    const section = sectionOf.get(frame.id)
    if (section && top < section.y + sectionName) return false
    return !frames.some(
      (other) =>
        other.id !== frame.id &&
        other.x < frame.x + frame.width &&
        frame.x < other.x + other.width &&
        other.y < frame.y &&
        other.y + other.height > top,
    )
  }

  return (
    // The board is one control: it takes the keyboard when pressed, and names what's selected.
    <div
      ref={ref}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: role="application" handles its own keys.
      tabIndex={0}
      role="application"
      aria-label={`Canvas ${board.name}, ${count} ${count === 1 ? 'frame' : 'frames'}. Tab steps through sections and frames; arrows move them; Enter opens one; F2 renames; Shift+F10 shows its menu.`}
      className={cn(
        'absolute inset-0 overflow-hidden bg-canvas outline-none select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-muted',
        hand && (gesture?.kind === 'pan' ? 'cursor-grabbing' : 'cursor-grab'),
      )}
      style={
        gl
          ? undefined
          : {
              backgroundImage:
                grid >= GRID_MIN
                  ? 'radial-gradient(var(--line-strong) 1px, transparent 1px)'
                  : undefined,
              backgroundSize: `${grid}px ${grid}px`,
              backgroundPosition: `${origin.x}px ${origin.y}px`,
            }
      }
      // The canvas lights up the edge of the frame under the pointer, as :hover does a tile's.
      onPointerOver={
        gl
          ? (event) =>
              surface.current?.hover(
                (event.target as HTMLElement).closest<HTMLElement>('[data-frame]')?.dataset.frame ??
                  null,
              )
          : undefined
      }
      onPointerLeave={gl ? () => surface.current?.hover(null) : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onKeyDown={onKeyDown}
      onKeyUp={(event) => {
        if (event.key.startsWith('Arrow')) commitNudge()
      }}
      onBlur={(event) => {
        if (event.target === event.currentTarget) commitNudge()
      }}
      onContextMenu={(event) => {
        const target = event.target as HTMLElement
        const sectionId = target.closest<HTMLElement>('[data-section]')?.dataset.section
        const section = board.sections.find((s) => s.id === sectionId)
        const named = target.closest<HTMLElement>('[data-frame-label]')?.dataset.frameLabel
        const id = target.closest<HTMLElement>('[data-frame]')?.dataset.frame ?? named
        if (section) {
          event.preventDefault()
          // Its menu acts on the section picked, as a click on its name picks it.
          select(section.frames, section.id)
          gui.showSectionMenu(section.id)
        } else if (id) {
          event.preventDefault()
          gui.showFrameMenu(id)
        }
      }}
    >
      {gl && (
        <BoardSurface
          ref={surface}
          camera={drawnCamera}
          thumbs={board.thumbs}
          tiles={layer}
          onUnavailable={() => setUnavailable(true)}
          input={{
            frames,
            sections: sections.flatMap((section) => {
              const area = sectionBounds(section, frames)
              return area ? [{ id: section.id, area, picked: picked?.id === section.id }] : []
            }),
            selected,
            handle: hand ? null : single,
            hand,
            marquee,
          }}
        />
      )}
      {/*
        The board itself, in board pixels: one layer the camera moves and scales, so a pan or
        zoom changes it alone and none of the frames inside. Names and handles in it are drawn
        at screen size (`pinned`); lines are a screen pixel wide (--board-px).
      */}
      <div
        ref={layer}
        className="absolute top-0 left-0 origin-top-left"
        style={
          {
            transform: `translate(${origin.x}px, ${origin.y}px) scale(${zoom})`,
            '--board-px': `${1 / zoom}px`,
            '--board-zoom': zoom,
            '--board-unzoom': 1 / zoom,
          } as CSSProperties
        }
      >
        {!gl &&
          areas.map(({ section, area }) => (
            <div
              key={section.id}
              aria-hidden="true"
              className={cn(
                'pointer-events-none absolute border-solid bg-fill/60',
                picked?.id === section.id ? 'border-accent' : 'border-line',
              )}
              style={{
                left: area.x,
                top: area.y,
                width: area.width,
                height: area.height,
                borderWidth: 'var(--board-px)',
                borderRadius: 'calc(12 * var(--board-px))',
              }}
            />
          ))}

        {shown.map((frame) => (
          <FrameTile
            key={frame.id}
            frame={frame}
            thumbs={board.thumbs}
            small={frame.width * zoom * window.devicePixelRatio <= SMALL_THUMB_WIDTH}
            hoverable={!hand && !selected.has(frame.id)}
            drawn={!gl}
          />
        ))}

        {/* Names after every frame: no frame hides a section's name, or another frame's. */}
        {areas.map(({ section, area }) => (
          <SectionLabel
            key={section.id}
            name={section.name}
            id={section.id}
            x={area.x}
            y={area.y}
            width={area.width}
            picked={picked?.id === section.id}
            hand={hand}
            renaming={renamingSection === section.id}
            onDone={labels.renamedSection}
          />
        ))}
        {shown.map((frame) => {
          const named = hasRoom(frame)
          return (
            <FrameLabel
              key={frame.id}
              frame={frame}
              named={named}
              sized={named && zoom >= SIZE_LABEL_ZOOM && frame.width * zoom >= SIZE_LABEL_MIN}
              selected={selected.has(frame.id)}
              renaming={renaming === frame.id}
              hand={hand}
              onSelect={labels.selectFrame}
              onRename={labels.renameFrame}
              onDone={labels.renamedFrame}
            />
          )
        })}

        {/* What's selected, above everything on the board. */}
        {shown.map((frame) => {
          if (!selected.has(frame.id)) return null
          return (
            <div key={frame.id} aria-hidden="true">
              {!gl && (
                <div
                  className="pointer-events-none absolute outline-solid outline-accent"
                  style={{
                    left: frame.x,
                    top: frame.y,
                    width: frame.width,
                    height: frame.height,
                    outlineWidth: 'calc(2 * var(--board-px))',
                  }}
                />
              )}
              {single === frame.id && !hand && (
                <div
                  data-resize={frame.id}
                  // 10px drawn, 26px to grab: nothing else sits at the corner.
                  className={cn(
                    'cursor-nwse-resize before:absolute before:-inset-2',
                    !gl && 'rounded-sm border-2 border-accent bg-raised',
                  )}
                  style={{
                    ...pinned(
                      { x: frame.x + frame.width, y: frame.y + frame.height },
                      { x: -HANDLE / 2, y: -HANDLE / 2 },
                    ),
                    width: HANDLE,
                    height: HANDLE,
                  }}
                />
              )}
            </div>
          )
        })}
      </div>

      {marquee && !gl && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute border border-accent bg-accent-soft"
          style={{
            left: marquee.x,
            top: marquee.y,
            width: marquee.width,
            height: marquee.height,
          }}
        />
      )}

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {!board.frames.length && <EmptyBoard working={working} />}
    </div>
  )
}

/** What the names on the board do, by the frame's or section's id. */
interface LabelActions {
  selectFrame: (id: string, add: boolean) => void
  renameFrame: (id: string) => void
  renamedFrame: (id: string, name: string | null) => void
  renamedSection: (id: string, name: string | null) => void
}

/**
 * Where something drawn at screen size sits in the board layer: its top-left at board point
 * `at`, then moved by `shift` screen pixels. Undoes the layer's zoom as the camera draws it
 * (--board-unzoom), so neither a pan nor a pinch leaves it behind.
 */
function pinned(
  at: { x: number; y: number },
  shift: { x: number; y: number } = { x: 0, y: 0 },
): CSSProperties {
  return {
    position: 'absolute',
    left: at.x,
    top: at.y,
    transformOrigin: '0 0',
    transform: `scale(var(--board-unzoom)) translate(${shift.x}px, ${shift.y}px)`,
  }
}

/** `pixels` on the board, as screen pixels at the zoom the camera draws. */
const onScreen = (pixels: number) => `calc(${pixels}px * var(--board-zoom))`

/** Redrawn only when something it shows changes: main sends new objects for the same frame. */
function sameFrame(a: BoardFrame, b: BoardFrame) {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.version === b.version &&
    a.captured === b.captured
  )
}

/** A frame's thumbnail on the board, or that it's still being drawn. */
const FrameTile = memo(
  function FrameTile({
    frame,
    thumbs,
    small,
    hoverable,
    drawn,
  }: {
    frame: BoardFrame
    thumbs: string
    /** Drawn no wider on screen than the small thumbnail: that one is as sharp, and far lighter */
    small: boolean
    /** Not selected, and the Hand is off: its edge lights up under the pointer */
    hoverable: boolean
    /** False when the canvas under the board draws it: the tile is then where it's pressed */
    drawn: boolean
  }) {
    return (
      <div
        data-frame={frame.id}
        className={cn(
          'absolute overflow-hidden',
          drawn && 'bg-raised shadow-raised outline-solid outline-line',
          drawn && hoverable && 'hover:outline-accent',
        )}
        style={{
          left: frame.x,
          top: frame.y,
          width: frame.width,
          height: frame.height,
          outlineWidth: 'var(--board-px)',
          outlineOffset: 'calc(-1 * var(--board-px))',
        }}
      >
        {frame.captured ? (
          drawn && (
            <Thumbnail src={`${thumbs}/${frame.id}${small ? '.small' : ''}?v=${frame.version}`} />
          )
        ) : (
          <div
            className="p-3 text-caption whitespace-nowrap text-subtle"
            style={pinned({ x: 0, y: 0 })}
          >
            Rendering…
          </div>
        )}
      </div>
    )
  },
  (a, b) =>
    sameFrame(a.frame, b.frame) &&
    a.thumbs === b.thumbs &&
    a.small === b.small &&
    a.hoverable === b.hoverable &&
    a.drawn === b.drawn,
)

/**
 * A frame's thumbnail, as wide as the frame, from its top: a page taller than its capture
 * leaves the rest of the frame blank rather than stretching. A new one (the small copy or the
 * full one, a new capture) loads over the one shown, which stays until then: an image's
 * `src` changed in place can show nothing for a frame while it loads.
 */
function Thumbnail({ src }: { src: string }) {
  const [shown, setShown] = useState(src)
  const urls = src === shown ? [shown] : [shown, src]
  return urls.map((url) => (
    <img
      key={url}
      src={url}
      alt=""
      draggable={false}
      className={cn(
        'pointer-events-none block h-auto w-full',
        url !== shown && 'absolute top-0 left-0',
      )}
      onLoad={url === shown ? undefined : () => setShown(url)}
      onError={url === shown ? undefined : () => setShown(url)}
    />
  ))
}

/** A frame's name above it, and its size; double-click renames it in place. */
const FrameLabel = memo(
  function FrameLabel({
    frame,
    named,
    sized,
    selected,
    renaming,
    onSelect,
    onRename,
    onDone,
    hand,
  }: {
    frame: BoardFrame
    /** There's room for its name above it (zoomed out, there may not be) */
    named: boolean
    /** And for its size after the name */
    sized: boolean
    selected: boolean
    renaming: boolean
    onSelect: (id: string, add: boolean) => void
    onRename: (id: string) => void
    onDone: (id: string, name: string | null) => void
    /** The Hand is on: a press here pans the board like anywhere else */
    hand: boolean
  }) {
    const style = {
      ...pinned({ x: frame.x, y: frame.y }, { x: 0, y: -LABEL_HEIGHT }),
      height: LABEL_HEIGHT,
      // No wider than the frame: zoomed out, neighbours' names would run into each other.
      maxWidth: `max(${onScreen(frame.width)}, 24px)`,
    }
    const finished = useRef(false)
    const finish = (value: string | null) => {
      if (finished.current) return
      finished.current = true
      onDone(frame.id, value)
    }
    if (renaming)
      return (
        <input
          // biome-ignore lint/a11y/noAutofocus: renaming starts by typing the new name.
          autoFocus
          aria-label="Frame name"
          spellCheck={false}
          defaultValue={frame.name}
          className={`${FIELD_LOOK} px-1 text-caption`}
          style={{ ...style, width: `max(${onScreen(frame.width)}, 160px)` }}
          onFocus={(event) => {
            finished.current = false
            event.currentTarget.select()
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') finish(event.currentTarget.value.trim() || null)
            if (event.key === 'Escape') finish(null)
          }}
          onBlur={(event) => finish(event.currentTarget.value.trim() || null)}
        />
      )
    if (!named) return null
    return (
      <p
        data-frame-label={frame.id}
        className={cn(
          'flex items-center gap-1.5 truncate text-caption whitespace-nowrap',
          selected ? 'text-accent-text' : 'text-muted',
        )}
        style={style}
        // Its own clicks: a press selects the frame (no drag from here), a double-click renames.
        onPointerDown={(event) => {
          if (event.button !== 0 || hand) return
          event.stopPropagation()
          onSelect(frame.id, event.shiftKey)
        }}
        onDoubleClick={hand ? undefined : () => onRename(frame.id)}
      >
        <span className="truncate font-medium" title={frame.name}>
          {frame.name}
        </span>
        {/* Narrow on screen, the name matters more than the size. */}
        {sized && (
          <span className="shrink-0 text-subtle tabular-nums">
            {frame.width} × {frame.height}
          </span>
        )}
      </p>
    )
  },
  ({ frame: a, ...before }, { frame: b, ...after }) =>
    sameFrame(a, b) &&
    before.named === after.named &&
    before.sized === after.sized &&
    before.selected === after.selected &&
    before.renaming === after.renaming &&
    before.hand === after.hand &&
    before.onSelect === after.onSelect &&
    before.onRename === after.onRename &&
    before.onDone === after.onDone,
)

/**
 * A section's name in its top-left corner: press it to pick the section and drag its frames,
 * double-click to rename, right-click for its menu (the board handles all three).
 */
const SectionLabel = memo(function SectionLabel({
  id,
  name,
  x,
  y,
  width,
  picked,
  hand,
  renaming,
  onDone,
}: {
  id: string
  name: string
  /** The section's top-left corner and width, in board pixels */
  x: number
  y: number
  width: number
  picked: boolean
  hand: boolean
  renaming: boolean
  onDone: (id: string, name: string | null) => void
}) {
  /** As wide as the section leaves room for on screen, and never too narrow to read */
  const maxWidth = `max(calc(${onScreen(width)} - ${SECTION_INSET * 2}px), 120px)`
  const style = {
    ...pinned({ x, y }, { x: SECTION_INSET, y: SECTION_INSET }),
    height: SECTION_LABEL_HEIGHT,
    maxWidth,
  }
  const finished = useRef(false)
  const finish = (value: string | null) => {
    if (finished.current) return
    finished.current = true
    onDone(id, value)
  }
  if (renaming)
    return (
      <input
        // biome-ignore lint/a11y/noAutofocus: renaming starts by typing the new name.
        autoFocus
        aria-label="Section name"
        spellCheck={false}
        defaultValue={name}
        className={`${FIELD_LOOK} px-2 text-small font-medium`}
        style={{ ...style, width: `min(${maxWidth}, 240px)` }}
        onFocus={(event) => {
          finished.current = false
          event.currentTarget.select()
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') finish(event.currentTarget.value.trim() || null)
          if (event.key === 'Escape') finish(null)
        }}
        onBlur={(event) => finish(event.currentTarget.value.trim() || null)}
      />
    )
  return (
    <p
      data-section={id}
      className={cn(
        'flex items-center truncate rounded-md px-2 text-small font-medium whitespace-nowrap',
        picked ? 'bg-accent-soft text-accent-text' : 'bg-raised text-fg shadow-raised',
        !hand && 'cursor-default',
      )}
      style={style}
    >
      <span className="truncate" title={name}>
        {name}
      </span>
    </p>
  )
})

/** In place of the board when the canvas it's drawn on can't start. */
function BoardUnavailable() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-canvas p-8">
      <Card padding="canvas" role="alert" className="flex w-full max-w-md flex-col gap-1">
        <h2 className="font-semibold">This canvas can’t be shown</h2>
        <p className="text-pretty text-muted">
          Gui draws canvases with WebGL 2, which isn’t available on this Mac right now. Quitting and
          opening Gui again may bring it back.
        </p>
      </Card>
    </div>
  )
}

/**
 * An empty canvas: what to ask for, rather than a blank void. A starter goes to the chat once:
 * the starters wait while it's sending and while the agent works on it.
 */
function EmptyBoard({ working }: { working: boolean }) {
  const [sending, setSending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Sent, until the agent is seen working on it: the tab's status comes a moment later. If
  // it never does (the message waits for setup), the starters come back after a while.
  const [sent, setSent] = useState(false)
  useEffect(() => {
    if (working) setSent(false)
    if (!sent || working) return
    const timer = setTimeout(() => setSent(false), SENT_WAIT_MS)
    return () => clearTimeout(timer)
  }, [sent, working])
  const busy = working || sent || sending !== null
  const start = async (prompt: string) => {
    if (busy) return
    setSending(prompt)
    setError(null)
    try {
      if (await gui.send(prompt)) setSent(true)
      else setError('Gui couldn’t send that to your agent. Try again, or ask in the chat.')
    } catch (err) {
      setError(readableError(err))
    } finally {
      setSending(null)
    }
  }
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
      <Card
        padding="canvas"
        className="pointer-events-auto flex w-full max-w-md flex-col gap-4"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold">Start your canvas</h2>
          <p className="text-pretty text-muted">Ask for a page or a few versions to compare.</p>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1.5">
            {STARTERS.map((prompt) => (
              <PromptButton
                key={prompt}
                loading={sending === prompt}
                disabled={busy}
                onClick={() => void start(prompt)}
              >
                {prompt}
              </PromptButton>
            ))}
          </div>
          {(working || sent) && (
            <p role="status" className="flex items-center gap-1.5 text-small text-muted">
              <Spinner />
              Your agent is adding frames…
            </p>
          )}
          {error && <InlineError>{error}</InlineError>}
        </div>
      </Card>
    </div>
  )
}

/**
 * The part of the board the floating chat leaves clear, in the board element's pixels: all of
 * it unless the chat covers a good share of its height, and leaves a wide enough side.
 */
async function clearArea(el: HTMLElement, size: Size): Promise<BoardViewRect> {
  const all = boardViewRect(0, 0, size.width, size.height)
  const cover: Rect | null = await gui.boardChatCover().catch(() => null)
  if (!cover) return all
  const box = el.getBoundingClientRect()
  const left = cover.x - box.left
  const right = left + cover.width
  const top = Math.max(0, cover.y - box.top)
  const bottom = Math.min(size.height, cover.y - box.top + cover.height)
  if (right <= 0 || left >= size.width || bottom - top < size.height / 3) return all
  const before = Math.max(0, left)
  const after = Math.max(0, size.width - right)
  if (Math.max(before, after) < CLEAR_MIN_WIDTH) return all
  return after > before
    ? boardViewRect(size.width - after, 0, after, size.height)
    : boardViewRect(0, 0, before, size.height)
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}
