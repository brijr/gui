import { app, type BrowserWindow } from 'electron'

/**
 * Unpackaged builds launched with GUI_E2E_BACKGROUND=1 (the end-to-end tests) show their
 * windows without activating Gui, so a test run doesn't take the keyboard from the app the
 * user is working in.
 */
const inBackground = !app.isPackaged && process.env.GUI_E2E_BACKGROUND === '1'

/**
 * GUI_E2E_HIDDEN=1 as well (a walkthrough's screenshots, a run beside someone's work): windows
 * are see-through and let clicks pass, so nothing shows on screen while pages still render.
 */
const hidden = inBackground && process.env.GUI_E2E_HIDDEN === '1'

/**
 * In the background, macOS isn't let bring Gui to the front at all, whatever shows a window
 * or a sheet, and it keeps out of the Dock and ⌘Tab.
 */
export function keepInBackground() {
  if (inBackground && process.platform === 'darwin') app.setActivationPolicy('prohibited')
  // A view shown under the real pointer still hears it (macOS, as the window lets it
  // through): leaving would drop the hover the tests' own pointer just made, and moving would
  // hover whatever the user's pointer is over. The pick overlay takes only the tests' moves,
  // which mark themselves with `guiE2eInput` (e2e/helpers/session.ts) as they send them.
  if (hidden)
    app.on('web-contents-created', (_event, contents) =>
      contents.on('before-mouse-event', (event, mouse) => {
        if (mouse.type === 'mouseEnter' || mouse.type === 'mouseLeave') event.preventDefault()
        else if (
          mouse.type === 'mouseMove' &&
          !(globalThis as { guiE2eInput?: boolean }).guiE2eInput &&
          contents.getURL().endsWith('/pick.html')
        )
          event.preventDefault()
      }),
    )
}

/** Shows a window, in front and with the keyboard unless Gui runs in the background. */
export function showWindow(win: BrowserWindow) {
  if (hidden) {
    win.setOpacity(0)
    win.setIgnoreMouseEvents(true)
  }
  if (inBackground) win.showInactive()
  else win.show()
}

/**
 * Shows a window without taking the keyboard or bringing Gui to the front: an agent outside
 * Gui opened something in it while the user types in another app.
 */
export function showWindowInactive(win: BrowserWindow) {
  if (hidden) {
    win.setOpacity(0)
    win.setIgnoreMouseEvents(true)
  }
  if (!win.isVisible()) win.showInactive()
}

/** Brings a window to the front with the keyboard, unless Gui runs in the background. */
export function focusWindow(win: BrowserWindow, { steal = false } = {}) {
  if (inBackground) return
  if (steal && process.platform === 'darwin') app.focus({ steal: true })
  win.focus()
}
