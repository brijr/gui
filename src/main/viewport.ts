import { FRAME_LABEL_HEIGHT, FRAME_MARGIN } from '../shared/layout'
import { type Rect, type Viewport, viewportSpec } from '../shared/types'
import type { Inspector } from './inspector'

/** Chromium's emulation needs a positive scale; a canvas this small shows nothing useful anyway. */
const MIN_SCALE = 0.05
/**
 * Chrome's zoom levels. Desktop steps through all of them; a device frame from the first up
 * to the scale that fits the canvas, never past 100%.
 */
export const ZOOM_LEVELS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
] as const
/** Scales this close are the same (they're kept in thousandths). */
const SAME_SCALE = 0.001

/**
 * A viewport's zoom, per tab: Desktop's is a page zoom like a browser's, 1 at 100%; a device
 * frame's is the scale it's drawn at, or null to fit the canvas (and follow it as it resizes).
 */
export type Zoom = number | null
/** What an emulated phone or tablet reports to `navigator.maxTouchPoints`. */
const TOUCH_POINTS = 5

/** A device frame's page: laid out at its CSS size, drawn `scale` times that on screen. */
export interface Emulation {
  width: number
  height: number
  scale: number
  mobile: boolean
}

/**
 * Where the preview goes in `area` (the canvas, less a docked chat) for `viewport` at `zoom`.
 * Desktop fills it; zoomed, the page lays out at the area's size over the zoom and is drawn
 * at the zoom, so it still fills it. A device frame is centered with its label above it, at
 * its CSS size or scaled down to fit (or to its zoom), never up. `emulation` is what makes
 * the page lay out at that size.
 */
export function placePreview(
  viewport: Viewport,
  area: Rect,
  zoom: Zoom = null,
): { bounds: Rect; emulation: Emulation | null } {
  const { size, mobile } = viewportSpec(viewport)
  if (!size) {
    const bounds = {
      x: Math.round(area.x),
      y: Math.round(area.y),
      width: Math.max(0, Math.round(area.width)),
      height: Math.max(0, Math.round(area.height)),
    }
    const scale = zoom ?? 1
    if (scale === 1 || bounds.width === 0 || bounds.height === 0) return { bounds, emulation: null }
    const width = Math.max(1, Math.round(bounds.width / scale))
    const height = Math.max(1, Math.round(bounds.height / scale))
    return { bounds, emulation: { width, height, scale, mobile: false } }
  }
  const room = {
    width: area.width - FRAME_MARGIN * 2,
    height: area.height - FRAME_MARGIN * 2 - FRAME_LABEL_HEIGHT,
  }
  const fit = Math.min(1, room.width / size.width, room.height / size.height)
  // In thousandths, so a layout that changed nothing re-emulates nothing.
  const largest = Math.max(MIN_SCALE, Math.floor(fit * 1000) / 1000)
  const scale = zoom === null ? largest : Math.min(zoom, largest)
  const width = Math.round(size.width * scale)
  const height = Math.round(size.height * scale)
  // The label and the frame below it, centered together.
  const bounds = {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + FRAME_LABEL_HEIGHT + (area.height - FRAME_LABEL_HEIGHT - height) / 2),
    width,
    height,
  }
  return { bounds, emulation: { ...size, scale, mobile } }
}

/**
 * `zoom` after View → Zoom In (`step` 1), Zoom Out (-1) or Actual Size (0) for `viewport` on
 * `area`; undefined when it can't go further. Desktop's page zoom steps through
 * ZOOM_LEVELS, back to 100%. A device frame steps between 25% and the largest scale that fits
 * the canvas (never past 100%, never needing to scroll) and back to fitting it.
 */
