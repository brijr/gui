import {
  BrowserWindow,
  type NativeImage,
  type Session,
  session as sessions,
  type WebContents,
} from 'electron'
import type { BoardFrameLayout, SharpRequest } from '../shared/board'
import { type BoardCaptureRenderer, UnresponsiveFrameError } from './board-capture'

const LOAD_TIMEOUT_MS = 8000
const READY_TIMEOUT_MS = 1500
/** A tall frame exported at 2x is a large image to read back; a capture at 3x is given half as long again. */
const CAPTURE_TIMEOUT_MS = 5000
/**
 * While a page loads it's asked every PROBE_EVERY_MS to run a line of script; one that can't
 * within PROBE_TIMEOUT_MS is stuck (a script that never ends) and is stopped.
 */
const PROBE_EVERY_MS = 1000
const PROBE_TIMEOUT_MS = 2000
/**
 * Frames render in their own session, in memory: not the user's previews (`persist:gui-preview`),
 * whose cookies and storage for 127.0.0.1 are the user's apps'.
 */
const CAPTURE_PARTITION = 'gui-canvas-capture'

let captureSession: Session | null = null

/** The capture session, locked down once: Electron grants every permission by default. */
function canvasSession() {
  if (captureSession) return captureSession
  const ses = sessions.fromPartition(CAPTURE_PARTITION)
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  ses.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault()
    callback()
  })
  ses.on('select-serial-port', (event, _ports, _wc, callback) => {
    event.preventDefault()
    callback('')
  })
  ses.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault()
    callback()
  })
  ses.on('will-download', (event) => event.preventDefault())
  captureSession = ses
  return ses
}

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

/** Whether the page runs a line of script in time; an abandoned wait isn't a hang. */
async function responds(wc: WebContents, signal: AbortSignal) {
  const answer = await settleWithin(
    wc.executeJavaScript('0').then(
      () => true,
      () => true,
    ),
    PROBE_TIMEOUT_MS,
    signal,
  )
  return answer !== null || signal.aborted || wc.isDestroyed()
}

/** Loads `url`, checking on the page as it does; null when it took too long or was abandoned. */
async function load(wc: WebContents, url: string, signal: AbortSignal) {
  const loading = wc.loadURL(url).then(
    () => 'loaded' as const,
    () => 'failed' as const,
  )
  const deadline = Date.now() + LOAD_TIMEOUT_MS
  while (!signal.aborted && !wc.isDestroyed()) {
    const wait = Math.max(0, Math.min(PROBE_EVERY_MS, deadline - Date.now()))
    const result = await settleWithin(loading, wait, signal)
    if (result) return result
    if (signal.aborted || Date.now() >= deadline) return null
    if (!(await responds(wc, signal))) return 'hung' as const
  }
  return null
}

/**
 * Thumbnails take two scales (2×, and 1× for frames wider than a desktop's: `thumbScaleOf`), so
 * a board keeps a worker for each rather than remaking one whenever the next frame's width differs.
 */
const MAX_WORKERS = 2

/** Reusable workers per board, one a scale; they have no frame document while idle. */
export class OffscreenBoardRenderer implements BoardCaptureRenderer {
  /** By scale, the one used longest ago first */
  private workers = new Map<number, BrowserWindow>()
  private disposed = false

  render(
    frame: BoardFrameLayout,
    url: string,
    scale: number,
    signal: AbortSignal,
    maxHeight: number,
  ): Promise<NativeImage | null> {
    return this.withPage(frame, url, scale, signal, maxHeight, async (wc, width, height) => {
      const image = await settleWithin(
        wc.capturePage({ x: 0, y: 0, width, height }),
        (CAPTURE_TIMEOUT_MS * Math.max(2, scale)) / 2,
        signal,
      )
      return image && !image.isEmpty() ? image : null
    })
  }

  pdf(
    frame: BoardFrameLayout,
    url: string,
    signal: AbortSignal,
    maxHeight: number,
  ): Promise<Buffer | null> {
    return this.withPage(frame, url, 1, signal, maxHeight, async (wc, width, height) => {
      // pageSize is in inches; CSS is 96 px per inch.
      const bytes = await settleWithin(
        wc.printToPDF({
          pageSize: { width: width / 96, height: height / 96 },
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          printBackground: true,
          pageRanges: '1', // rounding the page size can spill a blank second page
        }),
        CAPTURE_TIMEOUT_MS,
        signal,
      )
      return bytes?.length ? bytes : null
    })
  }

