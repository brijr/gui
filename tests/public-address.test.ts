import { expect, test } from 'bun:test'
import { captureUrl, isPrivateIp, isPublicHost } from '../src/main/public-address'

test('private, loopback, link-local and reserved addresses are not public', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '[::1]',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:a00:1',
    '64:ff9b::a00:1',
    '0:0:0:0:0:0:0:1',
    '0:0:0:0:0:ffff:7f00:1',
    '0:0:0:0:0:0:a00:1',
    '2002:c0a8:101::1',
    '2001:0:4136:e378::1',
    'fe80::1%en0',
  ])
    expect(isPrivateIp(ip)).toBe(true)
  for (const ip of [
    '8.8.8.8',
    '172.32.0.1',
    '93.184.215.14',
    '2606:4700::6810:84e5',
    '2606:4700:0:0:0:0:6810:84e5',
    '2002:808:808::1',
  ])
    expect(isPrivateIp(ip)).toBe(false)
})

test('hosts are public only when every address they resolve to is', async () => {
  const dns = (table: Record<string, string[]>) => async (host: string) => {
    const found = table[host]
    if (!found) throw new Error('ENOTFOUND')
    return found
  }
  const resolve = dns({
    'example.com': ['93.184.215.14', '2606:2800:21f::1'],
    'rebind.example': ['93.184.215.14', '127.0.0.1'],
    'intranet.example': ['10.0.0.5'],
  })
  expect(await isPublicHost('example.com', resolve)).toBe(true)
  expect(await isPublicHost('rebind.example', resolve)).toBe(false)
  expect(await isPublicHost('intranet.example', resolve)).toBe(false)
  expect(await isPublicHost('missing.example', resolve)).toBe(false)
  // Local names never reach DNS.
  for (const host of ['localhost', 'app.localhost', 'printer.local', 'nas', 'db.internal'])
    expect(await isPublicHost(host, resolve)).toBe(false)
  expect(await isPublicHost('127.0.0.1', resolve)).toBe(false)
  expect(await isPublicHost('[::1]', resolve)).toBe(false)
  expect(await isPublicHost('8.8.8.8', resolve)).toBe(true)
})

test('capture addresses are http(s), with https assumed, including host:port', () => {
  expect(captureUrl('stripe.com').toString()).toBe('https://stripe.com/')
  expect(captureUrl(' example.com:8080/pricing ').toString()).toBe(
    'https://example.com:8080/pricing',
  )
  expect(captureUrl('localhost:3000').hostname).toBe('localhost')
  expect(captureUrl('http://example.com').protocol).toBe('http:')
  for (const bad of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,hi',
    'chrome://gpu',
  ])
    expect(() => captureUrl(bad)).toThrow('Only http and https')
})
