import { type BoardCamera, type BoardSection, FRAME_MAX, FRAME_MIN } from '../../../shared/board'
import { type BoardViewPoint, boardRectFrom } from '../../../shared/coords'
import type { BoardFrame } from '../../../shared/types'
import { dragFrom, dragOffset, inMarquee, marqueeRect, zoomAbout, zoomToBox } from './camera'
import type { BoardIntent } from './intents'
import { ZOOM_STEP } from './keys'

/*
 * What the pointer does on the board, as plain functions: a press starts a gesture (or none),
 * each move says what it changes, and the release says what lands. The board reads what is
 * under the pointer from its DOM (`PressTarget`) and does what these return, in that order.
 */

/** A press that moves less than this (board-view pixels) is a click, not a drag. */
export const DRAG_SLOP = 3
/** Two clicks on a frame this close together open it. */
export const DOUBLE_CLICK_MS = 400

/** Where a frame (or a section) is on the board, in board pixels. */
export type Area = Pick<BoardFrame, 'x' | 'y' | 'width' | 'height'>
/**
 * A frame moved or resized on the board before main has it, as it's drawn meanwhile: only what
 * the gesture changes, so its name and thumbnail stay main's.
 */
export type Override = Partial<Area>

export type Gesture =
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
  /** The Zoom tool (Z held): a click zooms a step about it (out with ⌥), a drag to its box */
  | { kind: 'zoom'; start: BoardViewPoint; now: BoardViewPoint; out: boolean }

/** The board as a gesture reads it. */
export interface GestureBoard {
  /** Main's frames */
  frames: readonly BoardFrame[]
  /** The frames as drawn this moment: main's, with what a gesture or a nudge drew ahead of it */
  drawn: readonly BoardFrame[]
  sections: readonly BoardSection[]
  selection: string[]
}

/** What a press landed on: the board's elements under the pointer, by their ids. */
export interface PressTarget {
  /** A frame's resize handle */
  resize?: string
  frame?: string
  /** A section's name */
  section?: string
}

export interface Press {
  at: BoardViewPoint
  shiftKey: boolean
  /** The Hand is on, Space is held, or it's the middle button: the drag pans */
  pan: boolean
  /** Z is held, and not Space: the Zoom tool */
  zoom: boolean
  altKey: boolean
  target: PressTarget
}

/** A selection a gesture makes; `section` when it's a section picked by its name. */
export interface Selecting {
  ids: string[]
  section: string | null
}

/**
 * Whether a press starts nothing: a right-click, or a ⌃-click on a Mac, which is a right-click
 * there (its menu opens, and nothing drags).
 */
export function ignoredPress(button: number, ctrlKey: boolean, mac: boolean) {
  return button === 2 || (mac && ctrlKey && button === 0)
}

/** The gesture a press starts, and what it selects at once. */
export function pressGesture(
  press: Press,
  board: GestureBoard,
  camera: BoardCamera,
): { gesture: Gesture | null; select: Selecting | null } {
  const { at, target } = press
  if (press.pan) return { gesture: { kind: 'pan', start: at, from: camera }, select: null }
  // On a frame or a name too: with Z held, every press zooms.
  if (press.zoom)
    return { gesture: { kind: 'zoom', start: at, now: at, out: press.altKey }, select: null }
  const section = board.sections.find((s) => s.id === target.section)
  if (section) {
    // Its name picks the section, selecting its frames, and drags them all.
    return {
      select: { ids: section.frames, section: section.id },
      gesture: {
        kind: 'move',
        start: at,
        ids: section.frames,
        hit: null,
        narrow: false,
        moved: false,
        toggle: null,
        section: section.id,
      },
    }
  }
  if (target.resize) {
    const frame = board.drawn.find((f) => f.id === target.resize)
    return {
      select: null,
      gesture: frame ? { kind: 'resize', start: at, id: target.resize, from: frame } : null,
    }
  }
  const frameId = target.frame
  if (frameId) {
    const selected = new Set(board.selection)
    let ids = board.selection
    let toggle: string | null = null
    if (press.shiftKey) {
      if (selected.has(frameId)) toggle = frameId
      else ids = [...ids, frameId]
    } else if (!selected.has(frameId)) ids = [frameId]
    // Pressing one of several selected frames drags them all; a click selects it alone.
    const narrow = !press.shiftKey && selected.has(frameId) && board.selection.length > 1
    return {
      select: ids !== board.selection ? { ids, section: null } : null,
      gesture: { kind: 'move', start: at, ids, hit: frameId, narrow, moved: false, toggle },
    }
  }
  return {
    select: null,
    gesture: { kind: 'marquee', start: at, now: at, add: press.shiftKey ? board.selection : [] },
  }
}

/**
 * What a right-click (or a ⌃-click) on `target` opens: a section's menu, acting on the section
 * picked as a click on its name picks it; or a frame's, from the frame or its name (`label`).
 */
export function contextMenu(
  target: PressTarget,
  label: string | undefined,
  sections: readonly BoardSection[],
): { select?: Selecting; intent: BoardIntent } | null {
  const section = sections.find((s) => s.id === target.section)
  if (section)
    return {
      select: { ids: section.frames, section: section.id },
      intent: { type: 'sectionMenu', id: section.id },
    }
  const id = target.frame ?? label
  return id ? { intent: { type: 'frameMenu', id } } : null
}

