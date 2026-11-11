import type { WebContents } from 'electron'
import { CaptureInterrupted } from './errors'

/**
 * Waits for a page capture Chromium is taking (`sent`). For a capture Chromium draws the page
 * at the clip's offset and scale, and puts the page's own emulation back only when the
 * capture comes back. One the page reloads, navigates or crashes under never comes back, and
 * left the preview drawn small inside its device frame until the frame changed. So this gives
 * up on such a capture at once (CaptureInterrupted), or after `timeoutMs`, and calls `lost` so
 * the viewport is sent again: then, and once Chromium does answer, which puts back the
 * emulation the capture started with, perhaps no longer the current one.
 */
export async function awaitCapture<T>(
  wc: Pick<WebContents, 'on' | 'off' | 'isDestroyed'>,
  sent: Promise<T>,
  timeoutMs: number,
  lost: () => void,
): Promise<T> {
  let stop = () => {}
  const cutShort = new Promise<never>((_resolve, reject) => {
    const interrupted = () => reject(new CaptureInterrupted())
    const timer = setTimeout(() => reject(new Error('Page.captureScreenshot timed out')), timeoutMs)
    wc.on('did-navigate', interrupted)
    wc.on('render-process-gone', interrupted)
    stop = () => {
      clearTimeout(timer)
      if (wc.isDestroyed()) return
      wc.off('did-navigate', interrupted)
      wc.off('render-process-gone', interrupted)
    }
  })
  try {
    return await Promise.race([sent, cutShort])
  } catch (error) {
    lost()
    sent.then(lost, lost)
    throw error
  } finally {
    stop()
  }
}
