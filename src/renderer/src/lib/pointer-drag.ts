import type { PointerEvent as ReactPointerEvent } from 'react'

/** The pointer's velocity at release is measured over this much of its recent path (ms). */
const VELOCITY_WINDOW = 100
/** A pointer held still this long before letting go releases at rest, whatever came before. */
const RELEASE_PAUSE = 50

interface Sample {
  x: number
  y: number
  t: number
}

/**
 * The pointer's velocity in px/s as it let go at `t`, from its path over the last
 * VELOCITY_WINDOW; zero if it had stopped moving before.
 */
function releaseVelocity(samples: Sample[], t: number) {
  const recent = samples.filter((sample) => t - sample.t <= VELOCITY_WINDOW)
  const first = recent[0]
  const last = recent.at(-1)
  if (!first || !last || t - last.t > RELEASE_PAUSE) return { x: 0, y: 0 }
  const seconds = (last.t - first.t) / 1000
  // Too short a path to tell a direction from noise.
  if (seconds < 0.008) return { x: 0, y: 0 }
  return { x: (last.x - first.x) / seconds, y: (last.y - first.y) / seconds }
}

/**
 * Follows a pointer drag in screen coordinates, since the native view moves and resizes
 * under the pointer, and reports the deltas batched per frame; at the end, the pointer's
 * velocity as it let go (px/s), so a throw carries on.
 *
 * What was pressed can go mid-drag: the sidebar's header, pulled off, is the floating panel's
 * now. The page itself then holds the pointer, with the closed hand, so the drag carries on.
 */
export function trackDrag(
  event: ReactPointerEvent<HTMLElement>,
  onMove: (dx: number, dy: number) => void,
  onEnd: (velocity: { x: number; y: number }) => void,
) {
  const el = event.currentTarget
  const id = event.pointerId
  const root = document.documentElement
  el.setPointerCapture(id)
  const keep = () => {
    if (el.isConnected || root.hasPointerCapture(id)) return
    try {
      root.setPointerCapture(id)
      root.style.cursor = 'grabbing'
    } catch {
      // Already let go.
    }
  }
  const lost = (e: PointerEvent) => {
    if (e.pointerId === id) queueMicrotask(keep)
  }
  let last = { x: event.screenX, y: event.screenY }
  let pending = { dx: 0, dy: 0 }
  let frame = 0
  let samples: Sample[] = [{ x: event.screenX, y: event.screenY, t: event.timeStamp }]

  const flush = () => {
    frame = 0
    if (pending.dx || pending.dy) onMove(pending.dx, pending.dy)
    pending = { dx: 0, dy: 0 }
  }
  const move = (e: PointerEvent) => {
    if (e.pointerId !== id) return
    keep()
    pending = { dx: pending.dx + e.screenX - last.x, dy: pending.dy + e.screenY - last.y }
    last = { x: e.screenX, y: e.screenY }
    samples = [...samples, { x: e.screenX, y: e.screenY, t: e.timeStamp }].filter(
      (sample) => e.timeStamp - sample.t <= VELOCITY_WINDOW * 2,
    )
    frame ||= requestAnimationFrame(flush)
  }
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return
    cancelAnimationFrame(frame)
    flush()
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('pointercancel', end)
    document.removeEventListener('lostpointercapture', lost, true)
    root.style.cursor = ''
    if (root.hasPointerCapture(id)) root.releasePointerCapture(id)
    onEnd(e.type === 'pointerup' ? releaseVelocity(samples, e.timeStamp) : { x: 0, y: 0 })
  }
  // On the window, which hears the pointer whichever element holds it.
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('pointercancel', end)
  document.addEventListener('lostpointercapture', lost, true)
}
