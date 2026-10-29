import { expect, test } from 'bun:test'
import {
  captureUrl,
  isPrivateIp,
  isPublicHost,
  navigationTarget,
  standInWebsite,
} from '../src/main/public-address'

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

test("paths and the app's own addresses stay on the app; full addresses elsewhere are websites", () => {
  const app = 'http://localhost:5173'
  const target = (input: string) => {
    const { kind, url } = navigationTarget(input, app)
    return `${kind} ${url}`
  }
  expect(target('/pricing')).toBe('app http://localhost:5173/pricing')
  expect(target('pricing?plan=pro')).toBe('app http://localhost:5173/pricing?plan=pro')
  expect(target('http://localhost:5173/settings')).toBe('app http://localhost:5173/settings')
  expect(target('https://linear.app')).toBe('website https://linear.app/')
  expect(target(' https://stripe.com/checkout ')).toBe('website https://stripe.com/checkout')
  // Another port on this machine is not the app; it opens only if it's public (it isn't).
  expect(target('http://localhost:3000')).toBe('website http://localhost:3000/')
})

test('only http and https open, and a path needs the dev server', () => {
  for (const input of [
    'file:///etc/passwd',
    'chrome://settings',
    'javascript:alert(1)',
    'data:text/html,hi',
  ])
    expect(() => navigationTarget(input, 'http://localhost:5173')).toThrow('Only http and https')
  expect(() => navigationTarget('/pricing', null)).toThrow('dev server is not running')
  expect(navigationTarget('https://linear.app', null).kind).toBe('website')
})

test('the stand-in website is for tests only: never in a packaged app, and only a .test name', () => {
  expect(standInWebsite('shop.gui-e2e.test=4321', false)).toEqual({
    host: 'shop.gui-e2e.test',
    port: 4321,
  })
  expect(standInWebsite('shop.gui-e2e.test=4321', true)).toBeNull()
  expect(standInWebsite(undefined, false)).toBeNull()
  for (const value of [
    'linear.app=443',
    'localhost=80',
    'shop.test=0',
    'shop.test=70000',
    'shop.test',
  ])
    expect(standInWebsite(value, false)).toBeNull()
})
