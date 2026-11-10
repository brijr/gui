import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  type AddressCandidate,
  findInterval,
  type PageKind,
  pickAddress,
  probePage,
  RECENT_OUTPUT_MS,
  SETTLE_MS,
  SLOW_START_MS,
} from '../src/main/app-address'
import { listenersOf } from '../src/main/ports'

const candidate = (
  port: number,
  kind: PageKind | null,
  printed: number | null = null,
  since = 0,
): AddressCandidate => ({ url: `http://localhost:${port}/`, port, printed, kind, since })

describe('picking the app among what a dev server listens on', () => {
  test('a web page wins at once, even over an API printed before it', () => {
    const api = candidate(4000, 'other', 0)
    const web = candidate(5173, 'page', 1)
    expect(pickAddress([api, web], 10)?.port).toBe(5173)
    // Found by port only, it still beats the printed API.
    expect(pickAddress([api, candidate(3000, 'page')], 10)?.port).toBe(3000)
  })

  test('a page found by port waits while a printed address may still come up', () => {
    // A framework's own worker port answers before the address it printed does.
    const worker = candidate(53123, 'page', null, 0)
    expect(pickAddress([worker], 100, true)).toBeNull()
    expect(pickAddress([worker, candidate(3000, 'page', 0, 50)], 100, true)?.port).toBe(3000)
    expect(pickAddress([worker], SETTLE_MS, true)?.port).toBe(53123)
    // Settled, a web page found by port still beats a printed API.
    expect(pickAddress([worker, candidate(4000, 'other', 0)], SETTLE_MS, true)?.port).toBe(53123)
  })

  test('among web pages, the printed one first, then the lowest port', () => {
    expect(pickAddress([candidate(3001, 'page'), candidate(3000, 'page')], 0)?.port).toBe(3000)
    expect(pickAddress([candidate(3000, 'page'), candidate(4321, 'page', 0)], 0)?.port).toBe(4321)
  })

  test('anything else waits a moment for a web page to show up', () => {
    const api = candidate(4000, 'other', 0, 1000)
    expect(pickAddress([api], 1000 + SETTLE_MS - 1)).toBeNull()
    expect(pickAddress([api], 1000 + SETTLE_MS)?.port).toBe(4000)
  })

  test('once settled, a printed address beats one found by port', () => {
    const now = SETTLE_MS
    // Next.js compiling its first page doesn't answer yet; the API printed first does.
    const api = candidate(4000, 'other', 0)
    const next = candidate(3000, 'slow', 1)
    expect(pickAddress([api, next], now)?.port).toBe(3000)
    expect(pickAddress([candidate(9229, 'other'), candidate(3000, null, 0)], now)?.port).toBe(3000)
    // Unprinted, an error page from an API beats a debugger port.
    expect(pickAddress([candidate(9229, 'other'), candidate(8080, 'error-page')], now)?.port).toBe(
      8080,
    )
  })

  test('nothing to pick', () => {
    expect(pickAddress([], 100_000)).toBeNull()
  })
})

describe('how often a starting server is looked for', () => {
  // Each look runs `ps` and `lsof`: how many of them a minute of waiting costs.
  const looksIn = (from: number, ms: number, quiet: (at: number) => number, listening = false) => {
    let looks = 0
    for (let at = from; at < from + ms; at += findInterval(at, quiet(at), listening)) looks++
    return looks
  }
  const silent = (at: number) => at

  test('a normal start is looked at several times a second', () => {
    expect(findInterval(0, 0, false)).toBeLessThanOrEqual(500)
    expect(findInterval(SLOW_START_MS, SLOW_START_MS, false)).toBeLessThanOrEqual(500)
  })

  test('a script that never opens a port and prints nothing is looked at rarely', () => {
    // 40 looks a minute before; a build watcher or a waiting prompt goes on for hours.
    expect(looksIn(SLOW_START_MS + 1, 60_000, silent)).toBeLessThanOrEqual(4)
    expect(findInterval(3_600_000, 3_600_000, false)).toBeGreaterThanOrEqual(15_000)
    expect(findInterval(3_600_000, 3_600_000, false)).toBeLessThanOrEqual(30_000)
  })

  test('a server that printed lately is looked at as often as before', () => {
    // The port usually opens with the output or just after it.
    expect(findInterval(SLOW_START_MS + 1, 0, false)).toBe(1500)
    expect(findInterval(600_000, RECENT_OUTPUT_MS - 1, false)).toBe(1500)
    expect(findInterval(600_000, RECENT_OUTPUT_MS, false)).toBeGreaterThanOrEqual(15_000)
    // The clock can read a moment before the output it's compared with.
    expect(findInterval(600_000, -5, false)).toBe(1500)
  })

  test('with something listening it never slows: an address is picked within moments', () => {
    expect(findInterval(600_000, 600_000, true)).toBe(1500)
    expect(looksIn(SLOW_START_MS + 1, SETTLE_MS * 2, silent, true)).toBeGreaterThanOrEqual(3)
  })
})

describe('asking what a port serves', () => {
  const servers: Server[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })

  async function serve(handler: Parameters<typeof createServer>[1]) {
    const server = createServer(handler)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return (server.address() as AddressInfo).port
  }

  test('HTML is a page, JSON is not, a redirect is, an HTML error is an error page', async () => {
    const html = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end('<h1>hi</h1>')
    })
    const json = await serve((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end('{}')
    })
    const redirect = await serve((_req, res) => {
      res.writeHead(302, { location: '/login' }).end()
    })
    const missing = await serve((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/html' }).end('Cannot GET /')
    })
    const at = (port: number) => probePage(`http://localhost:${port}/`, '127.0.0.1')
    expect(await at(html)).toBe('page')
    expect(await at(json)).toBe('other')
    expect(await at(redirect)).toBe('page')
    expect(await at(missing)).toBe('error-page')
  })

  test('the Host header names the printed address', async () => {
    let host = ''
    const port = await serve((req, res) => {
      host = req.headers.host ?? ''
      res.end()
    })
    await probePage(`http://localhost:${port}/`, '127.0.0.1')
    expect(host).toBe(`localhost:${port}`)
  })

  test("a process's own listeners are found by port", async () => {
    const port = await serve((_req, res) => res.end())
    const listeners = await listenersOf(process.pid)
    expect(listeners?.some((l) => l.port === port && l.pid === process.pid)).toBe(true)
  })
})
