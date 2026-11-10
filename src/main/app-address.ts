import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

/**
 * What answers at an address, as a GET of `/` finds it:
 * - `page`: a web page (HTML, or a redirect to one), the app to preview
 * - `error-page`: HTML, but an error (an API's "Cannot GET /")
 * - `slow`: no answer yet (a dev server compiling the page on its first request)
 * - `other`: JSON, text, or not HTTP at all (an API, a websocket, a debugger)
 */
export type PageKind = 'page' | 'error-page' | 'slow' | 'other'

/** An address the dev server printed, or a port it's listening on. */
export interface AddressCandidate {
  url: string
  port: number
  /** Its place among the addresses the server printed; null for a port it never printed */
  printed: number | null
  kind: PageKind | null
  /** When it was first seen */
  since: number
}

/** How long a page that isn't clearly a web page has to wait for a better one to appear. */
export const SETTLE_MS = 2500

const KIND_RANK: Record<PageKind, number> = { page: 3, slow: 2, 'error-page': 1, other: 0 }

/**
 * The address to preview, or null to keep waiting. A web page the server printed wins at
 * once (the first one it printed), and so does one found by port when it printed nothing.
 * Anything else must have been there for SETTLE_MS, so a web page that starts a moment
 * after its API can still win, and a printed address still coming up isn't passed over for
 * another port: then a web page beats anything else, and a printed address one found by port.
 */
export function pickAddress(
  candidates: AddressCandidate[],
  now: number,
  printedAny = false,
): AddressCandidate | null {
  const order = (a: AddressCandidate, b: AddressCandidate) =>
    (a.printed ?? Number.POSITIVE_INFINITY) - (b.printed ?? Number.POSITIVE_INFINITY) ||
    a.port - b.port
  const [page] = candidates.filter((c) => c.kind === 'page').sort(order)
  if (page && (page.printed !== null || !printedAny)) return page
  if (candidates.length === 0) return null
  if (now - Math.min(...candidates.map((c) => c.since)) < SETTLE_MS) return null
  const score = (c: AddressCandidate) =>
    (c.kind === 'page' ? 100 : 0) + (c.printed !== null ? 10 : 0) + KIND_RANK[c.kind ?? 'slow']
  return [...candidates].sort((a, b) => score(b) - score(a) || order(a, b))[0] ?? null
}

/** Most dev servers are up well within this; past it, the UI offers a way forward. */
export const SLOW_START_MS = 30_000
/** Output this recent keeps the looking frequent: it almost always comes before or with the port. */
export const RECENT_OUTPUT_MS = 10_000
const FIND_INTERVAL_MS = 400
const FIND_INTERVAL_LATER_MS = 1500
const FIND_INTERVAL_QUIET_MS = 20_000

/**
 * How long until a starting server's ports are looked at again; each look runs `ps` and
 * `lsof`. Often while most servers come up. Past SLOW_START_MS, every second or two while
 * something of the server's is listening or it printed in the last RECENT_OUTPUT_MS (`quiet`
 * is how long ago it last did), and otherwise rarely: a script that never opens a port (a
 * build watcher, a prompt waiting for an answer) is looked at for as long as it runs.
 */
export function findInterval(elapsed: number, quiet: number, listening: boolean) {
  if (elapsed <= SLOW_START_MS) return FIND_INTERVAL_MS
  return listening || quiet < RECENT_OUTPUT_MS ? FIND_INTERVAL_LATER_MS : FIND_INTERVAL_QUIET_MS
}

/** How long a GET of `/` gets to answer before the address counts as `slow`. */
const PROBE_TIMEOUT_MS = 4000

/**
 * GETs `/` at `url` from `host` (the loopback address its listener is on) and says what
 * answered. Only the status and headers are read.
 */
export function probePage(url: string, host: string): Promise<PageKind> {
  const parsed = new URL(url)
  const request = parsed.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve) => {
    let settled = false
    const done = (kind: PageKind) => {
      if (settled) return
      settled = true
      req.destroy()
      resolve(kind)
    }
    const req = request({
      host: host.replace(/^\[|\]$/g, ''),
      port: portOf(url),
      path: '/',
      method: 'GET',
      // Dev servers check the Host header (Vite's allowedHosts): the address it printed.
      headers: { host: parsed.host, accept: 'text/html,*/*;q=0.8' },
      // A dev server's own certificate.
      rejectUnauthorized: false,
      timeout: PROBE_TIMEOUT_MS,
    })
    req.on('response', (res) => {
      const status = res.statusCode ?? 0
      const type = String(res.headers['content-type'] ?? '').toLowerCase()
      const html = type.includes('text/html') || type.includes('application/xhtml')
      if (status >= 300 && status < 400 && res.headers.location) done('page')
      else if (html) done(status < 400 ? 'page' : 'error-page')
      else done('other')
    })
    req.on('timeout', () => done('slow'))
    req.on('error', () => done('other'))
    req.end()
  })
}

/** The explicit port, or the protocol's default. */
export function portOf(url: string) {
  const parsed = new URL(url)
  return Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
}
