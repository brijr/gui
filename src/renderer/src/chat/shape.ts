import { useSyncExternalStore } from 'react'
import type { ChatShape } from '../../../shared/types'
import { gui } from '../lib/api'

/*
 * The chat mid-way between the floating card and the sidebar (main/dock-morph.ts). Main moves
 * and sizes the view on each frame and sends how to draw the chat in it for that size, just
 * before. The page draws the frame meant for the size it has, so the shape always fits the view
 * it's in, even when a resize and its message land on different frames.
 */

/** The last few frames, newest last: the view's size can lag the newest by a frame or two. */
const KEPT = 4

let frames: ChatShape[] = []
let current: ChatShape | null = null
const listeners = new Set<() => void>()

function set(next: ChatShape | null) {
  if (next === current) return
  current = next
  for (const listener of [...listeners]) listener()
}

/** The frame for the view's size now, or the newest. */
function pick() {
  if (frames.length === 0) return set(null)
  const fits = (frame: ChatShape) =>
    Math.abs(frame.width - innerWidth) <= 1 && Math.abs(frame.height - innerHeight) <= 1
  set(frames.findLast(fits) ?? frames.at(-1) ?? null)
}

/** Follows main's shape frames for this chat page. */
export function connectShape() {
  const off = gui.onChatShape((shape) => {
    frames = shape ? [...frames.slice(1 - KEPT), shape] : []
    pick()
  })
  window.addEventListener('resize', pick)
  return () => {
    off()
    window.removeEventListener('resize', pick)
    frames = []
    set(null)
  }
}

export function currentShape() {
  return current
}

/** Calls `listener` whenever the frame to draw changes. */
export function subscribeShape(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** True while the chat changes shape between the card and the sidebar. */
export function useShaping() {
  return useSyncExternalStore(subscribeShape, () => current !== null)
}
