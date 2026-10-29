import { afterAll, expect, test } from 'bun:test'
import { connect, createServer, type Server } from 'node:net'
import { type PublicProxy, startPublicProxy } from '../src/main/public-proxy'

const closers: (() => Promise<void>)[] = []
afterAll(async () => {
  await Promise.all(closers.map((close) => close()))
})

async function proxy(options: Parameters<typeof startPublicProxy>[0]): Promise<PublicProxy> {
  const started = await startPublicProxy(options)
  closers.push(() => started.close())
  return started
}

/** An echo server on loopback: what a connection reached, if it reached anything. */
async function echo(): Promise<{ port: number; connections: () => number }> {
  let count = 0
  const server: Server = createServer((socket) => {
    count++
    socket.pipe(socket)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  closers.push(() => new Promise<void>((done) => server.close(() => done())))
  const address = server.address()
  return {
    port: typeof address === 'object' && address ? address.port : 0,
    connections: () => count,
  }
}

/** A SOCKS5 CONNECT by name (or by IPv4 address), then `payload` through it if it's allowed. */
function socks(port: number, host: string, target: number, payload = 'ping') {
  return new Promise<{ code: number; echoed: string }>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let stage = 0
    let received = Buffer.alloc(0)
    let code = -1
    socket.on('error', reject)
    socket.on('close', () => resolve({ code, echoed: '' }))
    socket.on('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])))
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk])
      if (stage === 0 && received.length >= 2) {
        received = received.subarray(2)
        stage = 1
        const v4 = /^\d+\.\d+\.\d+\.\d+$/.test(host)
        const address = v4
          ? Buffer.from([0x01, ...host.split('.').map(Number)])
          : Buffer.concat([Buffer.from([0x03, host.length]), Buffer.from(host, 'latin1')])
        const portBytes = Buffer.alloc(2)
        portBytes.writeUInt16BE(target)
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), address, portBytes]))
      }
      if (stage === 1 && received.length >= 10) {
        code = received[1] ?? -1
        received = received.subarray(10)
        stage = 2
        if (code === 0) socket.write(payload)
      }
      if (stage === 2 && received.length >= payload.length) {
        resolve({ code, echoed: received.toString() })
        socket.destroy()
      }
    })
  })
}

test('a name that resolves to this machine is refused, and nothing is reached', async () => {
  const server = await echo()
  const started = await proxy({ resolve: async () => ['127.0.0.1'] })
  const { code } = await socks(started.port, 'rebind.example', server.port)
  expect(code).toBe(0x02)
  expect(server.connections()).toBe(0)
  expect([...started.refused]).toEqual(['rebind.example'])
})

test('the address checked is the one connected to: the name is looked up once', async () => {
  const server = await echo()
  const lookups: string[] = []
  // Stands in for a public address: allowed is told 127.0.0.1 is fine for this test.
  const started = await proxy({
    resolve: async (host) => {
      lookups.push(host)
      return ['127.0.0.1']
    },
    allowed: (ip) => ip === '127.0.0.1',
  })
  const result = await socks(started.port, 'site.example', server.port)
  expect(result).toEqual({ code: 0x00, echoed: 'ping' })
  expect(lookups).toEqual(['site.example'])
  expect(server.connections()).toBe(1)
})

test('local names and addresses are refused without looking anything up', async () => {
  const server = await echo()
  const lookups: string[] = []
  const started = await proxy({
    resolve: async (host) => {
      lookups.push(host)
      return ['93.184.215.14']
    },
  })
  for (const host of ['localhost', 'printer.local', '10.0.0.1', '127.0.0.1'])
    expect((await socks(started.port, host, server.port)).code).toBe(0x02)
  expect(lookups).toEqual([])
  expect(server.connections()).toBe(0)
})

test('a name with any private answer is refused, whichever one a connection would get', async () => {
  const server = await echo()
  const started = await proxy({ resolve: async () => ['93.184.215.14', '192.168.1.1'] })
  expect((await socks(started.port, 'mixed.example', server.port)).code).toBe(0x02)
  expect(server.connections()).toBe(0)
})

test('allowed is told the port, so one stand-in website reaches only its own port', async () => {
  const site = await echo()
  const other = await echo()
  const started = await proxy({
    resolve: async () => ['127.0.0.1'],
    allowed: (ip, port) => ip === '127.0.0.1' && port === site.port,
  })
  expect((await socks(started.port, 'shop.gui-e2e.test', site.port)).code).toBe(0x00)
  expect((await socks(started.port, 'shop.gui-e2e.test', other.port)).code).toBe(0x02)
  expect(other.connections()).toBe(0)
})
