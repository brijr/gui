import {
  type CSSProperties,
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
  clampZoom,
  FRAME_MAX,
  FRAME_MIN,
  fitCamera,
  regroupSections,
  sectionBounds,
} from '../../../shared/board'
import { matchesShortcut } from '../../../shared/shortcuts'
import type { BoardFrame, BoardState, Rect } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { readableError } from '../lib/errors'
import { FIELD_LOOK, InlineError } from '../lib/field'
import { Card, GroupLabel } from '../lib/surface'
import { PromptButton, Spinner } from '../lib/ui'

/** The frame label's height above a frame, in screen pixels. */
const LABEL_HEIGHT = 22
/** The dot grid's spacing at 100%, in board pixels. */
const GRID = 24
/** A press that moves less than this (screen pixels) is a click, not a drag. */
const DRAG_SLOP = 3
/** A section's name sits this far inside its top-left corner, in screen pixels. */
const SECTION_INSET = 10
/** A frame narrower than this on screen shows its name above it without its size. */
const SIZE_LABEL_MIN = 140
/** The resize handle's size, in screen pixels. */
const HANDLE = 10
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
  'A landing page for a neighborhood coffee roaster',
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

/** A frame moved or resized on the board before main has it, as it's drawn meanwhile. */
type Override = Pick<BoardFrame, 'x' | 'y' | 'width' | 'height'>

