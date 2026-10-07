import { type BrowserWindow, nativeTheme } from 'electron'
import { SURFACE } from '../shared/theme'

/** --surface for the current appearance. */
export function surfaceColor() {
  return nativeTheme.shouldUseDarkColors ? SURFACE.dark : SURFACE.light
}

/**
 * Keeps a window's background, which shows while its page loads and as it resizes, on
 * --surface when the appearance changes.
 */
export function followSurface(win: BrowserWindow) {
  const update = () => {
    if (!win.isDestroyed()) win.setBackgroundColor(surfaceColor())
  }
  nativeTheme.on('updated', update)
  win.once('closed', () => nativeTheme.off('updated', update))
}
