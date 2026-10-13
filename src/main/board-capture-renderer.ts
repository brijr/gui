import { BrowserWindow, type NativeImage } from 'electron'
import type { BoardFrameLayout } from '../shared/board'
import type { BoardCaptureRenderer } from './board-capture'
import { PREVIEW_PARTITION } from './storage'

const LOAD_TIMEOUT_MS = 8000
const READY_TIMEOUT_MS = 1500
const CAPTURE_MAX_HEIGHT = 3000

/** Fonts, images, then two painted frames; stalled dependencies have a bounded deadline. */
const READY_SCRIPT = `new Promise(resolve => {
  const timer = setTimeout(resolve, ${READY_TIMEOUT_MS});
  const images = [...document.images].map(image => image.complete ? null :
    new Promise(done => { image.addEventListener('load', done, { once: true }); image.addEventListener('error', done, { once: true }); }));
  Promise.all([document.fonts.ready, ...images]).then(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
  });
})`

/** A wait owns its timeout and abort listener; closing never waits on a destroyed renderer. */
function settleWithin<T>(task: Promise<T>, ms: number, signal: AbortSignal) {
  return new Promise<T | null>((resolve) => {
    const done = (value: T | null) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      resolve(value)
    }
    const abort = () => done(null)
    const timer = setTimeout(abort, ms)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void task.then(done, abort)
  })
}

/** One reusable worker per board; it has no frame document while idle. */
export class OffscreenBoardRenderer implements BoardCaptureRenderer {
  private worker: { scale: number; window: BrowserWindow } | null = null
  private disposed = false

  async render(
    frame: BoardFrameLayout,
    url: string,
    scale: number,
    signal: AbortSignal,
  ): Promise<NativeImage | null> {
    if (this.disposed || signal.aborted) return null
    const win = this.window(scale, new URL(url).origin)
    const width = frame.width
    const height = Math.min(frame.height, CAPTURE_MAX_HEIGHT)
    win.setContentSize(width, height)
    const wc = win.webContents
    const alive = () => !this.disposed && !signal.aborted && !win.isDestroyed()
    try {
      wc.startPainting()
      const loaded = await settleWithin(
        wc.loadURL(url).then(() => true),
        LOAD_TIMEOUT_MS,
        signal,
      )
      if (!loaded) return null
      if (!alive()) return null
      await settleWithin(wc.executeJavaScript(READY_SCRIPT), READY_TIMEOUT_MS, signal)
      if (!alive()) return null
      const image = await settleWithin(
        wc.capturePage({ x: 0, y: 0, width, height }),
        READY_TIMEOUT_MS,
        signal,
      )
      return alive() && image && !image.isEmpty() ? image : null
    } finally {
      if (!win.isDestroyed()) {
        wc.stopPainting()
        wc.stop()
        // Muting/stopPainting alone still leaves JS timers and animations executing.
        await settleWithin(wc.loadURL('about:blank'), 500, signal)
        if (!win.isDestroyed()) {
          wc.stopPainting()
          if (wc.getURL() !== 'about:blank') {
            win.destroy()
            if (this.worker?.window === win) this.worker = null
          }
        }
      }
    }
  }

  private window(scale: number, origin: string) {
    const existing = this.worker
    if (existing && !existing.window.isDestroyed()) {
      if (existing.scale === scale) return existing.window
      existing.window.destroy()
    }
    const window = new BrowserWindow({
      show: false,
      width: 1440,
      height: 900,
      useContentSize: true,
      enableLargerThanScreen: true,
      webPreferences: {
        offscreen: { deviceScaleFactor: scale },
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: PREVIEW_PARTITION,
      },
    })
    this.worker = { scale, window }
    const wc = window.webContents
    wc.setAudioMuted(true)
    wc.stopPainting()
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    wc.on('will-navigate', (event, url) => {
      if (url !== 'about:blank' && !url.startsWith(`${origin}/`)) event.preventDefault()
    })
    return window
  }

  dispose() {
    this.disposed = true
    if (this.worker && !this.worker.window.isDestroyed()) this.worker.window.destroy()
    this.worker = null
  }
}
