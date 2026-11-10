import { type RefObject, useEffect, useState, useSyncExternalStore } from 'react'
import type { BoardCamera } from '../../../shared/board'

/*
 * What the board shares with the toolbar: its zoom and the controls for it (`useBoardView`),
 * and the Move/Hand tool (`useBoardTool`). Both are stores outside React, so the toolbar
 * follows the board without either rendering the other.
 */

// The board's camera, shared with the toolbar's zoom controls.
export interface BoardView {
  camera: BoardCamera | null
  zoomBy: (factor: number) => void
  fit: () => void
}

const NO_VIEW: BoardView = { camera: null, zoomBy: () => undefined, fit: () => undefined }
let view: BoardView = NO_VIEW
const viewListeners = new Set<() => void>()

/** The board says where it looks and how to change that; `null` as it goes. */
export function publishView(next: BoardView | null) {
  view = next ?? NO_VIEW
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

// The board's tool, shared with the toolbar's Move/Hand control.
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

/**
 * Whether a drag pans: the Hand is the tool, or Space is held, for as long as it's held, as in
 * every design tool. Space counts only for the board (or nothing focused): it still presses
 * the toolbar's buttons.
 */
export function useHand(board: RefObject<HTMLElement | null>) {
  const [space, setSpace] = useState(false)
  useEffect(() => {
    const forBoard = (target: EventTarget | null) =>
      target === document.body || (!!board.current && target === board.current)
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
  }, [board])
  return useBoardTool() === 'hand' || space
}
