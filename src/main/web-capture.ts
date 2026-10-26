import { BrowserWindow, type NativeImage, type Session, session } from 'electron'
import { captureUrl, isLocalName, isPrivateIp, isPublicHost } from './public-address'
import { type PublicProxy, startPublicProxy } from './public-proxy'

/**
 * Screenshots of public websites, for the canvas agent to look at for reference. Each capture
 * gets a hidden window in an in-memory session apart from the user's previews; captures run
 * one at a time and the session is wiped between them, so one site never sees another's
 * cookies or storage. The page gets no permissions (clipboard, camera, notifications...),
 * can't download, open windows or launch apps, and can't reach this machine or the local
 * network: every connection goes through a proxy (public-proxy.ts) that looks names up itself
 * and connects only to the public address it checked.
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

const LOCAL_ADDRESS = "Gui doesn't capture this machine or the local network, only public websites."

/**
 * Requests the page may make: http(s) and websockets, and in-page data. Addresses that are
 * plainly local are stopped here; the proxy checks every name's address as it connects.
 */
function allowedRequest(url: string) {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return true
  if (!/^(https?|wss?):$/.test(parsed.protocol)) return false
  return !isPrivateIp(parsed.hostname) && !isLocalName(parsed.hostname)
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

let captureSession: Promise<{ ses: Session; proxy: PublicProxy }> | null = null

/** The capture partition, locked down once: Electron grants every permission by default. */
function lockedSession() {
  captureSession ??= lockDown().catch((error: unknown) => {
    captureSession = null
    throw error
  })
  return captureSession
}

async function lockDown() {
  const proxy = await startPublicProxy()
  const ses = session.fromPartition(PARTITION)
  // Chromium sends a SOCKS5 proxy the name, not an address it looked up. `<-loopback>` takes
  // away the bypass Chromium otherwise keeps for localhost.
  await ses.setProxy({
    proxyRules: `socks5://127.0.0.1:${proxy.port}`,
    proxyBypassRules: '<-loopback>',
  })
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
  // Every request, the page's own and each redirect's, from any frame.
  ses.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !allowedRequest(details.url) }),
  )
  return { ses, proxy }
}

/** Captures wait their turn: each has the session to itself, wiped once it's done. */
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
    if (!(await isPublicHost(target.hostname))) throw new Error(LOCAL_ADDRESS)
    const { ses, proxy } = await lockedSession()
    if (signal?.aborted) throw new Error(CLOSED)
    proxy.refused.clear()
    try {
      return await capture(target, options, ses, proxy, signal)
    } finally {
      await Promise.all([ses.clearStorageData(), ses.clearCache()]).catch(() => undefined)
    }
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
  ses: Session,
  proxy: PublicProxy,
  signal?: AbortSignal,
): Promise<WebCapture> {
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
      session: ses,
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
  wc.setAudioMuted(true)
  // WebRTC's UDP would go around the proxy: it's left only what the proxy carries (nothing).
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Navigation in any frame, and redirects, stay on the web: no app protocols or local files.
  wc.on('will-frame-navigate', (event) => {
    if (!/^https?:/i.test(event.url)) event.preventDefault()
  })
  wc.on('will-redirect', (event, url) => {
    if (!/^https?:/i.test(url)) event.preventDefault()
  })
  wc.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault()
    callback('')
  })
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
      if (mainFrame && (code === -20 || proxy.refused.size > 0)) load.failed = LOCAL_ADDRESS
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
    stop()
  }
}