/** What a move of the pointer to `at` changes: the gesture, the camera, frames as drawn. */
export interface Drag {
  gesture?: Gesture
  camera?: BoardCamera
  overrides?: Record<string, Override>
}

export function dragGesture(
  current: Gesture,
  at: BoardViewPoint,
  camera: BoardCamera,
  frames: readonly BoardFrame[],
): Drag {
  const { dx, dy } = dragOffset(current.start, at, camera)
  if (current.kind === 'pan') return { camera: dragFrom(current.from, current.start, at) }
  if (current.kind === 'move') {
    const far = Math.hypot(at.x - current.start.x, at.y - current.start.y) > DRAG_SLOP
    if (!current.moved && !far) return {}
    const overrides: Record<string, Override> = {}
    for (const frame of frames) {
      if (!current.ids.includes(frame.id)) continue
      overrides[frame.id] = { x: Math.round(frame.x + dx), y: Math.round(frame.y + dy) }
    }
    return { gesture: current.moved ? undefined : { ...current, moved: true }, overrides }
  }
  if (current.kind === 'resize') {
    const edge = (value: number) => Math.round(Math.min(FRAME_MAX, Math.max(FRAME_MIN, value)))
    return {
      overrides: {
        [current.id]: {
          width: edge(current.from.width + dx),
          height: edge(current.from.height + dy),
        },
      },
    }
  }
  return { gesture: { ...current, now: at } }
}

/** The last click on a frame or a section's name, to tell a double-click. */
export interface Click {
  id: string
  at: number
}

/**
 * A click on `id` at `now`: whether it's the second of a double-click, and the click to
 * remember (none after a double-click, so a third click starts again). The board captures
 * the pointer, so no dblclick event comes: it's timed.
 */
export function clickOn(last: Click | null, id: string, now: number) {
  const twice = last?.id === id && now - last.at < DOUBLE_CLICK_MS
  return { twice, last: twice ? null : { id, at: now } }
}

/** The frames among `ids` a gesture changed from what main has, as they'd land. */
export function landed(
  ids: readonly string[],
  frames: readonly BoardFrame[],
  overrides: Record<string, Override>,
): BoardFrame[] {
  return frames.flatMap((frame) => {
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
}

/** What a gesture leaves when it ends. */
export interface Ending {
  /** The camera rests where a pan left it */
  rest?: boolean
  /** Where the Zoom tool takes the camera */
  camera?: BoardCamera
  /**
   * What was drawn ahead of main goes now: the gesture changed nothing (it ended where it
   * began), so no new layout from main will clear it
   */
  clear?: boolean
  select?: Selecting
  /** Sent after `select` */
  intents: BoardIntent[]
  /** The section whose name opens for renaming */
  renameSection?: string
  /** The click to remember, when this one was a click; unchanged when absent */
  click?: Click | null
}

export function endGesture(
  done: Gesture,
  board: GestureBoard,
  overrides: Record<string, Override>,
  camera: BoardCamera,
  /** The board's size on screen, which a Zoom tool's drag fills */
  view: { width: number; height: number },
  last: Click | null,
  now: number,
): Ending {
  if (done.kind === 'pan') return { rest: true, intents: [] }
  if (done.kind === 'zoom') {
    const box = marqueeRect(done.start, done.now)
    const click = box.width < DRAG_SLOP && box.height < DRAG_SLOP
    return {
      camera: click
        ? zoomAbout(camera, done.out ? 1 / ZOOM_STEP : ZOOM_STEP, done.start)
        : zoomToBox(camera, box, view),
      intents: [],
    }
  }
  if (done.kind === 'move') {
    if (done.moved) {
      const moved = landed(done.ids, board.frames, overrides)
      return {
        clear: !moved.length,
        intents: moved.length
          ? [{ type: 'arrange', frames: moved.map(({ id, x, y }) => ({ id, x, y })) }]
          : [],
      }
    }
    if (done.toggle)
      return {
        select: { ids: board.selection.filter((id) => id !== done.toggle), section: null },
        intents: [],
      }
    if (done.section) {
      // A second click on its name soon after: rename it.
      const click = clickOn(last, `section:${done.section}`, now)
      return {
        intents: [],
        click: click.last,
        renameSection: click.twice ? done.section : undefined,
      }
    }
    if (done.hit) {
      // A second click on the same frame soon after: open it, the one clicked.
      const id = done.hit
      const click = clickOn(last, id, now)
      return {
        select: done.narrow ? { ids: [id], section: null } : undefined,
        intents: click.twice ? [{ type: 'open', id }] : [],
        click: click.last,
      }
    }
    return { intents: [] }
  }
  if (done.kind === 'resize') {
    // The size alone: where the frame is stays main's, which the agent may have moved since.
    const [frame] = landed([done.id], board.frames, overrides)
    if (!frame) return { clear: true, intents: [] }
    const { id, width, height } = frame
    return { intents: [{ type: 'arrange', frames: [{ id, width, height }] }] }
  }
  const box = marqueeRect(done.start, done.now)
  if (box.width < DRAG_SLOP && box.height < DRAG_SLOP) {
    return {
      select: board.selection.length && !done.add.length ? { ids: [], section: null } : undefined,
      intents: [],
    }
  }
  const hit = board.drawn
    .filter((frame) => inMarquee(boardRectFrom(frame), box, camera))
    .map((frame) => frame.id)
  return {
    select: { ids: [...done.add, ...hit.filter((id) => !done.add.includes(id))], section: null },
    intents: [],
  }
}