type Gesture =
  | {
      kind: 'move'
      start: { x: number; y: number }
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
  | { kind: 'resize'; start: { x: number; y: number }; id: string; from: Override }
  | { kind: 'pan'; start: { x: number; y: number }; from: BoardCamera }
  | {
      kind: 'marquee'
      start: { x: number; y: number }
      now: { x: number; y: number }
      add: string[]
    }

/**
 * A canvas's frames on a pannable, zoomable board, like Figma's: their thumbnails (main
 * captures them as their pages change), their names above them, and what's selected. Scroll
 * pans, ⌘-scroll or a pinch zooms, Space-drag pans; drag frames to move them, their corner to
 * resize them, across empty board to select several; double-click opens one live, as ⌘D does
 * to pick in it.
 */
export function Board({ board, working = false }: { board: BoardState; working?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  const [camera, setCamera] = useState<BoardCamera | null>(board.camera)
  const [overrides, setOverrides] = useState<Record<string, Override>>({})
  const [gesture, setGestureState] = useState<Gesture | null>(null)
  /** The gesture under way, for listeners that run between renders (pointer-up, the wheel) */
  const gestureRef = useRef<Gesture | null>(null)
  const setGesture = (next: Gesture | null) => {
    gestureRef.current = next
    setGestureState(next)
  }
  /** Arrow keys held: the frames move as drawn, and land as one change when the key comes up */
  const nudge = useRef<{ ids: string[]; dx: number; dy: number } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renamingSection, setRenamingSection] = useState<string | null>(null)
  /** The section picked by its name, while its frames are what's selected */
  const [pickedSection, setPickedSection] = useState<string | null>(null)
  const [space, setSpace] = useState(false)
  /** What's selected, said to a screen reader as it changes */
  const [announcement, setAnnouncement] = useState('')
  // Space held is the Hand for as long as it's held.
  const hand = useBoardTool() === 'hand' || space
  const frames = board.frames.map((frame) => ({ ...frame, ...overrides[frame.id] }))
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

  // The latest of what the board's listeners read, without subscribing them again each render.
  const latest = useRef({ frames: board.frames, sections: board.sections, camera, size })
  latest.current = { frames: board.frames, sections: board.sections, camera, size }
  // Everything in sight, around the floating chat when it covers part of the board.
  const fit = () => {
    const el = ref.current
    if (!el) return
    void clearArea(el, latest.current.size).then((area) => {
      const { frames, sections } = latest.current
      const areas = sections.flatMap((section) => sectionBounds(section, frames) ?? [])
      setCamera(fitCameraIn(boardBounds([...frames, ...areas]), area))
    })
  }
  const zoomAt = (factor: number, at: { x: number; y: number }) =>
    setCamera((current) => {
      if (!current) return current
      const zoom = clampZoom(current.zoom * factor)
      // The board point under `at` stays under it.
      return {
        zoom,
        x: current.x + at.x / current.zoom - at.x / zoom,
        y: current.y + at.y / current.zoom - at.y / zoom,
      }
    })
  /** Brings a frame into sight, at the zoom there is, unless most of it shows already. */
  const reveal = (frame: Override) => {
    const { camera, size } = latest.current
    if (!camera) return
    if (shownShare(boardToScreen(frame, camera), { left: 0, top: 0, ...size }) >= 0.5) return
    setCamera({
      ...camera,
      x: frame.x + frame.width / 2 - size.width / 2 / camera.zoom,
      y: frame.y + frame.height / 2 - size.height / 2 / camera.zoom,
    })
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
  // it, or under the floating chat.
  const known = useRef(new Set(board.frames.map((frame) => frame.id)))
  // biome-ignore lint/correctness/useExhaustiveDependencies: the layout is the trigger; the rest is read as it is.
  useEffect(() => {
    const { frames, camera, size } = latest.current
    const added = frames.filter((frame) => !known.current.has(frame.id))
    known.current = new Set(frames.map((frame) => frame.id))
    const el = ref.current
    if (!added.length || !el || !camera || !size.width) return
    void clearArea(el, size).then((area) => {
      const camera = latest.current.camera
      if (!camera) return
      const inSight = added.some((frame) => shownShare(boardToScreen(frame, camera), area) >= 0.5)
      const bounds = boardBounds(added)
      if (inSight || !bounds) return
      setCamera({
        ...camera,
        x: bounds.x + bounds.width / 2 - (area.left + area.width / 2) / camera.zoom,
        y: bounds.y + bounds.height / 2 - (area.top + area.height / 2) / camera.zoom,
      })
    })
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
      if (unsaved.current) gui.boardCamera(unsaved.current, board.id)
    },
    [],
  )

  // The toolbar's zoom controls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: zoomAt and fit read the latest state themselves.
  useEffect(() => {
    publishView({
      camera,
      zoomBy: (factor) => {
        const { size } = latest.current
        zoomAt(factor, { x: size.width / 2, y: size.height / 2 })
      },
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
        else if (command.type === 'zoom') {
          const { size } = latest.current
          zoomAt(command.step === 1 ? ZOOM_STEP : 1 / ZOOM_STEP, {
            x: size.width / 2,
            y: size.height / 2,
          })
        }
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
      const at = { x: event.clientX - box.left, y: event.clientY - box.top }
      if (event.ctrlKey || event.metaKey) {
        // A mouse wheel with ⌃ held turns in big notches: each is one step, as ⌘+ is.
        const delta = event.ctrlKey
          ? Math.max(-PINCH_DELTA_MAX, Math.min(PINCH_DELTA_MAX, event.deltaY))
          : event.deltaY
        zoomAt(Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.002)), at)
        return
      }
      setCamera((current) =>
        current
          ? {
              ...current,
              x: current.x + event.deltaX / current.zoom,
              y: current.y + event.deltaY / current.zoom,
            }
          : current,
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

  if (!camera) return <div ref={ref} className="absolute inset-0" />

  const toScreen = (frame: Override) => boardToScreen(frame, camera)
  const local = (event: { clientX: number; clientY: number }) => {
    const box = ref.current?.getBoundingClientRect()
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) }
  }

  /** The arrow keys' moves land: one change, so one ⌘Z, however long they were held. */
  const commitNudge = () => {
    const held = nudge.current
    nudge.current = null
    if (!held || (!held.dx && !held.dy)) return
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
    commitNudge()
    ref.current?.focus({ preventScroll: true })
    const at = local(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    if (hand || event.button === 1) {
      setGesture({ kind: 'pan', start: at, from: camera })
      return
    }
    const target = event.target as HTMLElement
    const handle = target.closest<HTMLElement>('[data-resize]')?.dataset.resize
    const frameId = target.closest<HTMLElement>('[data-frame]')?.dataset.frame
    const sectionId = target.closest<HTMLElement>('[data-section]')?.dataset.section
    const section = board.sections.find((s) => s.id === sectionId)
    if (section) {
      // Its name picks the section, selecting its frames, and drags them all.
      setPickedSection(section.id)
      gui.boardSelect(section.frames)
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
      if (ids !== board.selection) gui.boardSelect(ids)
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
    const dx = (at.x - current.start.x) / camera.zoom
    const dy = (at.y - current.start.y) / camera.zoom
    if (current.kind === 'pan') {
      setCamera({ ...current.from, x: current.from.x - dx, y: current.from.y - dy })
    } else if (current.kind === 'move') {
      const far = Math.hypot(at.x - current.start.x, at.y - current.start.y) > DRAG_SLOP
      if (!current.moved && !far) return
      if (!current.moved) setGesture({ ...current, moved: true })
      const next: Record<string, Override> = {}
      for (const frame of board.frames) {
        if (!current.ids.includes(frame.id)) continue
        next[frame.id] = { ...frame, x: Math.round(frame.x + dx), y: Math.round(frame.y + dy) }
      }
      setOverrides(next)
    } else if (current.kind === 'resize') {
      const edge = (value: number) => Math.round(Math.min(FRAME_MAX, Math.max(FRAME_MIN, value)))
      setOverrides({
        [current.id]: {
          ...current.from,
          width: edge(current.from.width + dx),
          height: edge(current.from.height + dy),
        },
      })
    } else {
      setGesture({ ...current, now: at })
    }
  }

  /** The gesture ends: what it did lands. Once, however many events say so. */
  const finish = () => {
    const done = gestureRef.current
    if (!done) return
    setGesture(null)
    if (done.kind === 'move') {
      if (done.moved) {
        gui.boardArrange(
          done.ids.flatMap((id) => {
            const frame = overrides[id]
            return frame ? [{ id, x: frame.x, y: frame.y }] : []
          }),
        )
      } else if (done.toggle) {
        gui.boardSelect(board.selection.filter((id) => id !== done.toggle))
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
        if (done.narrow) gui.boardSelect([id])
        const now = performance.now()
        const last = lastClick.current
        lastClick.current = { id, at: now }
        if (last?.id === id && now - last.at < DOUBLE_CLICK_MS) {
          lastClick.current = null
          gui.boardOpenFrame(id)
        }
      }
    } else if (done.kind === 'resize') {
      const frame = overrides[done.id]
      if (frame) gui.boardArrange([{ id: done.id, ...frame }])
    } else if (done.kind === 'marquee') {
      const box = marqueeBox(done.start, done.now)
      if (box.width < DRAG_SLOP && box.height < DRAG_SLOP) {
        if (board.selection.length && !done.add.length) gui.boardSelect([])
        return
      }
      const hit = frames
        .filter((frame) => intersects(toScreen(frame), box))
        .map((frame) => frame.id)
      gui.boardSelect([...done.add, ...hit.filter((id) => !done.add.includes(id))])
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
    // ⌘D is Select Element, as everywhere in Gui (the menu's); ⌥⌘D duplicates.
    else if (command && event.altKey && event.code === 'KeyD' && ids.length) gui.boardDuplicate(ids)
    else if (command && event.shiftKey && event.code === 'KeyE' && ids.length) gui.boardExport(ids)
    else if (command && !event.altKey && !event.shiftKey && event.code === 'KeyA')
      gui.boardSelect(board.frames.map((frame) => frame.id))
    else if (command && event.key === '0') fit()
    else if (command && (event.key === '=' || event.key === '+'))
      zoomAt(ZOOM_STEP, { x: size.width / 2, y: size.height / 2 })
    else if (command && event.key === '-')
      zoomAt(1 / ZOOM_STEP, { x: size.width / 2, y: size.height / 2 })
    else if (plain && event.code === 'KeyH') setBoardTool('hand')
    else if (plain && event.code === 'KeyV') setBoardTool('move')
    else if (plain && event.key === 'Enter' && ids.length === 1) gui.boardOpenFrame(ids[0])
    else if (event.key === 'Escape' && ids.length) gui.boardSelect([])
    // What a double-click and a right-click do, from the keyboard: on the section picked by
    // its name, or the one frame selected.
    else if (matchesShortcut(event, 'canvasRename') && (picked || ids.length === 1)) {
      if (picked) setRenamingSection(picked.id)
      else setRenaming(ids[0])
    } else if (
      (matchesShortcut(event, 'canvasMenu') || (plain && event.key === 'ContextMenu')) &&
      (picked || ids.length === 1)
    ) {
      if (picked) gui.showSectionMenu(picked.id)
      else gui.showFrameMenu(ids[0])
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
      if (next?.section) {
        setPickedSection(next.section.id)
        gui.boardSelect(next.section.frames)
      } else if (next?.frame) gui.boardSelect([next.frame.id])
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
            .map((frame) => [frame.id, { ...frame, x: frame.x + held.dx, y: frame.y + held.dy }]),
        ),
      )
    } else handled = false
    if (handled) event.preventDefault()
  }

  const grid = GRID * camera.zoom
  const marquee = gesture?.kind === 'marquee' ? marqueeBox(gesture.start, gesture.now) : null
  const single = board.selection.length === 1 ? board.selection[0] : null
  // What's drawn: frames and sections near the view, in board pixels. The margin keeps a pan
  // from adding and dropping them at every step.
  const reach = {
    x: camera.x - size.width / camera.zoom / 2,
    y: camera.y - size.height / camera.zoom / 2 - LABEL_HEIGHT / camera.zoom,
    width: (size.width / camera.zoom) * 2,
    height: (size.height / camera.zoom) * 2 + LABEL_HEIGHT / camera.zoom,
  }
  const near = (area: Override) =>
    area.x <= reach.x + reach.width &&
    area.y <= reach.y + reach.height &&
    area.x + area.width >= reach.x &&
    area.y + area.height >= reach.y
  const shown = frames.filter(near)
  const count = board.frames.length
  const zoom = camera.zoom

  return (
    // The board is one control: it takes the keyboard when pressed, and names what's selected.
    <div
      ref={ref}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: role="application" handles its own keys.
      tabIndex={0}
      role="application"
      aria-label={`Canvas ${board.name}, ${count} ${count === 1 ? 'frame' : 'frames'}. Tab steps through sections and frames; arrows move them; Enter opens one; F2 renames; Shift+F10 shows its menu.`}
      className={cn(
        'absolute inset-0 overflow-hidden bg-canvas outline-none select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
        hand && (gesture?.kind === 'pan' ? 'cursor-grabbing' : 'cursor-grab'),
      )}
      style={{
        backgroundImage:
          grid >= 8 ? 'radial-gradient(var(--line-strong) 1px, transparent 1px)' : undefined,
        backgroundSize: `${grid}px ${grid}px`,
        backgroundPosition: `${-camera.x * camera.zoom}px ${-camera.y * camera.zoom}px`,
      }}
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
        const section = target.closest<HTMLElement>('[data-section]')?.dataset.section
        const named = target.closest<HTMLElement>('[data-frame-label]')?.dataset.frameLabel
        const id = target.closest<HTMLElement>('[data-frame]')?.dataset.frame ?? named
        if (section) {
          event.preventDefault()
          setPickedSection(section)
          gui.showSectionMenu(section)
        } else if (id) {
          event.preventDefault()
          gui.showFrameMenu(id)
        }
      }}
    >
      {/*
        The board itself, in board pixels: one layer the camera moves and scales, so a pan or
        zoom changes it alone and none of the frames inside. Names in it are drawn at screen
        size (`pinned`); lines are a screen pixel wide (--board-px).
      */}
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={
          {
            transform: `translate(${-camera.x * zoom}px, ${-camera.y * zoom}px) scale(${zoom})`,
            '--board-px': `${1 / zoom}px`,
          } as CSSProperties
        }
      >
        {sections.map((section) => {
          const area = sectionBounds(section, frames)
          if (!area || !near(area)) return null
          return (
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
          )
        })}

        {shown.map((frame) => (
          <div
            key={frame.id}
            data-frame={frame.id}
            className={cn(
              'absolute overflow-hidden bg-raised shadow-raised outline-solid outline-line',
              !hand && !selected.has(frame.id) && 'hover:outline-accent',
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
              // As wide as the frame, from its top: a page taller than its capture leaves the
              // rest of the frame blank rather than stretching.
              <img
                src={`${board.thumbs}/${frame.id}?v=${frame.version}`}
                alt=""
                draggable={false}
                className="pointer-events-none block h-auto w-full"
              />
            ) : (
              <div
                className="p-3 text-caption whitespace-nowrap text-subtle"
                style={pinned({ x: 0, y: 0 }, zoom)}
              >
                Rendering…
              </div>
            )}
          </div>
        ))}

        {/* Names after every frame: no frame hides a section's name, or another frame's. */}
        {sections.map((section) => {
          const area = sectionBounds(section, frames)
          if (!area || !near(area)) return null
          return (
            <SectionLabel
              key={section.id}
              name={section.name}
              id={section.id}
              at={{ x: area.x, y: area.y }}
              zoom={zoom}
              maxWidth={Math.max(area.width * zoom - SECTION_INSET * 2, 120)}
              picked={picked?.id === section.id}
              hand={hand}
              renaming={renamingSection === section.id}
              onDone={(name) => {
                setRenamingSection(null)
                if (name && name !== section.name) gui.boardRenameSection(section.id, name)
              }}
            />
          )
        })}
        {shown.map((frame) => {
          const isSelected = selected.has(frame.id)
          return (
            <FrameLabel
              key={frame.id}
              frame={frame}
              zoom={zoom}
              selected={isSelected}
              renaming={renaming === frame.id}
              hand={hand}
              onSelect={(add) => {
                if (!add) gui.boardSelect([frame.id])
                else if (!isSelected) gui.boardSelect([...board.selection, frame.id])
              }}
              onRename={() => setRenaming(frame.id)}
              onDone={(name) => {
                setRenaming(null)
                if (name && name !== frame.name) gui.boardRenameFrame(frame.id, name)
              }}
            />
          )
        })}
      </div>

      {/* What's selected, above everything on the board, in screen pixels. */}
      {shown.map((frame) => {
        if (!selected.has(frame.id)) return null
        const box = toScreen(frame)
        return (
          <div key={frame.id} aria-hidden="true">
            <div className="pointer-events-none absolute outline-2 outline-accent" style={box} />
            {single === frame.id && !hand && (
              <div
                data-resize={frame.id}
                className="absolute cursor-nwse-resize rounded-sm border-2 border-accent bg-raised"
                style={{
                  left: box.left + box.width - HANDLE / 2,
                  top: box.top + box.height - HANDLE / 2,
                  width: HANDLE,
                  height: HANDLE,
                }}
              />
            )}
          </div>
        )
      })}

      {marquee && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute border border-accent bg-accent-soft"
          style={{
            left: marquee.left,
            top: marquee.top,
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

/**
 * Where something drawn at screen size sits in the board layer: its top-left at board point
 * `at`, then moved by `shift` screen pixels. Undoes the layer's zoom, so a pan never changes it.
 */
function pinned(
  at: { x: number; y: number },
  zoom: number,
  shift: { x: number; y: number } = { x: 0, y: 0 },
): CSSProperties {
  return {
    position: 'absolute',
    left: at.x,
    top: at.y,
    transformOrigin: '0 0',
    transform: `scale(${1 / zoom}) translate(${shift.x}px, ${shift.y}px)`,
  }
}

/** A frame's name above it, and its size; double-click renames it in place. */
function FrameLabel({
  frame,
  zoom,
  selected,
  renaming,
  onSelect,
  onRename,
  onDone,
  hand,
}: {
  frame: BoardFrame
  zoom: number
  selected: boolean
  renaming: boolean
  onSelect: (add: boolean) => void
  onRename: () => void
  onDone: (name: string | null) => void
  /** The Hand is on: a press here pans the board like anywhere else */
  hand: boolean
}) {
  const width = frame.width * zoom
  const style = {
    ...pinned({ x: frame.x, y: frame.y }, zoom, { x: 0, y: -LABEL_HEIGHT }),
    height: LABEL_HEIGHT,
    // No wider than the frame: zoomed out, neighbours' names would run into each other.
    maxWidth: Math.max(width, 24),
  }
  if (renaming)
    return (
      <input
        // biome-ignore lint/a11y/noAutofocus: renaming starts by typing the new name.
        autoFocus
        aria-label="Frame name"
        defaultValue={frame.name}
        className={`${FIELD_LOOK} px-1 text-caption`}
        style={{ ...style, width: Math.max(width, 160) }}
        onFocus={(event) => event.currentTarget.select()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') onDone(event.currentTarget.value.trim() || null)
          if (event.key === 'Escape') onDone(null)
        }}
        onBlur={(event) => onDone(event.currentTarget.value.trim() || null)}
      />
    )
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
        onSelect(event.shiftKey)
      }}
      onDoubleClick={hand ? undefined : onRename}
    >
      <span className="truncate font-medium">{frame.name}</span>
      {/* Narrow on screen, the name matters more than the size. */}
      {width >= SIZE_LABEL_MIN && (
        <span className="shrink-0 text-subtle tabular-nums">
          {frame.width} × {frame.height}
        </span>
      )}
    </p>
  )
}

/**
 * A section's name in its top-left corner: press it to pick the section and drag its frames,
 * double-click to rename, right-click for its menu (the board handles all three).
 */
function SectionLabel({
  id,
  name,
  at,
  zoom,
  maxWidth,
  picked,
  hand,
  renaming,
  onDone,
}: {
  id: string
  name: string
  /** The section's top-left corner, in board pixels */
  at: { x: number; y: number }
  zoom: number
  /** In screen pixels */
  maxWidth: number
  picked: boolean
  hand: boolean
  renaming: boolean
  onDone: (name: string | null) => void
}) {
  const style = {
    ...pinned(at, zoom, { x: SECTION_INSET, y: SECTION_INSET }),
    height: LABEL_HEIGHT + 2,
    maxWidth,
  }
  if (renaming)
    return (
      <input
        // biome-ignore lint/a11y/noAutofocus: renaming starts by typing the new name.
        autoFocus
        aria-label="Section name"
        defaultValue={name}
        className={`${FIELD_LOOK} px-2 text-small font-medium`}
        style={{ ...style, width: Math.min(maxWidth, 240) }}
        onFocus={(event) => event.currentTarget.select()}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') onDone(event.currentTarget.value.trim() || null)
          if (event.key === 'Escape') onDone(null)
        }}
        onBlur={(event) => onDone(event.currentTarget.value.trim() || null)}
      />
    )
  return (
    <p
      data-section={id}
      className={cn(
        'flex items-center truncate rounded-md px-2 text-small font-medium whitespace-nowrap',
        picked ? 'bg-accent text-accent-fg' : 'bg-raised text-fg shadow-raised',
        !hand && 'cursor-default',
      )}
      style={style}
    >
      <span className="truncate">{name}</span>
    </p>
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
      else setError("Gui couldn't send that to your agent. Try again, or ask in the chat.")
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
          <p className="text-pretty text-muted">
            Ask your agent for a page or a few versions of one. Each lands here as a frame you can
            move, compare and open.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <GroupLabel>Try</GroupLabel>
          <div className="flex flex-col items-start gap-1.5">
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
              Your agent is on it. Frames land here as it makes them.
            </p>
          )}
          {error && <InlineError>{error}</InlineError>}
        </div>
      </Card>
    </div>
  )
}