export function zoomed(viewport: Viewport, area: Rect, zoom: Zoom, step: 1 | -1 | 0) {
  const frame = viewportSpec(viewport).size !== null
  if (step === 0) return frame ? null : 1
  const lowest = ZOOM_LEVELS[0]
  const highest = ZOOM_LEVELS[ZOOM_LEVELS.length - 1] ?? 1
  // A frame: where it's drawn now, and where it would be fitting.
  const current = frame ? (placePreview(viewport, area, zoom).emulation?.scale ?? 1) : (zoom ?? 1)
  const fit = frame ? (placePreview(viewport, area).emulation?.scale ?? 1) : highest
  const min = Math.min(lowest, fit)
  const levels = ZOOM_LEVELS.filter((level) => level >= min && level <= fit + SAME_SCALE)
  const next =
    step === 1
      ? (levels.find((level) => level > current + SAME_SCALE) ??
        (fit > current + SAME_SCALE ? fit : undefined))
      : (levels.findLast((level) => level < current - SAME_SCALE) ??
        (min < current - SAME_SCALE ? min : undefined))
  if (next === undefined) return undefined
  // Up to the fit, a frame fits again, and keeps fitting as the window resizes.
  return frame && next >= fit - SAME_SCALE ? null : next
}

const same = (a: Emulation | null, b: Emulation | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.width === b.width &&
    a.height === b.height &&
    a.scale === b.scale &&
    a.mobile === b.mobile)

/**
 * Keeps the preview's page at its viewport's size with Chromium's device emulation, over
 * the inspector's debugger session. The page lays out at the frame's CSS size and is drawn
 * at `scale` into a view that size times the scale (`dontSetVisibleSize`: the view's size
 * stays the layout's). Changes go through the inspector's lock, the newest one winning, so
 * they never land in the middle of a pick or an agent screenshot; one that emulates a width
 * of its own puts the user's viewport back with `restore`.
 *
 * Desktop's zoom is emulated the same way, rather than with Chromium's page zoom: that's
 * kept per host, and every project's dev server is on localhost, so tabs would share it.
 *
 * Phones and tablets are `mobile` (their `<meta name=viewport>` applies, scrollbars overlay)
 * and report a touch screen to media queries (`pointer: coarse`, `hover: none`) and
 * `maxTouchPoints`. The mouse stays a mouse: turning it into touches would take away hover
 * and break picking, which reads mouse events.
 */
export class ViewportEmulation {
  /** What the page should have; null for none (Desktop). */
  private wanted: Emulation | null = null
  /** What this session last gave it. */
  private applied: Emulation | null = null
  private applying = false
  private disposed = false

  constructor(private readonly inspector: Inspector) {
    // Closing the session (the user opening the preview's DevTools can) drops the emulation.
    inspector.on('detach', () => {
      this.applied = null
      this.flush()
    })
  }

  /**
   * How large the page is drawn: page coordinates (CSS pixels) times this are the preview
   * view's. 1 for Desktop at 100%.
   */
  get scale() {
    return this.applied?.scale ?? 1
  }

  set(emulation: Emulation | null) {
    this.wanted = emulation
    this.flush()
  }

  /** Inside the inspector's lock, after emulating something else: the user's viewport again. */
  async restore() {
    await this.send(this.wanted)
  }

  dispose() {
    this.disposed = true
  }

  private flush() {
    if (this.applying || this.disposed || same(this.wanted, this.applied)) return
    this.applying = true
    this.inspector
      .exclusive(async () => {
        while (!this.disposed && !same(this.wanted, this.applied)) await this.send(this.wanted)
      })
      .catch((error: unknown) => console.error('[gui] viewport emulation failed', error))
      .finally(() => {
        this.applying = false
      })
  }

  /** Unlocked: callers hold the inspector's lock. */
  private async send(emulation: Emulation | null) {
    const touch = emulation?.mobile ?? false
    const touched = this.applied?.mobile ?? false
    if (emulation) {
      const { width, height, scale, mobile } = emulation
      await this.inspector.command('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        // The display's own density, so the page stays sharp at any scale.
        deviceScaleFactor: 0,
        mobile,
        scale,
        dontSetVisibleSize: true,
      })
    } else {
      await this.inspector.command('Emulation.clearDeviceMetricsOverride')
    }
    if (touch !== touched) {
      await this.inspector.command('Emulation.setTouchEmulationEnabled', {
        enabled: touch,
        maxTouchPoints: TOUCH_POINTS,
      })
    }
    this.applied = emulation
  }
}
