import { app, type Session, session, type WebContents } from 'electron'
import {
  defaultResolve,
  isLocalName,
  isPrivateIp,
  isPublicHost,
  standInWebsite,
} from './public-address'
import { type PublicProxy, startPublicProxy } from './public-proxy'

/**
 * Browser sessions for public websites the agent looks at: canvas_screenshot_url's hidden
 * captures (web-capture.ts) and the websites it opens in the preview (website.ts). Each is
 * in memory (no `persist:` partition), apart from the user's previews and anything they signed
 * into, so a website never sees their cookies or storage. The page gets no permissions, can't
 * download or reach this machine or the local network: every connection goes through a proxy
 * (public-proxy.ts) that looks names up itself and connects only to the public address it
 * checked. Each session has its own proxy, so what it refused (`refused`) is that session's.
 *
 * QUIC never goes around the proxy: Chromium uses QUIC only for direct connections, and
 * WebTransport fails outright behind a proxy. WebRTC's UDP is limited per page (`guardPage`).
 *
 * A session is used by one page at a time (`takeWebSession`) and wiped once that page is gone.
 */

export interface WebSession {
  ses: Session
  proxy: PublicProxy
}

/** Tests only, never in a packaged app: one made-up `.test` website on this machine. */
const standIn = standInWebsite(process.env.GUI_E2E_WEBSITE, app.isPackaged)
/**
 * Tests only, with the stand-in: `slow.` before its name answers this late, as a slow DNS
 * server would, so tests can act while a website is still being checked.
 */
const STAND_IN_SLOW_MS = 3000

export const LOCAL_ADDRESS =
  'Gui only opens public websites, not addresses on this Mac or the local network.'

const CLOSE_TIMEOUT_MS = 3000

/** The task's result, or null when it fails or takes longer than `ms`. */
export function within<T>(task: Promise<T>, ms: number): Promise<T | null> {
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

/** The stand-in's own name, or its slow one; null for any other. */
function standInName(hostname: string) {
  if (!standIn) return null
  const name = hostname.toLowerCase()
  if (name === standIn.host) return 'fast'
  if (name === `slow.${standIn.host}`) return 'slow'
  return null
}

/** Whether a URL's host is on the open internet (or is the tests' stand-in website). */
export function isPublicWebsite(hostname: string) {
  const name = standInName(hostname)
  if (name === 'fast') return Promise.resolve(true)
  if (name === 'slow')
    return new Promise<boolean>((resolve) => setTimeout(() => resolve(true), STAND_IN_SLOW_MS))
  return isPublicHost(hostname)
}

/**
 * Requests a page may make: http(s) and websockets, and in-page data. Addresses that are
 * plainly local are stopped here; the proxy checks every name's address as it connects. A
 * page's own form posts (a navigation that sends data) are stopped too: nothing the agent does
 * on a website signs up, buys or sends a message through a plain form.
 */
export function allowedRequest(url: string, method = 'GET', resourceType = 'other') {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') return true
  if (!/^(https?|wss?):$/.test(parsed.protocol)) return false
  if (method !== 'GET' && (resourceType === 'mainFrame' || resourceType === 'subFrame'))
    return false
  return !isPrivateIp(parsed.hostname) && !isLocalName(parsed.hostname)
}

export const isWeb = (url: string) => /^https?:/i.test(url)

/** Where a frame may go: the web, or an empty or inline (srcdoc) frame of the page's own. */
const framePlace = (url: string) => isWeb(url) || /^about:(blank|srcdoc)(?:[?#]|$)/i.test(url)

/**
 * What every page in these sessions gets: muted, WebRTC kept to the proxy (which carries no
 * UDP), navigation in any frame and redirects kept on the web (no app protocols or local
 * files), no Bluetooth, and no new windows: `openWindow` gets a web address one asked for.
 */
export function guardPage(wc: WebContents, openWindow?: (url: string) => void) {
  wc.setAudioMuted(true)
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  wc.setWindowOpenHandler(({ url }) => {
    if (isWeb(url)) openWindow?.(url)
    return { action: 'deny' }
  })
  wc.on('will-frame-navigate', (event) => {
    if (!framePlace(event.url)) event.preventDefault()
  })
  wc.on('will-redirect', (event, url) => {
    if (!isWeb(url)) event.preventDefault()
  })
  wc.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault()
    callback('')
  })
}

/** Closes a page (`close`) and waits for it to be gone; false when it's still there. */
export async function closePage(wc: WebContents, close: () => void): Promise<boolean> {
  if (wc.isDestroyed()) return true
  const destroyed = new Promise<void>((resolve) => wc.once('destroyed', () => resolve()))
  close()
  await within(destroyed, CLOSE_TIMEOUT_MS)
  return wc.isDestroyed()
}

/** Wiped sessions no page uses. Electron never frees a session, so a used one is reused. */
const idle: WebSession[] = []
let made = 0

/** A wiped session for one page; `giveBackWebSession` once that page is gone. */
export async function takeWebSession(): Promise<WebSession> {
  const web = idle.pop() ?? (await lockDown(`gui-website-${++made}`))
  // Already wiped when it was given back; again, in case anything lingered.
  if (await wipe(web)) return web
  await web.proxy.close()
  throw new Error("Couldn't start a fresh browser session.")
}

/**
 * Its page closed (`pageGone`) and the session wiped, it's used again. A page that's still
 * there, or a wipe that failed, retires the session: its proxy closes, so nothing in it reaches
 * the web again, and it's never handed out.
 */
export async function giveBackWebSession(web: WebSession, pageGone: boolean) {
  if (pageGone && (await wipe(web))) idle.push(web)
  else await web.proxy.close()
}

/** A partition's session, locked down: Electron grants every permission by default. */
async function lockDown(partition: string): Promise<WebSession> {
  const proxy = await startPublicProxy(
    standIn
      ? {
          resolve: (host) =>
            standInName(host) ? Promise.resolve(['127.0.0.1']) : defaultResolve(host),
          allowed: (ip, port) => !isPrivateIp(ip) || (ip === '127.0.0.1' && port === standIn.port),
        }
      : {},
  )
  const ses = session.fromPartition(partition)
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
    callback({ cancel: !allowedRequest(details.url, details.method, details.resourceType) }),
  )
  return { ses, proxy }
}

/** Clears everything websites left: cookies, storage, service workers, cache and HTTP sign-ins. */
async function wipe({ ses, proxy }: WebSession): Promise<boolean> {
  proxy.refused.clear()
  try {
    await Promise.all([
      ses.clearStorageData(),
      ses.clearCache(),
      ses.clearAuthCache(),
      ses.clearHostResolverCache(),
    ])
    return true
  } catch (error) {
    console.error('[gui] could not clear a website session', error)
    return false
  }
}
