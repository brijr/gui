import type { BoardCamera } from '../../../shared/board'
import type { BoardCommand, FrameArrangement, Unsubscribe } from '../../../shared/ipc'
import type { Point, Rect } from '../../../shared/types'
import { gui } from '../lib/api'

/*
 * Everything the board asks of main, and hears from it: the one place the board calls
 * window.gui. Gestures and keys say what they ask for as a `BoardIntent`; the board sends it.
 */

export type BoardIntent =
  /** The frames selected, in the order they were selected */
  | { type: 'select'; ids: string[] }
  /** A press on empty board: the floating chat, not in use, gets out of the way */
  | { type: 'pressed' }
  /** Frames dragged, resized or nudged: one undo step */
  | { type: 'arrange'; frames: FrameArrangement[] }
  /** The frame shown live */
  | { type: 'open'; id: string }
  | { type: 'delete'; ids: string[] }
  /** The section goes; its frames stay */
  | { type: 'deleteSection'; id: string }
  | { type: 'addSection'; ids: string[] }
  | { type: 'duplicate'; ids: string[] }
  | { type: 'export'; ids: string[] }
  | { type: 'renameFrame'; id: string; name: string }
  | { type: 'renameSection'; id: string; name: string }
  /** A context menu, at `at` in the window, or at the pointer */
  | { type: 'frameMenu'; id: string; at?: Point }
  | { type: 'sectionMenu'; id: string; at?: Point }
  /** Where the board rests, for the next time this canvas opens */
  | { type: 'camera'; camera: BoardCamera; board: string }

export function sendIntent(intent: BoardIntent) {
  switch (intent.type) {
    case 'select':
      return gui.boardSelect(intent.ids)
    case 'pressed':
      return gui.boardPressed()
    case 'arrange':
      return gui.boardArrange(intent.frames)
    case 'open':
      return gui.boardOpenFrame(intent.id)
    case 'delete':
      return gui.boardDelete(intent.ids)
    case 'deleteSection':
      return gui.boardDeleteSection(intent.id)
    case 'addSection':
      return gui.boardAddSection(intent.ids)
    case 'duplicate':
      return gui.boardDuplicate(intent.ids)
    case 'export':
      return gui.boardExport(intent.ids)
    case 'renameFrame':
      return gui.boardRenameFrame(intent.id, intent.name)
    case 'renameSection':
      return gui.boardRenameSection(intent.id, intent.name)
    case 'frameMenu':
      return gui.showFrameMenu(intent.id, intent.at)
    case 'sectionMenu':
      return gui.showSectionMenu(intent.id, intent.at)
    case 'camera':
      return gui.boardCamera(intent.camera, intent.board)
  }
}

/** What a menu in main asks the board to do. */
export function onBoardCommand(listener: (command: BoardCommand) => void): Unsubscribe {
  return gui.onBoardCommand(listener)
}

/** Where the floating chat covers the window (CSS pixels), or null where it doesn't. */
export function chatCover(): Promise<Rect | null> {
  return gui.boardChatCover().catch(() => null)
}

/** An empty board's starter prompt, to the chat: whether it was sent. */
export function sendStarter(prompt: string): Promise<boolean> {
  return gui.send(prompt)
}
