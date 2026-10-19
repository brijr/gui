import type { RecordingCursor } from '../../../shared/types'

/**
 * Draws the mouse pointer into a recording's frames: the capture is of the preview's page,
 * which has no pointer of its own. A ring with a dot at the tip, filled while the button is
 * down, with a ripple as it's pressed. It reads as a highlight on top of the system pointer
 * when Chromium draws that too, so it works either way.
 */
export class PointerOverlay {
  private cursor: RecordingCursor | null = null
  private pressedAt = Number.NEGATIVE_INFINITY
  private changed = false

  set(cursor: RecordingCursor) {
    if (cursor.down && !this.cursor?.down) this.pressedAt = performance.now()
    this.cursor = cursor
    this.changed = true
  }

  /** Whether it moved since the last call, so a new frame is worth keeping. */
  takeChanged() {
    const changed = this.changed || performance.now() - this.pressedAt < RIPPLE_MS
    this.changed = false
    return changed
  }

  /** `unit` is canvas pixels per CSS pixel of the preview. */
  draw(context: CanvasRenderingContext2D, width: number, height: number, unit: number) {
    const cursor = this.cursor
    if (!cursor?.inside) return
    const x = cursor.x * width
    const y = cursor.y * height
    const radius = 13 * unit
    context.save()
    const since = performance.now() - this.pressedAt
    if (since < RIPPLE_MS) {
      const t = since / RIPPLE_MS
      context.beginPath()
      context.arc(x, y, radius * (1 + t * 1.6), 0, Math.PI * 2)
      context.strokeStyle = `rgba(0, 122, 255, ${0.6 * (1 - t)})`
      context.lineWidth = 3 * unit
      context.stroke()
    }
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fillStyle = cursor.down ? 'rgba(0, 122, 255, 0.4)' : 'rgba(0, 122, 255, 0.14)'
    context.fill()
    context.lineWidth = 3.5 * unit
    context.strokeStyle = 'rgba(0, 0, 0, 0.45)'
    context.stroke()
    context.lineWidth = 2 * unit
    context.strokeStyle = 'rgba(255, 255, 255, 0.95)'
    context.stroke()
    context.beginPath()
    context.arc(x, y, 2.5 * unit, 0, Math.PI * 2)
    context.fillStyle = 'rgba(0, 122, 255, 1)'
    context.fill()
    context.lineWidth = 1 * unit
    context.strokeStyle = 'rgba(255, 255, 255, 0.95)'
    context.stroke()
    context.restore()
  }
}

const RIPPLE_MS = 450
