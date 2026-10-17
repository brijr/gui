import { BrowserWindow, type NativeImage } from 'electron'

/**
 * Screenshots of any website, for the canvas agent to look at for reference. Each capture
 * gets its own hidden window in a throwaway session, so a site never shares cookies or
 * storage with the user's previews, and nothing it opens or downloads goes anywhere.
 */

const PARTITION = 'gui-web-capture'
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

/** http(s) only: no file://, data:, or Chromium's own pages. */
export function captureUrl(input: string): URL {
  const trimmed = input.trim()
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`)
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('Only http and https addresses can be captured.')
  return url
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

function within<T>(task: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    task.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let sessionReady = false
function prepareSession(win: BrowserWindow) {
  if (sessionReady) return
  sessionReady = true
  win.webContents.session.on('will-download', (event) => event.preventDefault())
}

export async function captureWebPage(options: WebCaptureOptions): Promise<WebCapture> {
  const target = captureUrl(options.url)
  const win = new BrowserWindow({
    show: false,
    width: options.width,
    height: options.height,
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: {
      offscreen: { deviceScaleFactor: 1 },
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: PARTITION,
    },
  })
  const wc = win.webContents
  wc.setAudioMuted(true)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Redirects and the page's own navigation stay on the web; nothing local.
  wc.on('will-navigate', (event, url) => {
    if (!/^https?:/i.test(url)) event.preventDefault()
  })
  wc.on('will-redirect', (event, url) => {
    if (!/^https?:/i.test(url)) event.preventDefault()
  })
  prepareSession(win)
  // Macs draw overlay scrollbars; a classic one would show in every capture.
  wc.on('dom-ready', () => {
    void wc.insertCSS('::-webkit-scrollbar { display: none !important; }').catch(() => undefined)
  })
  try {
    const load: { failed: string | null } = { failed: null }
    wc.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      // -3 is an aborted load, which a redirect or a client-side navigation also causes.
      if (mainFrame && code !== -3) load.failed = description || `error ${code}`
    })
    // A page that never finishes loading (analytics, streaming) is still captured as it is.
    await within(wc.loadURL(target.toString()), LOAD_TIMEOUT_MS)
    if (win.isDestroyed()) throw new Error('The capture window closed.')
    if (load.failed) throw new Error(`Couldn't load ${target}: ${load.failed}`)
    await within(wc.executeJavaScript(READY_SCRIPT), READY_TIMEOUT_MS + 500)
    await pause(SETTLE_MS)

    const pageHeight = Math.round(
      Number(await within(wc.executeJavaScript(HEIGHT_SCRIPT), 2000)) || options.height,
    )
    let height = options.height
    if (options.fullPage && pageHeight > options.height) {
      height = Math.min(pageHeight, WEB_CAPTURE_MAX_HEIGHT)
      win.setContentSize(options.width, height)
      // The taller viewport brings lazy images and scroll-triggered sections into view.
      await pause(300)
      await within(wc.executeJavaScript(READY_SCRIPT), READY_TIMEOUT_MS + 500)
      await pause(SETTLE_MS)
    }
    const image = await within(wc.capturePage({ x: 0, y: 0, width: options.width, height }), 8000)
    if (!image || image.isEmpty()) throw new Error(`Couldn't capture ${target}.`)
    return { image, url: wc.getURL(), title: wc.getTitle(), pageHeight }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
