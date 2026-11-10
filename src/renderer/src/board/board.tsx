import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { regroupSections } from '../../../shared/board'
import { boardViewPoint } from '../../../shared/coords'
import type { BoardState } from '../../../shared/types'
import { cn } from '../lib/cn'
import { marqueeRect, menuPoint } from './camera'
import { EmptyBoard } from './empty'
import {
  type Area,
  type Click,
  contextMenu,
  dragGesture,
  endGesture,
  type Gesture,
  type GestureBoard,
  ignoredPress,
  type Override,
  pressGesture,
} from './gestures'
import { sendIntent } from './intents'
import { boardKey, type KeyAction, type Nudge, nudged, nudgeLanding } from './keys'
import { BoardOverlay, gridStyle, tileId, useNaming } from './overlay'
import { activeFrame, sectionAreas, selectionSaid } from './scene'
import { BoardSurface, type BoardSurfaceHandle, BoardUnavailable } from './surface'
import { useBoardCamera } from './use-camera'
import { setBoardTool, useHand } from './view'

/** macOS turns ⌃-click into a right-click: its menu, not a drag. */
const MAC = navigator.platform.toLowerCase().includes('mac')

/**
 * A canvas's frames on a pannable, zoomable board, like Figma's: their thumbnails (main
 * captures them as their pages change), their names above them, and what's selected. Scroll
 * pans, ⌘-scroll or a pinch zooms, Space-drag pans; drag frames to move them, their corner to
 * resize them, across empty board to select several; double-click opens one live, as ⌘D does
 * to pick in it. The shell: it owns the camera and the gesture under way, gives events to
 * gestures.ts and keys.ts and does what they ask, and runs the board's effects.
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
  /** What this board's tiles' element ids start with */
  const tiles = useId()
  const surface = useRef<BoardSurfaceHandle>(null)
  /** WebGL2 couldn't start, so the canvas can't draw the board */
  const [unavailable, setUnavailable] = useState(false)
  const layer = useRef<HTMLDivElement>(null)
  /** The gesture under way, for listeners that run between renders (pointer-up, the wheel) */
  const gestureRef = useRef<Gesture | null>(null)
  const {
    camera,
    live,
    size,
    setCamera,
    moveCamera,
    stopFlight,
    fit,
    zoomCentred,
    reveal,
    revealAdded,
  } = useBoardCamera({
    initial: board.camera,
    boardId: board.id,
    frames: board.frames,
    sections: board.sections,
    gesture: gestureRef,
    board: ref,
    layer,
    surface,
    gl,
  })
  const [overrides, setOverrides] = useState<Record<string, Override>>({})
  const [gesture, setGestureState] = useState<Gesture | null>(null)
  const setGesture = (next: Gesture | null) => {
    if (next) stopFlight()
    gestureRef.current = next
    setGestureState(next)
  }
  /** Arrow keys held: the frames move as drawn, and land as one change when the key comes up */
  const nudge = useRef<Nudge | null>(null)
  /** The section picked by its name, while its frames are what's selected */
  const [pickedSection, setPickedSection] = useState<string | null>(null)
  /**
   * Selects frames. Picking a section by its name selects its frames with it; selecting them
   * any other way (a marquee, ⌘A, a click) selects frames, not the section.
   */
  const select = (ids: string[], section: string | null = null) => {
    setPickedSection(section)
    sendIntent({ type: 'select', ids })
  }
  /** What's selected, said to a screen reader as it changes */
  const [announcement, setAnnouncement] = useState('')
  const hand = useHand(ref)
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
  const lastClick = useRef<Click | null>(null)
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
    if (!picked) setPickedSection(null)
    setAnnouncement(selectionSaid(board.selection, board.frames, picked ?? null))
  }, [selection])

  const { renaming, renamingSection, setRenaming, setRenamingSection, labels } = useNaming(
    board,
    select,
    ref,
  )

  // The board takes the keyboard as it opens (Delete, arrows, H and V work at once), unless
  // something else in the window has it.
  const hasCamera = camera !== null
  useEffect(() => {
    if (hasCamera && document.activeElement === document.body)
      ref.current?.focus({ preventScroll: true })
  }, [hasCamera])

  if (!camera) return <div ref={ref} className="absolute inset-0" />
  if (gl && unavailable) return <BoardUnavailable />

  // The camera as drawn this moment, which `camera` follows a little behind during a pan or pinch.
  const drawnCamera = () => live.current ?? camera
  const local = (event: { clientX: number; clientY: number }) => {
    const box = ref.current?.getBoundingClientRect()
    return boardViewPoint(event.clientX - (box?.left ?? 0), event.clientY - (box?.top ?? 0))
  }
  /** A menu opened from the keyboard: at the area's corner, in the window. */
  const menuAt = (area: Area | null | undefined) => {
    const box = ref.current?.getBoundingClientRect()
    return area && box ? menuPoint(area, drawnCamera(), box) : undefined
  }
  const gestureBoard: GestureBoard = {
    frames: board.frames,
    drawn: frames,
    sections: board.sections,
    selection: board.selection,
  }

  /** The arrow keys' moves land: one change, so one ⌘Z, however long they were held. */
  const commitNudge = () => {
    const held = nudge.current
    nudge.current = null
    if (!held) return
    const moves = nudgeLanding(held, board.frames)
    // Back where they started: nothing lands, and what was drawn ahead of main goes.
    if (moves) sendIntent({ type: 'arrange', frames: moves })
    else setOverrides({})
  }

  const onPointerDown = (event: ReactPointerEvent) => {
    if (ignoredPress(event.button, event.ctrlKey, MAC)) return
    // Another finger or button while one gesture is going doesn't start a second.
    if (gestureRef.current) return
    const target = event.target as HTMLElement
    // A press on empty board, as a press in the page: the floating chat, not in use, gets out of
    // the way. Not on a frame, a name or a handle: selecting a frame is how a message starts.
    if (!target.closest('[data-frame], [data-frame-label], [data-section], [data-resize]'))
      sendIntent({ type: 'pressed' })
    commitNudge()
    ref.current?.focus({ preventScroll: true })
    const at = local(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    const press = {
      at,
      shiftKey: event.shiftKey,
      pan: hand || event.button === 1,
      target: {
        resize: idOf(target, 'resize'),
        frame: idOf(target, 'frame'),
        section: idOf(target, 'section'),
      },
    }
    const started = pressGesture(press, gestureBoard, drawnCamera())
    if (started.select) select(started.select.ids, started.select.section)
    if (started.gesture) setGesture(started.gesture)
  }

  const onPointerMove = (event: ReactPointerEvent) => {
    const current = gestureRef.current
    if (!current) return
    // The button came up where the board didn't hear it (a menu took the release): it ends.
    if (event.buttons === 0) {
      finish()
      return
    }
    const drag = dragGesture(current, local(event), drawnCamera(), board.frames)
    if (drag.camera) moveCamera(drag.camera)
    if (drag.gesture) setGesture(drag.gesture)
    if (drag.overrides) setOverrides(drag.overrides)
  }

  /** The gesture ends: what it did lands. Once, however many events say so. */
  const finish = () => {
    const done = gestureRef.current
    if (!done) return
    setGesture(null)
    // Frames the agent added during it come into sight now.
    revealAdded()
    const now = performance.now()
    const end = endGesture(done, gestureBoard, overrides, drawnCamera(), lastClick.current, now)
    if (end.rest) setCamera(live.current)
    if (end.clear) setOverrides({})
    if (end.click !== undefined) lastClick.current = end.click
    if (end.select) select(end.select.ids, end.select.section)
    for (const intent of end.intents) sendIntent(intent)
    if (end.renameSection) setRenamingSection(end.renameSection)
  }

  /** Does what a key asks; false when it came to nothing, and the key goes on. */
  const act = (action: KeyAction) => {
    if (action.type === 'pick') select(action.ids, action.section)
    else if (action.type === 'fit') fit()
    else if (action.type === 'zoom') zoomCentred(action.factor)
    else if (action.type === 'tool') setBoardTool(action.tool)
    else if (action.type === 'nameFrame') setRenaming(action.id)
    else if (action.type === 'nameSection') setRenamingSection(action.id)
    else if (action.type === 'menu') {
      const type = action.of === 'frame' ? 'frameMenu' : 'sectionMenu'
      sendIntent({ type, id: action.id, at: menuAt(action.area) })
    } else if (action.type === 'step') {
      select(action.ids, action.section)
      if (!action.reveal) return false
      reveal(action.reveal)
    } else if (action.type === 'nudge') {
      const next = nudged(nudge.current, action, board.frames)
      if (next.land) commitNudge()
      nudge.current = next.nudge
      setOverrides(next.overrides)
    } else sendIntent(action)
    return true
  }
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (isTyping(event.target)) return
    const action = boardKey(event, {
      frames: board.frames,
      drawn: frames,
      sections: board.sections,
      selection: board.selection,
      picked,
    })
    if (action && act(action)) event.preventDefault()
  }

  const marquee = gesture?.kind === 'marquee' ? marqueeRect(gesture.start, gesture.now) : null
  const single = board.selection.length === 1 ? board.selection[0] : null
  const count = board.frames.length
  /** The frame a screen reader is on: the one last selected */
  const active = activeFrame(board.selection, board.frames, !!picked)

  return (
    // The board is one control: it takes the keyboard when pressed, and names what's selected.
    <div
      ref={ref}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: role="application" handles its own keys.
      tabIndex={0}
      role="application"
      aria-label={`Canvas ${board.name}, ${count} ${count === 1 ? 'frame' : 'frames'}. Tab steps through sections and frames; arrows move them; Enter opens one; F2 renames; Shift+F10 shows its menu.`}
      aria-activedescendant={active ? tileId(tiles, active) : undefined}
      className={cn(
        'absolute inset-0 overflow-hidden bg-canvas outline-none select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-muted',
        hand && (gesture?.kind === 'pan' ? 'cursor-grabbing' : 'cursor-grab'),
      )}
      style={gl ? undefined : gridStyle(camera)}
      // The canvas lights up the edge of the frame under the pointer, as :hover does a tile's.
      onPointerOver={
        gl ? (event) => surface.current?.hover(idOf(event.target, 'frame') ?? null) : undefined
      }
      onPointerLeave={gl ? () => surface.current?.hover(null) : undefined}
      // A click with no pointer behind it (a screen reader's) selects the frame it's on.
      onClick={(event) => {
        const id = event.detail === 0 && idOf(event.target, 'frame')
        if (!id) return
        ref.current?.focus({ preventScroll: true })
        select([id])
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
        const target = {
          section: idOf(event.target, 'section'),
          frame: idOf(event.target, 'frame'),
        }
        const menu = contextMenu(target, idOf(event.target, 'frameLabel'), board.sections)
        if (!menu) return
        event.preventDefault()
        if (menu.select) select(menu.select.ids, menu.select.section)
        sendIntent(menu.intent)
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
            sections: sectionAreas(sections, frames, picked?.id ?? null),
            selected,
            handle: hand ? null : single,
            hand,
            marquee,
          }}
        />
      )}
      <BoardOverlay
        layer={layer}
        camera={camera}
        size={size}
        gl={gl}
        hand={hand}
        frames={frames}
        sections={sections}
        selected={selected}
        single={single}
        picked={picked}
        renaming={renaming}
        renamingSection={renamingSection}
        active={active}
        tiles={tiles}
        thumbs={board.thumbs}
        labels={labels}
        marquee={marquee}
        announcement={announcement}
      />
      {!board.frames.length && <EmptyBoard working={working} />}
    </div>
  )
}

/** The id the nearest element from `target` up carries as `data-<key>`, if any. */
function idOf(target: EventTarget, key: 'frame' | 'frameLabel' | 'section' | 'resize') {
  const attribute = key === 'frameLabel' ? 'frame-label' : key
  return (target as HTMLElement).closest<HTMLElement>(`[data-${attribute}]`)?.dataset[key]
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}
