import type { BrowserWindow, WebContents } from 'electron'
import type { PanelCorner, Rect } from '../shared/types'
import { onDisplayFrames, type Point, prefersReducedMotion } from './panel-flight'
import type { ChatSize } from './prefs'

/** A window appearing fades in over this long (--motion-fade), unless motion is reduced. */
const WINDOW_FADE_MS = 150

/**
 * Fades a window in as it's shown (a popped-out chat), so it arrives rather than blinks on, on
 * the frames of `contents` (the page it shows). Opacity only, which macOS draws for any window;
 * with reduced motion it's simply there.
 */
export function fadeIn(win: BrowserWindow, contents: WebContents) {
  if (prefersReducedMotion()) return
  win.setOpacity(0)
  const start = performance.now()
  const stop = onDisplayFrames(contents, () => {
    if (win.isDestroyed()) return stop()
    const t = Math.min(1, (performance.now() - start) / WINDOW_FADE_MS)
    // Eases out, as every arrival does (--ease-out).
    win.setOpacity(1 - (1 - t) ** 3)
    if (t === 1) stop()
  })
}

/** Space the floating panel leaves around itself in the window. */
export const PANEL_MARGIN = 12

/** The anchor at `corner` of `area` (the canvas) that puts the floating panel at `rect`. */
export function anchorFor(rect: Rect, area: Rect, corner: PanelCorner): Anchor {
  return {
    x: corner.x,
    y: corner.y,
    dx: corner.x === 'left' ? rect.x - area.x : area.x + area.width - rect.x - rect.width,
    dy: corner.y === 'top' ? rect.y - area.y : area.y + area.height - rect.y - rect.height,
  }
}

/** The point at `rect`'s `corner`. */
export function cornerPoint(rect: Rect, corner: PanelCorner): Point {
  return {
    x: corner.x === 'left' ? rect.x : rect.x + rect.width,
    y: corner.y === 'top' ? rect.y : rect.y + rect.height,
  }
}

/** A box of `size` in `rect`'s `corner`. */
export function inCorner(rect: Rect, size: ChatSize, corner: PanelCorner): Rect {
  return {
    x: corner.x === 'left' ? rect.x : rect.x + rect.width - size.width,
    y: corner.y === 'top' ? rect.y : rect.y + rect.height - size.height,
    width: size.width,
    height: size.height,
  }
}

/**
 * The canvas a floating panel leaves uncovered above or below it on a short window, so the top
 * of the page (its heading) stays in view. All of it on a canvas up to SHORT_CANVAS tall,
 * easing to none at TALL_CANVAS, where the panel can be as tall as the canvas again.
 */
const PAGE_CLEAR = 240
const SHORT_CANVAS = 600
const TALL_CANVAS = 800

/**
 * The largest the floating panel can be: the window's width, and the canvas's (`area`)
 * height less what a short window keeps clear, but not below `minHeight` while it fits.
 */
export function maxFloatingSize(contentWidth: number, area: Rect, minHeight: number): ChatSize {
  const fits = area.height - PANEL_MARGIN * 2
  const short = Math.min(1, Math.max(0, (TALL_CANVAS - area.height) / (TALL_CANVAS - SHORT_CANVAS)))
  const clear = Math.max(PANEL_MARGIN * 2, Math.round(PAGE_CLEAR * short))
  return {
    width: contentWidth - PANEL_MARGIN * 2,
    height: Math.min(fits, Math.max(area.height - clear, minHeight)),
  }
}

/** A corner of the canvas, and how far the floating panel's own corner there is from it. */
export interface Anchor extends PanelCorner {
  /** From the canvas's left or right edge */
  dx: number
  /** From the canvas's top or bottom edge */
  dy: number
}
