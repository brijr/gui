import { app, type Session, session } from 'electron'
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
 * checked. Callers wipe the session (`wipeWebSession`) when they're done with it.
 */

export interface WebSession {
  ses: Session
  proxy: PublicProxy
}

/** Tests only, never in a packaged app: one made-up `.test` website on this machine. */
const standIn = standInWebsite(process.env.GUI_E2E_WEBSITE, app.isPackaged)

export const LOCAL_ADDRESS =
  'Gui only opens public websites, not addresses on this Mac or the local network.'

/** Whether a URL's host is on the open internet (or is the tests' stand-in website). */
export function isPublicWebsite(hostname: string) {
  if (standIn && hostname.toLowerCase() === standIn.host) return Promise.resolve(true)
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

const sessions = new Map<string, Promise<WebSession>>()

/** The partition's session, locked down once: Electron grants every permission by default. */
export function webSession(partition: string): Promise<WebSession> {
  if (partition.startsWith('persist:')) throw new Error('Website sessions stay in memory.')
  let locked = sessions.get(partition)
  if (!locked) {
    locked = lockDown(partition).catch((error: unknown) => {
      sessions.delete(partition)
      throw error
    })
    sessions.set(partition, locked)
  }
  return locked
}

async function lockDown(partition: string): Promise<WebSession> {
  const proxy = await startPublicProxy(
    standIn
      ? {
          resolve: (host) =>
            host === standIn.host ? Promise.resolve(['127.0.0.1']) : defaultResolve(host),
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

/**
 * Clears everything websites left: cookies, storage, service workers, cache and HTTP sign-ins.
 * False when that failed, and the session mustn't be used again.
 */
export async function wipeWebSession({ ses, proxy }: WebSession): Promise<boolean> {
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
