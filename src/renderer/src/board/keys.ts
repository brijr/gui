import { type BoardSection, boardBounds, sectionBounds } from '../../../shared/board'
import { type KeyPress, matchesShortcut } from '../../../shared/shortcuts'
import type { BoardFrame } from '../../../shared/types'
import type { Area, Override } from './gestures'
import type { BoardIntent } from './intents'
import type { BoardTool } from './view'

/*
 * What a key does on the board, as a plain function: the key and the board in, what it asks
 * for out (or nothing, and the key goes on to the menu or the window). The board does it.
 */

/** Each + or − step, with ⌘ or without. */
export const ZOOM_STEP = 1.25

export interface BoardKey extends KeyPress {
  code: string
}

/** The board as a key reads it. */
export interface KeyBoard {
  /** Main's frames */
  frames: readonly BoardFrame[]
  /** As drawn this moment, with what a gesture or a nudge drew ahead of main */
  drawn: readonly BoardFrame[]
  sections: readonly BoardSection[]
  selection: string[]
  /** The section picked by its name, while its frames are what's selected */
  picked: BoardSection | undefined
}

/** What a key asks of main, or of the board itself. */
export type KeyAction =
  | BoardIntent
  /** These frames selected; `section` when it's a section picked by its name */
  | { type: 'pick'; ids: string[]; section: string | null }
  | { type: 'fit' }
  /** The selection (`area`, around it) filling the view, as Figma's ⇧2 */
  | { type: 'fitSelection'; area: Area }
  /** 100%, about the middle of the view */
  | { type: 'actualSize' }
  | { type: 'zoom'; factor: number }
  | { type: 'tool'; tool: BoardTool }
  /** A name's field opens */
  | { type: 'nameFrame'; id: string }
  | { type: 'nameSection'; id: string }
  /** A frame's or a section's context menu, from the keyboard: at the area's corner */
  | { type: 'menu'; of: 'frame' | 'section'; id: string; area: Area | null | undefined }
  /** Tab's next stop: selected, and brought into sight (the key goes on when it can't be) */
  | { type: 'step'; ids: string[]; section: string | null; reveal: Area | null }
  /** Arrow keys: the selected frames move by this much more */
  | { type: 'nudge'; ids: string[]; dx: number; dy: number }

/** What `key` does on `board`, or null when it's not the board's. */
export function boardKey(key: BoardKey, board: KeyBoard): KeyAction | null {
  const { picked } = board
  const command = key.metaKey || key.ctrlKey
  // Keys with ⌘, ⌃ or ⌥ that the board doesn't use go on to the menu (⌘⌫ is Don't Allow).
  const plain = !command && !key.altKey
  const ids = board.selection
  const step = key.shiftKey ? 10 : 1
  const arrows: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  }
  const deleting = plain && (key.key === 'Backspace' || key.key === 'Delete')
  // A section picked by its name goes on its own; its frames stay.
  if (deleting && picked) return { type: 'deleteSection', id: picked.id }
  if (deleting && ids.length) return { type: 'delete', ids }
  if (command && key.altKey && key.code === 'KeyG' && ids.length) return { type: 'addSection', ids }
  // ⌘D is Design Mode, as everywhere in Gui (the menu's); ⌥⌘D duplicates.
  if (command && key.altKey && key.code === 'KeyD' && ids.length) return { type: 'duplicate', ids }
  if (command && key.shiftKey && key.code === 'KeyE' && ids.length) return { type: 'export', ids }
  // ⌘C, ⌘X and ⌘V copy, cut and paste frames (in a name's field, its text: the board never
  // hears those keys). ⇧⌘C is Design Mode's, and ⌥⇧⌘V the menu's.
  const clip = command && !key.altKey && !key.shiftKey
  if (clip && key.code === 'KeyC' && ids.length) return { type: 'copy', ids, cut: false }
  if (clip && key.code === 'KeyX' && ids.length) return { type: 'copy', ids, cut: true }
  if (clip && key.code === 'KeyV') return { type: 'paste' }
  if (command && !key.altKey && !key.shiftKey && key.code === 'KeyA')
    return { type: 'pick', ids: board.frames.map((frame) => frame.id), section: null }
  if (command && key.key === '0') return { type: 'fit' }
  // Figma's zoom keys: ⇧0 100%, ⇧1 everything, ⇧2 the selection (nothing when there's none, as
  // in Figma). By the key where it is, as ⇧ makes them ")", "!" and "@".
  if (plain && key.shiftKey && key.code === 'Digit0') return { type: 'actualSize' }
  if (plain && key.shiftKey && key.code === 'Digit1') return { type: 'fit' }
  if (plain && key.shiftKey && key.code === 'Digit2') {
    const area = selectionArea(board)
    return area ? { type: 'fitSelection', area } : null
  }
  // + and − zoom with ⌘ or without, as in Figma.
  if (!key.altKey && (key.key === '=' || key.key === '+'))
    return { type: 'zoom', factor: ZOOM_STEP }
  if (!key.altKey && key.key === '-') return { type: 'zoom', factor: 1 / ZOOM_STEP }
  if (plain && key.code === 'KeyH') return { type: 'tool', tool: 'hand' }
  if (plain && key.code === 'KeyV') return { type: 'tool', tool: 'move' }
  if (plain && key.key === 'Enter' && ids.length === 1) return { type: 'open', id: ids[0] }
  if (key.key === 'Escape' && ids.length) return { type: 'pick', ids: [], section: null }
  // What a double-click and a right-click do, from the keyboard: on the section picked by its
  // name, or the one frame selected.
  if (matchesShortcut(key, 'canvasRename') && (picked || ids.length === 1))
    return picked ? { type: 'nameSection', id: picked.id } : { type: 'nameFrame', id: ids[0] }
  if (
    (matchesShortcut(key, 'canvasMenu') || (plain && key.key === 'ContextMenu')) &&
    (picked || ids.length === 1)
  ) {
    return picked
      ? { type: 'menu', of: 'section', id: picked.id, area: sectionBounds(picked, board.drawn) }
      : {
          type: 'menu',
          of: 'frame',
          id: ids[0],
          area: board.drawn.find((frame) => frame.id === ids[0]),
        }
  }
  if (plain && key.key === 'Tab' && board.frames.length) return tabStop(key.shiftKey, board)
  if (arrows[key.key] && ids.length && !command && !key.altKey) {
    const [dx, dy] = arrows[key.key]
    return { type: 'nudge', ids, dx, dy }
  }
  return null
}