  /**
   * Part of the page rasterized denser than the worker's own scale: Chromium's screenshot
   * with a clip at a scale paints only that part, sharp, rather than the whole page at the
   * higher scale (which, for a tall desktop frame at 4×, is hundreds of megabytes).
   */
  region(
    frame: BoardFrameLayout,
    url: string,
    scale: number,
    clip: SharpRequest['rect'],
    zoom: number,
    signal: AbortSignal,
    maxHeight: number,
  ): Promise<Buffer | null> {
    return this.withPage(frame, url, scale, signal, maxHeight, async (wc) => {
      // The clip is in the document's pixels; the thumbnail is of the viewport, wherever the
      // page scrolled itself to.
      const scroll = await settleWithin(
        wc.executeJavaScript('[scrollX, scrollY]').then(
          (value: unknown) => value,
          () => null,
        ),
        PROBE_TIMEOUT_MS,
        signal,
      )
      const [left, top] =
        Array.isArray(scroll) && scroll.every((n) => typeof n === 'number') ? scroll : [0, 0]
      const tools = wc.debugger
      try {
        tools.attach('1.3')
      } catch {
        return null
      }
      try {
        const shot = await settleWithin(
          tools.sendCommand('Page.captureScreenshot', {
            format: 'png',
            clip: { ...clip, x: clip.x + left, y: clip.y + top, scale: zoom },
            fromSurface: true,
          }) as Promise<{ data?: unknown }>,
          CAPTURE_TIMEOUT_MS,
          signal,
        )
        return typeof shot?.data === 'string' ? Buffer.from(shot.data, 'base64') : null
      } finally {
        if (tools.isAttached()) tools.detach()
      }
    })
  }

  /**
   * Loads the frame's page in the worker for `scale`, sized as the frame (its top `maxHeight`
   * at most), waits for it to be ready, and reads it with `capture`; then empties the worker.
   */
  private async withPage<T>(
    frame: BoardFrameLayout,
    url: string,
    scale: number,
    signal: AbortSignal,
    maxHeight: number,
    capture: (wc: WebContents, width: number, height: number) => Promise<T | null>,
  ): Promise<T | null> {
    if (this.disposed || signal.aborted) return null
    const win = this.window(scale, new URL(url).origin)
    const width = frame.width
    const height = Math.min(frame.height, maxHeight)
    win.setContentSize(width, height)
    const wc = win.webContents
    const alive = () => !this.disposed && !signal.aborted && !win.isDestroyed()
    let hung = false
    try {
      wc.startPainting()
      const loaded = await load(wc, url, signal)
      hung = loaded === 'hung'
      if (hung) throw new UnresponsiveFrameError(frame.id)
      if (loaded !== 'loaded' || !alive()) return null
      const ready = await settleWithin(
        wc.executeJavaScript(READY_SCRIPT).then(
          () => true,
          () => true,
        ),
        READY_TIMEOUT_MS,
        signal,
      )
      if (!alive()) return null
      // Loaded, then stuck: a script started by the page's load that never ends.
      hung = ready === null && !(await responds(wc, signal))
      if (hung) throw new UnresponsiveFrameError(frame.id)
      if (!alive()) return null
      const result = await capture(wc, width, height)
      return alive() ? result : null
    } finally {
      if (hung) this.kill(win)
      else if (!win.isDestroyed()) {
        wc.stopPainting()
        wc.stop()
        // Muting/stopPainting alone still leaves JS timers and animations executing.
        await settleWithin(wc.loadURL('about:blank'), 500, signal)
        if (!win.isDestroyed()) {
          wc.stopPainting()
          if (wc.getURL() !== 'about:blank') {
            win.destroy()
            this.drop(win)
          }
        }
      }
    }
  }

  /** A stuck page can't be unloaded: its renderer is ended and the next capture gets a new one. */
  private kill(win: BrowserWindow) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.forcefullyCrashRenderer()
      } catch {
        // Destroying the window ends it too, only less promptly.
      }
      win.destroy()
    }
    this.drop(win)
  }

  private drop(win: BrowserWindow) {
    for (const [scale, worker] of this.workers) if (worker === win) this.workers.delete(scale)
  }

  private window(scale: number, origin: string) {
    const existing = this.workers.get(scale)
    this.workers.delete(scale)
    if (existing && !existing.isDestroyed()) {
      this.workers.set(scale, existing)
      return existing
    }
    for (const [old, worker] of this.workers) {
      if (this.workers.size < MAX_WORKERS) break
      worker.destroy()
      this.workers.delete(old)
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
        // A frame's alert or confirm answers at once instead of showing over Gui.
        disableDialogs: true,
        contextIsolation: true,
        nodeIntegration: false,
        session: canvasSession(),
      },
    })
    this.workers.set(scale, window)
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
    for (const worker of this.workers.values()) if (!worker.isDestroyed()) worker.destroy()
    this.workers.clear()
  }
}