/** A board area (a frame, a section) in the board element's own pixels. */
interface ScreenBox {
  left: number
  top: number
  width: number
  height: number
}

/** Board pixels to the board element's: where the camera looks, at its zoom. */
function boardToScreen(area: Override, camera: BoardCamera): ScreenBox {
  return {
    left: (area.x - camera.x) * camera.zoom,
    top: (area.y - camera.y) * camera.zoom,
    width: area.width * camera.zoom,
    height: area.height * camera.zoom,
  }
}

/** How much of `box` shows in `area`: 1 when all of it does, or when it fills the area. */
function shownShare(box: ScreenBox, area: ScreenBox) {
  const width =
    Math.min(box.left + box.width, area.left + area.width) - Math.max(box.left, area.left)
  const height =
    Math.min(box.top + box.height, area.top + area.height) - Math.max(box.top, area.top)
  if (width <= 0 || height <= 0) return 0
  const whole = Math.min(box.width * box.height, area.width * area.height)
  return whole > 0 ? (width * height) / whole : 0
}

/**
 * The part of the board the floating chat leaves clear, in the board element's pixels: all of
 * it unless the chat covers a good share of its height, and leaves a wide enough side.
 */
async function clearArea(el: HTMLElement, size: Size): Promise<ScreenBox> {
  const all = { left: 0, top: 0, width: size.width, height: size.height }
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
    ? { left: size.width - after, top: 0, width: after, height: size.height }
    : { left: 0, top: 0, width: before, height: size.height }
}

/** fitCamera, within `area` of the board element rather than all of it. */
function fitCameraIn(bounds: ReturnType<typeof boardBounds>, area: ScreenBox): BoardCamera {
  const camera = fitCamera(bounds, area)
  return { ...camera, x: camera.x - area.left / camera.zoom, y: camera.y - area.top / camera.zoom }
}

function marqueeBox(a: { x: number; y: number }, b: { x: number; y: number }) {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  }
}

function intersects(
  a: { left: number; top: number; width: number; height: number },
  b: { left: number; top: number; width: number; height: number },
) {
  return (
    a.left < b.left + b.width &&
    b.left < a.left + a.width &&
    a.top < b.top + b.height &&
    b.top < a.top + a.height
  )
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}