/** Around what's selected, as drawn: the picked section's area, or the selected frames'. */
export function selectionArea(board: KeyBoard): Area | null {
  if (board.picked) return sectionBounds(board.picked, board.drawn)
  return boardBounds(board.drawn.filter((frame) => board.selection.includes(frame.id)))
}

/**
 * Tab and ⇧Tab step through the sections, each before its first frame, and the frames; past
 * the last there's no stop, and focus leaves the board.
 */
function tabStop(back: boolean, board: KeyBoard): KeyAction | null {
  const { picked, selection: ids } = board
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
  const next = stops[back ? (at === -1 ? stops.length - 1 : at - 1) : at + 1]
  if (next?.section)
    return {
      type: 'step',
      ids: next.section.frames,
      section: next.section.id,
      reveal: sectionBounds(next.section, board.frames),
    }
  if (next?.frame) return { type: 'step', ids: [next.frame.id], section: null, reveal: next.frame }
  return null
}

/** Arrow keys held: how far the frames have gone, landing as one change when the key comes up. */
export interface Nudge {
  ids: string[]
  dx: number
  dy: number
}

/**
 * The nudge after one more arrow press, and the frames as it draws them. A nudge of other
 * frames (the selection changed while a key was held) lands first: `land`.
 */
export function nudged(
  held: Nudge | null,
  press: { ids: string[]; dx: number; dy: number },
  frames: readonly BoardFrame[],
) {
  const land = !!held && held.ids.join('\n') !== press.ids.join('\n')
  const base = held && !land ? held : { ids: press.ids, dx: 0, dy: 0 }
  const next = { ids: base.ids, dx: base.dx + press.dx, dy: base.dy + press.dy }
  const overrides: Record<string, Override> = Object.fromEntries(
    frames
      .filter((frame) => press.ids.includes(frame.id))
      .map((frame) => [frame.id, { x: frame.x + next.dx, y: frame.y + next.dy }]),
  )
  return { land, nudge: next, overrides }
}

/** The frames a nudge moves, where they land; none when it came back to where it began. */
export function nudgeLanding(held: Nudge, frames: readonly BoardFrame[]) {
  if (!held.dx && !held.dy) return null
  return frames
    .filter((frame) => held.ids.includes(frame.id))
    .map((frame) => ({ id: frame.id, x: frame.x + held.dx, y: frame.y + held.dy }))
}
