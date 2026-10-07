import { type BrowserWindow, type BrowserWindowConstructorOptions, nativeTheme } from 'electron'
import { SURFACE } from '../shared/theme'

/**
 * The system's sidebar material behind a window, on macOS: what the chat sidebar (and a
 * popped-out chat) shows through, as Settings' sidebar does. The page paints everything
 * else. Elsewhere there's no material, and the window keeps --surface.
 */
export function sidebarMaterial(): BrowserWindowConstructorOptions {
  return process.platform === 'darwin'
    ? { vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000' }
    : { backgroundColor: surfaceColor() }
}

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
