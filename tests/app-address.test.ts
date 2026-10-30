import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  type AddressCandidate,
  type PageKind,
  pickAddress,
  probePage,
  SETTLE_MS,
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
