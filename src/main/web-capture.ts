import { BrowserWindow, type NativeImage } from 'electron'
import { captureUrl } from './public-address'
import {
  closePage,
  giveBackWebSession,
  guardPage,
  isPublicWebsite,
  LOCAL_ADDRESS,
  takeWebSession,
  within,
} from './web-session'

/**
 * Screenshots of public websites, for the canvas agent to look at for reference. Each capture
 * gets a hidden window in a locked-down, in-memory session apart from the user's previews
 * (web-session.ts), wiped once the window is gone, so one site never sees another's cookies or
 * storage. The page can't open windows, launch apps or show dialogs. Captures run one at a time.
 */

const LOAD_TIMEOUT_MS = 20_000
const READY_TIMEOUT_MS = 4000
/** Late layout: cookie banners, hero animations, fonts swapping in. */
const SETTLE_MS = 600
/** Offscreen surfaces past this height fail on some GPUs; long pages are cut there. */
export const WEB_CAPTURE_MAX_HEIGHT = 12_000

export interface WebCaptureOptions {
  url: string
  /** Viewport width in CSS px */
  width: number
  /** Viewport height in CSS px */
  height: number
  fullPage: boolean
}

export interface WebCapture {
  image: NativeImage
  /** Where the page ended up, after redirects */
  url: string
  title: string
  /** The page's full height in CSS px, even when the capture was cut short */
  pageHeight: number
}

const READY_SCRIPT = `new Promise(resolve => {
  const timer = setTimeout(resolve, ${READY_TIMEOUT_MS});
  const images = [...document.images].map(image => image.complete ? null :
    new Promise(done => { image.addEventListener('load', done, { once: true }); image.addEventListener('error', done, { once: true }); }));
  Promise.all([document.fonts.ready, ...images]).then(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
  });
})`

const HEIGHT_SCRIPT = `Math.max(
  document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0,
  document.documentElement.clientHeight)`

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Captures wait their turn: one hidden window at a time. */
let queue: Promise<unknown> = Promise.resolve()
/** Captures running or waiting, across every canvas. More than this are turned away. */
const MAX_CAPTURES = 4
let captures = 0

const CLOSED = 'The canvas closed.'

/**
 * A screenshot of a public website. `signal` aborts once its canvas closes: a capture still
 * waiting never starts, and one under way stops and closes its window.
 */
export function captureWebPage(
  options: WebCaptureOptions,
  signal?: AbortSignal,
): Promise<WebCapture> {
  const target = captureUrl(options.url)
  if (signal?.aborted) return Promise.reject(new Error(CLOSED))
  if (captures >= MAX_CAPTURES)
    return Promise.reject(
      new Error('Gui is already capturing several websites. Try again once those finish.'),
    )
  captures++
  const run = queue.then(async () => {
    if (signal?.aborted) throw new Error(CLOSED)
    if (!(await isPublicWebsite(target.hostname))) throw new Error(LOCAL_ADDRESS)
    if (signal?.aborted) throw new Error(CLOSED)
    return capture(target, options, signal)
  })
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  void settled.then(() => captures--)
  queue = settled
  if (!signal) return run
  // A closed canvas's caller hears right away; its place in line is skipped when it comes up.
  return new Promise<WebCapture>((resolve, reject) => {
    const closed = () => reject(new Error(CLOSED))
    signal.addEventListener('abort', closed, { once: true })
    run.then(resolve, reject).finally(() => signal.removeEventListener('abort', closed))
  })
}

async function capture(
  target: URL,
  options: WebCaptureOptions,
  signal?: AbortSignal,
): Promise<WebCapture> {
  const web = await takeWebSession()
  const win = new BrowserWindow({
    show: false,
    width: options.width,
    height: options.height,
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: {
      offscreen: { deviceScaleFactor: 1 },
      sandbox: true,
      // A page's alert or confirm answers at once instead of showing over Gui.
      disableDialogs: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: web.ses,
    },
  })
  const wc = win.webContents
  // Closing the canvas closes the window: a load or wait under way ends there.
  const stop = () => {
    if (!win.isDestroyed()) win.destroy()
  }
  signal?.addEventListener('abort', stop, { once: true })
  const stillWanted = () => {
    if (signal?.aborted || win.isDestroyed()) throw new Error(CLOSED)
  }
  guardPage(wc)
  // Macs draw overlay scrollbars; a classic one would show in every capture.
  wc.on('dom-ready', () => {
    void wc.insertCSS('::-webkit-scrollbar { display: none !important; }').catch(() => undefined)
  })
  try {
    const load: { failed: string | null } = { failed: null }
    wc.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      // -3 is an aborted load, which a redirect or a client-side navigation also causes.
      // -20 is a request blocked above: a redirect to a local address.
      // A proxy refusal is the page's name (or a redirect's) turning out to be local.
      if (mainFrame && (code === -20 || web.proxy.refused.size > 0)) load.failed = LOCAL_ADDRESS
      else if (mainFrame && code !== -3) load.failed = description || `error ${code}`
    })
    // A page that never finishes loading (analytics, streaming) is still captured as it is.
    await within(wc.loadURL(target.toString()), LOAD_TIMEOUT_MS)
    if (signal?.aborted) throw new Error(CLOSED)
    if (win.isDestroyed()) throw new Error('The capture window closed.')
    if (load.failed) throw new Error(`Couldn't load ${target}: ${load.failed}`)
    await within(wc.executeJavaScript(READY_SCRIPT), READY_TIMEOUT_MS + 500)
    stillWanted()
    await pause(SETTLE_MS)
    stillWanted()

    const pageHeight = Math.round(
      Number(await within(wc.executeJavaScript(HEIGHT_SCRIPT), 2000)) || options.height,
    )
    let height = options.height
    if (options.fullPage && pageHeight > options.height) {
      height = Math.min(pageHeight, WEB_CAPTURE_MAX_HEIGHT)
      stillWanted()
      win.setContentSize(options.width, height)
      // The taller viewport brings lazy images and scroll-triggered sections into view.
      await pause(300)
      stillWanted()
      await within(wc.executeJavaScript(READY_SCRIPT), READY_TIMEOUT_MS + 500)
      stillWanted()
      await pause(SETTLE_MS)
      stillWanted()
    }
    const image = await within(wc.capturePage({ x: 0, y: 0, width: options.width, height }), 8000)
    stillWanted()
    if (!image || image.isEmpty()) throw new Error(`Couldn't capture ${target}.`)
    return { image, url: wc.getURL(), title: wc.getTitle(), pageHeight }
  } finally {
    signal?.removeEventListener('abort', stop)
    // Its session is used again only once the window is gone.
    await giveBackWebSession(web, await closePage(wc, stop))
  }
}
