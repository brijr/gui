import { connect, createServer, isIP, type Socket } from 'node:net'
import { defaultResolve, isLocalName, isPrivateIp } from './public-address'

/**
 * A SOCKS5 proxy on loopback through which a session reaches only the public internet.
 * Chromium hands a SOCKS5 proxy the host's name, so the proxy is what looks it up: it checks
 * the address and connects to that same address. A name whose DNS answer changes between a
 * check and the connection (DNS rebinding) can't reach this machine or the local network.
 */

/** SOCKS5 reply codes (RFC 1928) */
const REPLY = {
  ok: 0x00,
  failure: 0x01,
  notAllowed: 0x02,
  hostUnreachable: 0x04,
  refused: 0x05,
  commandUnsupported: 0x07,
  addressUnsupported: 0x08,
} as const
/** A client that hasn't finished asking where to connect by now is dropped. */
const HANDSHAKE_MS = 15_000
/** A request longer than this isn't SOCKS5 (a name is at most 255 bytes). */
const MAX_REQUEST = 600

export interface PublicProxyOptions {
  /** Every address a name has */
  resolve?: (host: string) => Promise<string[]>
  /** Whether an address (and port) may be connected to; public addresses by default */
  allowed?: (ip: string, port: number) => boolean
}

export interface PublicProxy {
  port: number
  /** Hosts refused since the last `clearRefused`, to tell the user why a page didn't load */
  refused: Set<string>
  /** Stops listening and ends every connection it carries */
  close(): Promise<void>
}

function reply(socket: Socket, code: number) {
  if (socket.destroyed) return
  // Bound address: none worth telling (0.0.0.0:0), as most proxies answer.
  socket.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
  if (code !== REPLY.ok) socket.end()
}

interface Destination {
  host: string
  /** Set when the client gave an address rather than a name */
  literal: boolean
  port: number
}

/** The CONNECT request's destination, or a reply code when it's malformed; null for more bytes. */
function readRequest(buffer: Buffer): { at: Destination; length: number } | number | null {
  if (buffer.length < 5) return null
  if (buffer[0] !== 0x05) return REPLY.failure
  if (buffer[1] !== 0x01) return REPLY.commandUnsupported
  const type = buffer[3]
  let host: string
  let offset: number
  if (type === 0x01) {
    if (buffer.length < 10) return null
    host = [...buffer.subarray(4, 8)].join('.')
    offset = 8
  } else if (type === 0x03) {
    const length = buffer[4] ?? 0
    if (buffer.length < 5 + length + 2) return null
    host = buffer.subarray(5, 5 + length).toString('latin1')
    offset = 5 + length
  } else if (type === 0x04) {
    if (buffer.length < 22) return null
    const parts: string[] = []
    for (let i = 4; i < 20; i += 2) parts.push(buffer.readUInt16BE(i).toString(16))
    host = parts.join(':')
    offset = 20
  } else return REPLY.addressUnsupported
  return {
    at: { host, literal: type !== 0x03, port: buffer.readUInt16BE(offset) },
    length: offset + 2,
  }
}

export async function startPublicProxy(options: PublicProxyOptions = {}): Promise<PublicProxy> {
  const resolve = options.resolve ?? defaultResolve
  const allowed = options.allowed ?? ((ip: string, _port: number) => !isPrivateIp(ip))
  const refused = new Set<string>()

  /** The one address to connect to, or why not. */
  const addressFor = async ({ host, literal, port }: Destination): Promise<string | number> => {
    if (literal) return allowed(host, port) ? host : REPLY.notAllowed
    const name = host.toLowerCase()
    if (isIP(name)) return allowed(name, port) ? name : REPLY.notAllowed
    if (isLocalName(name)) return REPLY.notAllowed
    const addresses = await resolve(name).catch(() => [] as string[])
    if (!addresses.length) return REPLY.hostUnreachable
    // Any private answer refuses the name: which one the connection gets isn't ours to pick.
    if (!addresses.every((address) => allowed(address, port))) return REPLY.notAllowed
    return addresses[0] ?? REPLY.hostUnreachable
  }

  const open = new Set<Socket>()
  const server = createServer((client) => {
    open.add(client)
    client.once('close', () => open.delete(client))
    client.setTimeout(HANDSHAKE_MS, () => client.destroy())
    client.on('error', () => client.destroy())
    let buffer = Buffer.alloc(0)
    let stage: 'greeting' | 'request' | 'connecting' = 'greeting'
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_REQUEST) {
        client.destroy()
        return
      }
      if (stage === 'greeting') {
        if (buffer.length < 2) return
        const methods = buffer[1] ?? 0
        if (buffer.length < 2 + methods) return
        const offered = buffer.subarray(2, 2 + methods)
        buffer = buffer.subarray(2 + methods)
        // No authentication: it only listens on loopback, and reaches only what anyone can.
        if (!offered.includes(0x00)) {
          client.end(Buffer.from([0x05, 0xff]))
          return
        }
        client.write(Buffer.from([0x05, 0x00]))
        stage = 'request'
      }
      if (stage !== 'request') return
      const request = readRequest(buffer)
      if (request === null) return
      if (typeof request === 'number') {
        reply(client, request)
        return
      }
      stage = 'connecting'
      client.off('data', onData)
      client.pause()
      const early = buffer.subarray(request.length)
      void addressFor(request.at).then((address) => {
        if (typeof address === 'number') {
          if (address === REPLY.notAllowed) refused.add(request.at.host)
          reply(client, address)
          return
        }
        const upstream = connect({ host: address, port: request.at.port })
        upstream.setTimeout(HANDSHAKE_MS, () => upstream.destroy())
        upstream.once('connect', () => {
          upstream.setTimeout(0)
          client.setTimeout(0)
          reply(client, REPLY.ok)
          if (early.length) upstream.write(early)
          client.pipe(upstream)
          upstream.pipe(client)
          client.resume()
        })
        upstream.on('error', () => {
          if (upstream.connecting) reply(client, REPLY.refused)
          else client.destroy()
        })
        upstream.on('close', () => client.destroy())
        client.on('close', () => upstream.destroy())
      })
    }
    client.on('data', onData)
  })
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => done())
  })
  // It never keeps the app from quitting.
  server.unref()
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    port,
    refused,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done())
        // A client's close ends its upstream too.
        for (const socket of open) socket.destroy()
      }),
  }
}
