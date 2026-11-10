import { type RefObject, useEffect, useState, useSyncExternalStore } from 'react'
import type { BoardCamera } from '../../../shared/board'
import { heldKeys, NO_KEYS_HELD, pointerTool } from './keys'

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
 * What a press on the board does now: the toolbar's tool, the Hand while Space is held, or the
 * Zoom tool while Z is held (`out` while ⌥ is too), for as long as each is held, as in Figma.
 * Space and Z count only for the board (or nothing focused): Space still presses the toolbar's
 * buttons, and both type in a name's field.
 */
export function usePointerTool(board: RefObject<HTMLElement | null>) {
  const [held, setHeld] = useState(NO_KEYS_HELD)
  useEffect(() => {
    const forBoard = (target: EventTarget | null) =>
      target === document.body || (!!board.current && target === board.current)
    const key = (event: KeyboardEvent) => {
      const type = event.type === 'keydown' ? 'keydown' : 'keyup'
      // Space would scroll, or press what has the keyboard.
      if (type === 'keydown' && event.code === 'Space' && forBoard(event.target))
        event.preventDefault()
      const { code, metaKey, ctrlKey, altKey } = event
      const pressed = { type, code, metaKey, ctrlKey, altKey } as const
      setHeld((current) => heldKeys(current, pressed, forBoard(event.target)))
    }
    // Let go while in another app: no keyup comes.
    const blur = () => setHeld(NO_KEYS_HELD)
    window.addEventListener('keydown', key)
    window.addEventListener('keyup', key)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('keyup', key)
      window.removeEventListener('blur', blur)
    }
  }, [board])
  const tool = pointerTool(useBoardTool(), held)
  return { tool, out: tool === 'zoom' && held.alt }
}
