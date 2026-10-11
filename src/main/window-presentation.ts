import { app, type BrowserWindow } from 'electron'

/**
 * Unpackaged builds launched with GUI_E2E_BACKGROUND=1 (the end-to-end tests) show their
 * windows without activating Gui, so a test run doesn't take the keyboard from the app the
 * user is working in.
 */
const inBackground = !app.isPackaged && process.env.GUI_E2E_BACKGROUND === '1'

/**
 * In the background, macOS isn't let bring Gui to the front at all, whatever shows a window
 * or a sheet, and it keeps out of the Dock and ⌘Tab.
 */
export function keepInBackground() {
  if (inBackground && process.platform === 'darwin') app.setActivationPolicy('prohibited')
}

/** Shows a window, in front and with the keyboard unless Gui runs in the background. */
export function showWindow(win: BrowserWindow) {
  if (inBackground) win.showInactive()
  else win.show()
}

/** Brings a window to the front with the keyboard, unless Gui runs in the background. */
export function focusWindow(win: BrowserWindow, { steal = false } = {}) {
  if (inBackground) return
  if (steal && process.platform === 'darwin') app.focus({ steal: true })
  win.focus()
}
