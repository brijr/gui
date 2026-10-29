import { lookup, Resolver } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * Whether an address is on the open internet, for fetching pages on the agent's behalf:
 * never this machine, the local network, link-local (cloud metadata) or other reserved ranges.
 */

function ipv4Private(ip: string) {
  const [a = 0, b = 0] = ip.split('.').map(Number)
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  )
}

/** An IPv6 address as its eight 16-bit groups, `::` and a trailing IPv4 part expanded. */
function ipv6Groups(address: string): number[] | null {
  let text = address
  const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (v4?.[1]) {
    const [a = 0, b = 0, c = 0, d = 0] = v4[1].split('.').map(Number)
    text = `${text.slice(0, -v4[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head = '', tail, extra] = text.split('::')
  if (extra !== undefined) return null
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const missing = 8 - left.length - right.length
  if (tail === undefined ? missing !== 0 : missing < 0) return null
  const groups = [...left, ...Array<string>(Math.max(0, missing)).fill('0'), ...right].map((part) =>
    Number.parseInt(part, 16),
  )
  return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff)
    ? groups
    : null
}

function ipv6Private(ip: string) {
  const groups = ipv6Groups(
    ip
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/%.*$/, ''),
  )
  if (!groups) return true
  const [g0 = 0, g1 = 0, , , , g5 = 0, g6 = 0, g7 = 0] = groups
  const v4 = `${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`
  const zeros = (count: number) => groups.slice(0, count).every((group) => group === 0)
  if (zeros(8) || (zeros(7) && g7 === 1)) return true // unspecified, loopback
  if (zeros(5) && g5 === 0xffff) return ipv4Private(v4) // IPv4-mapped
  if (zeros(6)) return ipv4Private(v4) // IPv4-compatible
  if (g0 === 0x2002)
    return ipv4Private(`${g1 >> 8}.${g1 & 255}.${(groups[2] ?? 0) >> 8}.${(groups[2] ?? 0) & 255}`) // 6to4
  return (
    (g0 & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (g0 & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (g0 & 0xff00) === 0xff00 || // multicast
    (g0 === 0x64 && g1 === 0xff9b) || // NAT64, which reaches IPv4 private ranges
    (g0 === 0x2001 && g1 === 0) || // Teredo, which tunnels to any IPv4 address
    (g0 === 0x2001 && g1 === 0xdb8) // documentation
  )
}

/** An IP literal (v4 or v6, brackets allowed) that isn't publicly routable. */
export function isPrivateIp(ip: string) {
  const bare = ip.replace(/^\[|\]$/g, '')
  const version = isIP(bare)
  if (version === 4) return ipv4Private(bare)
  if (version === 6) return ipv6Private(bare)
  return false
}

/** Names that always mean this machine or the local network, whatever DNS says. */
export function isLocalName(host: string) {
  const name = host.toLowerCase().replace(/\.$/, '')
  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name.endsWith('.local') ||
    name.endsWith('.internal') ||
    name.endsWith('.home.arpa') ||
    !name.includes('.')
  )
}

/**
 * True when `host` (a URL's hostname) resolves only to public addresses. A name that fails to
 * resolve counts as not public: the page couldn't load it anyway.
 */
export async function isPublicHost(
  host: string,
  resolve: (host: string) => Promise<string[]> = defaultResolve,
): Promise<boolean> {
  const bare = host.replace(/^\[|\]$/g, '')
  if (isIP(bare)) return !isPrivateIp(bare)
  if (isLocalName(bare)) return false
  const addresses = await resolve(bare).catch(() => [] as string[])
  return addresses.length > 0 && addresses.every((address) => !isPrivateIp(address))
}

/** How long a name's addresses are reused: a page asks for the same few names many times. */
const DNS_TTL_MS = 60_000
const DNS_CACHE_MAX = 500
const resolver = new Resolver({ timeout: 2500, tries: 2 })
const dnsCache = new Map<string, { at: number; addresses: Promise<string[]> }>()

/**
 * Asks DNS directly, apart from the system's getaddrinfo. That one runs on libuv's small
 * thread pool, where a page's dozens of lookups made the app's file reads and writes wait.
 * A name DNS can't answer (one only the system knows) falls back to the system.
 */
async function resolveFresh(host: string) {
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)])
  const found = [
    ...(v4.status === 'fulfilled' ? v4.value : []),
    ...(v6.status === 'fulfilled' ? v6.value : []),
  ]
  if (found.length) return found
  const system = await lookup(host, { all: true, verbatim: true })
  return system.map((entry) => entry.address)
}

/** Every address a name has, reused for a minute. Failures aren't kept. */
export function defaultResolve(host: string): Promise<string[]> {
  const name = host.toLowerCase().replace(/\.$/, '')
  const now = Date.now()
  const cached = dnsCache.get(name)
  if (cached && now - cached.at < DNS_TTL_MS) return cached.addresses
  const addresses = resolveFresh(name)
  const entry = { at: now, addresses }
  dnsCache.delete(name)
  dnsCache.set(name, entry)
  if (dnsCache.size > DNS_CACHE_MAX) {
    const oldest = dnsCache.keys().next().value
    if (oldest !== undefined) dnsCache.delete(oldest)
  }
  const forget = () => {
    if (dnsCache.get(name) === entry) dnsCache.delete(name)
  }
  addresses.then((found) => found.length || forget(), forget)
  return addresses
}

/** http(s) only: no file://, data:, or Chromium's own pages. A bare `host:port` is https. */
export function captureUrl(input: string): URL {
  const trimmed = input.trim()
  const schemed = /^[a-z][a-z\d+.-]*:/i.test(trimmed) && !/^[^:/?#]+:\d+(?:[/?#]|$)/.test(trimmed)
  const url = new URL(schemed ? trimmed : `https://${trimmed}`)
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('Only http and https addresses can be captured.')
  return url
}

/** A made-up website on this machine that end-to-end tests browse (`standInWebsite`). */
export interface StandInWebsite {
  /** A name under `.test`, which is reserved and never resolves on the internet */
  host: string
  /** The port on 127.0.0.1 that serves it */
  port: number
}

/**
 * Tests only: `GUI_E2E_WEBSITE="shop.gui-e2e.test=4321"` lets the agent's websites reach one
 * made-up `.test` name, served on this machine at that port, as if it were public. Ignored in a
 * packaged app, so it never loosens what a user's Gui can reach.
 */
export function standInWebsite(
  value: string | undefined,
  packaged: boolean,
): StandInWebsite | null {
  if (packaged || !value) return null
  const match = /^([a-z\d-]+(?:\.[a-z\d-]+)*\.test)=(\d{1,5})$/.exec(value.trim().toLowerCase())
  const port = Number(match?.[2])
  if (!match?.[1] || !Number.isInteger(port) || port < 1 || port > 65_535) return null
  return { host: match[1], port }
}

/**
 * Where preview_navigate's input goes. A path (`/pricing`, `pricing`) or an address on the
 * user's app (`appOrigin`): the app. A full http(s) address anywhere else: a website, which
 * must also turn out to be public before it opens. Other schemes are refused.
 */
export function navigationTarget(
  input: string,
  appOrigin: string | null,
): { kind: 'app' | 'website'; url: URL } {
  const trimmed = input.trim()
  const schemed = /^[a-z][a-z\d+.-]*:/i.test(trimmed) || trimmed.startsWith('//')
  if (!schemed && !appOrigin) throw new Error('The dev server is not running')
  let url: URL
  try {
    url = new URL(trimmed, appOrigin ?? undefined)
  } catch {
    throw new Error(`${trimmed} isn't an address`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('Only http and https addresses can be opened.')
  if (appOrigin && url.origin === new URL(appOrigin).origin) return { kind: 'app', url }
  if (!schemed) throw new Error('Only paths on the dev server can be opened')
  return { kind: 'website', url }
}
