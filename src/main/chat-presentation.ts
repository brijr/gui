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

/** The largest the floating panel can be: the window's width, the canvas's (`area`) height. */
export function maxFloatingSize(contentWidth: number, area: Rect): ChatSize {
  return {
    width: contentWidth - PANEL_MARGIN * 2,
    height: area.height - PANEL_MARGIN * 2,
  }
}

/** A corner of the canvas, and how far the floating panel's own corner there is from it. */
export interface Anchor extends PanelCorner {
  /** From the canvas's left or right edge */
  dx: number
  /** From the canvas's top or bottom edge */
  dy: number
}
