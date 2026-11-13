/** Sends an error in this window to main, which sends a crash report if they are on. */
export function reportError(error: unknown) {
  const report =
    error instanceof Error
      ? { message: error.message, stack: error.stack }
      : { message: String(error) }
  // window.gui, not lib/api: components that tests draw without a window load this file.
  globalThis.window?.gui?.reportError(report)
}

/**
 * The browser's notes that aren't Gui failing: a ResizeObserver that changed a size as it
 * heard of one, whose next notice waits a frame ("loop completed with undelivered
 * notifications", or "loop limit exceeded" in older Chromium).
 */
export function isBrowserNoise(event: Pick<ErrorEvent, 'error' | 'message'>) {
  return !event.error && /ResizeObserver loop/.test(event.message)
}

/** Errors nothing caught: a failed event handler, a rejected promise nothing awaited. */
export function watchErrors() {
  window.addEventListener('error', (event) => {
    if (!isBrowserNoise(event)) reportError(event.error ?? event.message)
  })
  window.addEventListener('unhandledrejection', (event) => reportError(event.reason))
}
