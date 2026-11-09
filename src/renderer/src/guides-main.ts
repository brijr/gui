import type { GuideStrips } from '../../shared/types'
import { gui } from './lib/api'
import { watchErrors } from './lib/crash-reports'

/**
 * The guides' grab strips (main/guides.ts). This page is never on screen: each strip is an
 * about:blank window it opens by name, which main lays over the page as a view of its own, and
 * this page draws into and listens on. A strip is a line in the middle of a few clear pixels
 * that take the pointer, so a guide is easy to grab and the page around it keeps its clicks.
 */

/** The line's place across a strip (main/guides.ts: STRIP 7, the middle pixel). */
const LINE = 3

interface Strip {
  win: Window
  line: HTMLElement
}

watchErrors()
const strips = new Map<string, Strip>()
/** Each window gets a name of its own: one closing may still hold an old one. */
let opened = 0

gui.onGuideStrips(({ strips: wanted, dragging, color }: GuideStrips) => {
  const ids = new Set(wanted.map(({ id }) => id))
  for (const [id, strip] of strips) if (!ids.has(id) || strip.win.closed) strips.delete(id)
  for (const { id, axis } of wanted) {
    let strip = strips.get(id)
    if (!strip) {
      const opened = open(id)
      if (!opened) continue
      strip = opened
      strips.set(id, strip)
    }
    const vertical = axis === 'x'
    const root = strip.win.document.documentElement
    root.style.cursor = vertical ? 'col-resize' : 'row-resize'
    Object.assign(strip.line.style, {
      background: color,
      left: vertical ? `${LINE}px` : '0',
      top: vertical ? '0' : `${LINE}px`,
      width: vertical ? '1px' : '100%',
      height: vertical ? '100%' : '1px',
      // The dragged guide shows where it's going, on the drag strip; its own stays to be held.
      visibility: id === dragging ? 'hidden' : 'visible',
    })
  }
})

/** A strip's window: main makes it a view over the page (or refuses one it doesn't want). */
function open(id: string): Strip | null {
  const win = window.open('', `guide:${id}:${++opened}`)
  if (!win) return null
  const doc = win.document
  Object.assign(doc.documentElement.style, { height: '100%', overflow: 'hidden' })
  Object.assign(doc.body.style, { margin: '0', height: '100%', background: 'transparent' })
  const line = doc.createElement('div')
  line.style.position = 'fixed'
  line.style.pointerEvents = 'none'
  doc.body.append(line)
  // The drag strip only shows where a guide is going; the pointer is held elsewhere.
  if (id !== 'drag') listen(id, doc.documentElement)
  return { win, line }
}

function listen(id: string, root: HTMLElement) {
  let pressed: number | null = null
  const at = (event: PointerEvent) => ({ x: event.clientX, y: event.clientY })
  root.addEventListener('pointerenter', (event) => gui.guidePointer(id, 'enter', at(event)))
  root.addEventListener('pointerleave', (event) => {
    if (pressed === null) gui.guidePointer(id, 'leave', at(event))
  })
  root.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || pressed !== null) return
    pressed = event.pointerId
    root.setPointerCapture(event.pointerId)
    gui.guidePointer(id, 'down', at(event))
  })
  root.addEventListener('pointermove', (event) => {
    if (event.pointerId === pressed) gui.guidePointer(id, 'move', at(event))
  })
  const end = (phase: 'up' | 'cancel') => (event: PointerEvent) => {
    if (event.pointerId !== pressed) return
    pressed = null
    gui.guidePointer(id, phase, at(event))
  }
  root.addEventListener('pointerup', end('up'))
  root.addEventListener('pointercancel', end('cancel'))
  root.addEventListener('lostpointercapture', end('cancel'))
  root.addEventListener('contextmenu', (event) => event.preventDefault())
}
