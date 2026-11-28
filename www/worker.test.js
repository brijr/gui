import { Database as SQLite } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  AGENT_FAILURES,
  AGENT_UNAVAILABLE,
  FRAMEWORKS,
  TURN_STAGES,
  UPDATE_FAILURES,
} from '../src/main/analytics-queue.ts'
import worker from './worker.js'

const migrations = async () =>
  Promise.all(
    ['0001_waitlist_downloads.sql', '0002_crashes.sql'].map((name) =>
      Bun.file(new URL(`./migrations/${name}`, import.meta.url)).text(),
    ),
  )

/** @type {SQLite} */
let db
/** @type {import('./worker.js') extends { fetch: (request: Request, env: infer E, ctx: infer C) => unknown } ? E : never} */
let env
const pending = /** @type {Promise<unknown>[]} */ ([])
const ctx = {
  waitUntil(promise) {
    pending.push(promise)
  },
}

/** @type {Map<string, Response>} */
let cacheStore

/** What the releases bucket holds: the bytes of each file, by name. */
let files = /** @type {Record<string, string>} */ ({})
/** What the bucket was asked for, in order. */
let asked = /** @type {string[]} */ ([])

/**
 * A releases bucket that sends the range it is asked for, and only from the version `onlyIf`
 * names, as R2 does. A file's ETag is its content, so replacing a file changes it.
 */
const bucket = {
  async head(key) {
    asked.push(`head ${key}`)
    if (!(key in files)) return null
    const bytes = new TextEncoder().encode(files[key])
    return {
      size: bytes.byteLength,
      etag: files[key],
      httpEtag: `"${files[key]}"`,
      writeHttpMetadata(headers) {
        headers.set('content-type', key.endsWith('.yml') ? 'text/yaml' : 'application/zip')
      },
    }
  },
  async get(key, options = {}) {
    const object = await this.head(key)
    asked[asked.length - 1] = `get ${key}`
    if (!object) return null
    if (options.onlyIf && options.onlyIf.etagMatches !== object.etag) return object
    const { offset = 0, length = object.size - offset } = options.range ?? {}
    if (offset < 0 || length <= 0 || offset + length > object.size) throw new Error('InvalidRange')
    const bytes = new TextEncoder().encode(files[key]).slice(offset, offset + length)
    return { ...object, body: new Blob([bytes]).stream() }
  },
}

const ZIP = 'Gui-0.1.0-alpha.15-arm64.zip'

beforeEach(async () => {
  db = new SQLite(':memory:')
  for (const sql of await migrations()) db.exec(sql)
  cacheStore = new Map()
  globalThis.caches = {
    default: {
      async match(request) {
        const cached = cacheStore.get(new Request(request).url)
        return cached ? cached.clone() : undefined
      },
      async put(request, response) {
        cacheStore.set(new Request(request).url, response)
      },
    },
  }
  env = {
    DB: {
      prepare(sql) {
        let values = /** @type {unknown[]} */ ([])
        return {
          bind(...args) {
            values = args
            return this
          },
          async first() {
            return db.query(sql).get(...values)
          },
          async run() {
            return { meta: { changes: db.query(sql).run(...values).changes } }
          },
        }
      },
    },
    RELEASES: bucket,
    ASSETS: { fetch: async () => new Response('site') },
  }
  files = { [ZIP]: '0123456789', 'alpha-mac.yml': 'version: 0.1.0-alpha.15' }
  asked = []
})

afterEach(async () => {
  await Promise.all(pending)
  pending.length = 0
  db.close()
  delete globalThis.caches
})

/** @param {string} [path] @param {Record<string, string>} [headers] @param {string} [method] */
const get = (path = '/downloads', headers = {}, method = 'GET') =>
  worker.fetch(new Request(`https://usegui.com${path}`, { method, headers }), env, ctx)

/** The rows of the downloads table, once the counting has finished. */
const counted = async () => {
  await Promise.all(pending)
  return db.query('SELECT file FROM downloads').all()
}

test('/downloads is the counted total and nothing else from the table', async () => {
  db.exec(
    `INSERT INTO downloads (file, country, referrer, created_at) VALUES
      ('Gui-alpha-arm64.dmg', 'US', 'x.com', 1),
      ('Gui-alpha-arm64.dmg', 'DE', 'github.com', 2)`,
  )
  const response = await get()
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('public, max-age=300')
  const body = await response.json()
  expect(body).toEqual({ downloads: 2 })
  expect(JSON.stringify(body)).not.toContain('US')
  expect(JSON.stringify(body)).not.toContain('x.com')
  expect(JSON.stringify(body)).not.toContain('Gui-alpha-arm64')
})

test('/downloads ignores query strings that could ask for extra fields', async () => {
  db.exec(
    `INSERT INTO downloads (file, country, referrer, created_at) VALUES
      ('Gui-alpha-arm64.dmg', 'US', 'x.com', 1)`,
  )
  const response = await get('/downloads?country=US&referrer=1')
  expect(await response.json()).toEqual({ downloads: 1 })
})

test('/downloads is remembered so a second view does not query D1', async () => {
  db.exec(
    `INSERT INTO downloads (file, country, referrer, created_at) VALUES
      ('Gui-alpha-arm64.dmg', 'US', null, 1)`,
  )
  expect(await (await get()).json()).toEqual({ downloads: 1 })
  await Promise.all(pending)
  db.exec(
    `INSERT INTO downloads (file, country, referrer, created_at) VALUES
      ('Gui-alpha-arm64.dmg', 'FR', 'evil.example', 2)`,
  )
  const second = await get()
  expect(await second.json()).toEqual({ downloads: 1 })
})

test('/downloads is omitted when D1 fails', async () => {
  env.DB.prepare = () => {
    throw new Error('d1 unavailable')
  }
  const response = await get()
  expect(response.status).toBe(204)
  expect(await response.text()).toBe('')
})

test('/downloads is omitted when the count is not a number', async () => {
  env.DB.prepare = () => ({
    bind() {
      return this
    },
    async first() {
      return { downloads: 'many', country: 'US' }
    },
    async run() {
      return { meta: { changes: 0 } }
    },
  })
  const response = await get()
  expect(response.status).toBe(204)
})

test('POST /downloads is not served', async () => {
  const response = await worker.fetch(
    new Request('https://usegui.com/downloads', { method: 'POST' }),
    env,
    ctx,
  )
  expect(response.status).toBe(405)
})

test('a release file is sent whole, and says it can be sent in parts', async () => {
  const response = await get(`/releases/${ZIP}`)
  expect(response.status).toBe(200)
  expect(response.headers.get('accept-ranges')).toBe('bytes')
  expect(response.headers.get('content-length')).toBe('10')
  expect(response.headers.get('content-range')).toBeNull()
  expect(response.headers.get('content-type')).toBe('application/zip')
  expect(response.headers.get('etag')).toBe('"0123456789"')
  expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  expect(await response.text()).toBe('0123456789')
})

test('the update feed is never kept by a browser', async () => {
  const response = await get('/releases/alpha-mac.yml')
  expect(response.headers.get('cache-control')).toBe('no-cache')
  expect(response.headers.get('accept-ranges')).toBe('bytes')
  expect(await response.text()).toBe('version: 0.1.0-alpha.15')
})

test('a release file that does not exist is not found', async () => {
  expect((await get('/releases/Gui-0.0.0-arm64.zip')).status).toBe(404)
  expect((await get('/releases/Gui-0.0.0-arm64.zip', { range: 'bytes=0-1' })).status).toBe(404)
})

for (const [range, contentRange, body] of [
  ['bytes=2-5', 'bytes 2-5/10', '2345'],
  ['bytes=0-0', 'bytes 0-0/10', '0'],
  ['bytes=6-', 'bytes 6-9/10', '6789'],
  ['bytes=-3', 'bytes 7-9/10', '789'],
  // Past the end: as much as the file has.
  ['bytes=8-99', 'bytes 8-9/10', '89'],
  ['bytes=-99', 'bytes 0-9/10', '0123456789'],
]) {
  test(`${range} of a release file is that part`, async () => {
    const response = await get(`/releases/${ZIP}`, { range })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(contentRange)
    expect(response.headers.get('content-length')).toBe(String(body.length))
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('etag')).toBe('"0123456789"')
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(await response.text()).toBe(body)
  })
}

for (const range of ['bytes=10-', 'bytes=10-20', 'bytes=-0']) {
  test(`${range} has none of a release file in it`, async () => {
    const response = await get(`/releases/${ZIP}`, { range })
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */10')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(await response.text()).toBe('')
    // R2 is never asked for a range it would refuse.
    expect(asked).toEqual([`head ${ZIP}`])
  })
}

for (const range of ['bytes=0-1,4-5', 'bytes=5-2', 'bytes=-', 'bytes=a-b', 'items=0-1']) {
  test(`${range} gets the whole release file`, async () => {
    const response = await get(`/releases/${ZIP}`, { range })
    expect(response.status).toBe(200)
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('content-range')).toBeNull()
    expect(response.headers.get('content-length')).toBe('10')
    expect(await response.text()).toBe('0123456789')
  })
}

test('a resumed download continues when If-Range names the file the bucket holds', async () => {
  const response = await get(`/releases/${ZIP}`, {
    range: 'bytes=4-',
    'if-range': '"0123456789"',
  })
  expect(response.status).toBe(206)
  expect(response.headers.get('content-range')).toBe('bytes 4-9/10')
  expect(await response.text()).toBe('456789')
})

for (const validator of ['"an older release"', 'W/"0123456789"', 'Sat, 07 Nov 2026 10:00:00 GMT']) {
  test(`a resumed download starts again when If-Range is ${validator}`, async () => {
    const response = await get(`/releases/${ZIP}`, { range: 'bytes=4-', 'if-range': validator })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-range')).toBeNull()
    expect(response.headers.get('etag')).toBe('"0123456789"')
    expect(await response.text()).toBe('0123456789')
  })
}

test('a file replaced while its range was worked out is sent whole', async () => {
  files['Gui-arm64.dmg'] = 'old release'
  const head = bucket.head.bind(bucket)
  env.RELEASES = {
    ...bucket,
    // The release lands between the worker reading the size and asking for the bytes.
    async head(key) {
      const object = await head(key)
      files['Gui-arm64.dmg'] = 'a longer new release'
      return object
    },
  }
  const response = await get('/download', { range: 'bytes=4-' })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-range')).toBeNull()
  expect(response.headers.get('etag')).toBe('"a longer new release"')
  expect(response.headers.get('content-length')).toBe('20')
  expect(await response.text()).toBe('a longer new release')
})

test('HEAD has the headers of a release file and none of it', async () => {
  const response = await get(`/releases/${ZIP}`, { range: 'bytes=2-5' }, 'HEAD')
  expect(response.status).toBe(200)
  expect(response.headers.get('accept-ranges')).toBe('bytes')
  expect(response.headers.get('content-length')).toBe('10')
  expect(response.headers.get('content-range')).toBeNull()
  expect(response.headers.get('content-type')).toBe('application/zip')
  expect(response.headers.get('etag')).toBe('"0123456789"')
  expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  expect(await response.text()).toBe('')
  // The file itself is not read.
  expect(asked).toEqual([`head ${ZIP}`])
})

test('/download is the alpha DMG until a release uploads Gui-arm64.dmg', async () => {
  files['Gui-alpha-arm64.dmg'] = 'alpha dmg'
  const response = await get('/download')
  expect(response.status).toBe(200)
  expect(response.headers.get('content-disposition')).toBe('attachment; filename="Gui.dmg"')
  expect(response.headers.get('cache-control')).toBe('no-cache')
  expect(response.headers.get('accept-ranges')).toBe('bytes')
  expect(response.headers.get('content-length')).toBe('9')
  expect(await response.text()).toBe('alpha dmg')
  expect(await counted()).toEqual([{ file: 'Gui-alpha-arm64.dmg' }])
})

test('/download is Gui-arm64.dmg once a release has uploaded it', async () => {
  files['Gui-alpha-arm64.dmg'] = 'alpha dmg'
  files['Gui-arm64.dmg'] = 'newest dmg'
  const response = await get('/download')
  expect(response.status).toBe(200)
  expect(response.headers.get('content-disposition')).toBe('attachment; filename="Gui.dmg"')
  expect(response.headers.get('cache-control')).toBe('no-cache')
  expect(await response.text()).toBe('newest dmg')
  expect(await counted()).toEqual([{ file: 'Gui-arm64.dmg' }])
  expect(asked).toEqual(['head Gui-arm64.dmg', 'get Gui-arm64.dmg'])
})

test('/download is not found when the bucket has neither DMG', async () => {
  expect((await get('/download')).status).toBe(404)
  expect(await counted()).toEqual([])
})

test('HEAD /download has the headers of the DMG and is not counted', async () => {
  files['Gui-arm64.dmg'] = 'newest dmg'
  const response = await get('/download', {}, 'HEAD')
  expect(response.status).toBe(200)
  expect(response.headers.get('content-disposition')).toBe('attachment; filename="Gui.dmg"')
  expect(response.headers.get('accept-ranges')).toBe('bytes')
  expect(response.headers.get('content-length')).toBe('10')
  expect(response.headers.get('etag')).toBe('"newest dmg"')
  expect(await response.text()).toBe('')
  expect(await counted()).toEqual([])
})

test('a /download that resumes part way through is sent the rest and is not counted', async () => {
  files['Gui-arm64.dmg'] = 'newest dmg'
  const response = await get('/download', { range: 'bytes=7-', 'if-range': '"newest dmg"' })
  expect(response.status).toBe(206)
  expect(response.headers.get('content-range')).toBe('bytes 7-9/10')
  expect(response.headers.get('content-disposition')).toBe('attachment; filename="Gui.dmg"')
  expect(await response.text()).toBe('dmg')
  expect(await counted()).toEqual([])
})

test('a /download asked for in parts is counted once, for the range from the first byte to the end', async () => {
  files['Gui-arm64.dmg'] = 'newest dmg'
  expect((await get('/download', { range: 'bytes=0-' })).status).toBe(206)
  expect((await get('/download', { range: 'bytes=5-' })).status).toBe(206)
  expect((await get('/download', { range: 'bytes=50-' })).status).toBe(416)
  expect(await counted()).toEqual([{ file: 'Gui-arm64.dmg' }])
})

for (const range of ['bytes=0-0', 'bytes=0-4', 'bytes=0-9', 'bytes=-10', 'bytes=0-4,5-']) {
  test(`a /download of ${range} is still sent but is not counted`, async () => {
    files['Gui-arm64.dmg'] = 'newest dmg'
    const response = await get('/download', { range })
    expect(response.ok).toBe(true)
    await response.arrayBuffer()
    expect(await counted()).toEqual([])
  })
}

const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/142.0 Safari/537.36'
const LINUX_CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/142.0 Safari/537.36'
const LINUX_ARM_FIREFOX = 'Mozilla/5.0 (X11; Linux aarch64; rv:146.0) Gecko/20100101 Firefox/146.0'
const ANDROID =
  'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/142.0 Mobile Safari/537.36'

test('/download on a Mac is the DMG', async () => {
  files['Gui-alpha-arm64.dmg'] = 'alpha dmg'
  const response = await get('/download', { 'user-agent': MAC })
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('alpha dmg')
  expect(await counted()).toEqual([{ file: 'Gui-alpha-arm64.dmg' }])
})

for (const [agent, page] of [
  [LINUX_CHROME, '/download/linux'],
  [LINUX_ARM_FIREFOX, '/download/linux-arm64'],
]) {
  test(`/download on Linux is the download page, ${page}, and is not counted`, async () => {
    files['Gui-alpha-arm64.dmg'] = 'alpha dmg'
    const response = await get('/download', { 'user-agent': agent })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(`https://usegui.com${page}`)
    expect(await counted()).toEqual([])
  })
}

test('/download on a phone goes back to the page, though Android says it is Linux', async () => {
  const response = await get('/download', { 'user-agent': ANDROID })
  expect(response.status).toBe(303)
  expect(response.headers.get('location')).toBe('https://usegui.com/#mac-only')
  expect(await counted()).toEqual([])
})

const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0 Safari/537.36'
const WINDOWS_FIREFOX =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:146.0) Gecko/20100101 Firefox/146.0'

for (const agent of [WINDOWS, WINDOWS_FIREFOX]) {
  test(`/download on Windows goes back to the page and is not counted: ${agent}`, async () => {
    files['Gui-alpha-arm64.dmg'] = 'alpha dmg'
    const response = await get('/download', { 'user-agent': agent })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('https://usegui.com/#windows')
    expect(await counted()).toEqual([])
  })
}

for (const agent of ['curl/8.7.1', '']) {
  test(`/download by ${agent || 'a client without a user agent'} is still the DMG`, async () => {
    files['Gui-alpha-arm64.dmg'] = 'alpha dmg'
    const response = await get('/download', agent ? { 'user-agent': agent } : {})
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('alpha dmg')
    expect(await counted()).toEqual([{ file: 'Gui-alpha-arm64.dmg' }])
  })
}

test('a Linux download is the alpha copy until a stable release uploads its own', async () => {
  files['Gui-alpha-x86_64.AppImage'] = 'alpha appimage'
  const response = await get('/download/Gui-x86_64.AppImage', { 'user-agent': LINUX_CHROME })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-disposition')).toBe(
    'attachment; filename="Gui-x86_64.AppImage"',
  )
  expect(response.headers.get('cache-control')).toBe('no-cache')
  expect(await response.text()).toBe('alpha appimage')
  expect(await counted()).toEqual([{ file: 'Gui-alpha-x86_64.AppImage' }])
})

test('a Linux download is the stable copy once there is one', async () => {
  files['Gui-alpha-arm64.deb'] = 'alpha deb'
  files['Gui-arm64.deb'] = 'stable deb'
  const response = await get('/download/Gui-arm64.deb', { 'user-agent': LINUX_ARM_FIREFOX })
  expect(response.headers.get('content-disposition')).toBe('attachment; filename="Gui-arm64.deb"')
  expect(await response.text()).toBe('stable deb')
  expect(await counted()).toEqual([{ file: 'Gui-arm64.deb' }])
})

test('/download/ serves only the Linux downloads; anything else there is the site', async () => {
  files['Gui-0.1.0-alpha.15-x86_64.AppImage'] = 'versioned'
  files['Gui-alpha-arm64.dmg'] = 'alpha dmg'
  for (const path of [
    '/download/linux',
    '/download/Gui-0.1.0-alpha.15-x86_64.AppImage',
    '/download/Gui-arm64.dmg',
  ]) {
    expect(await (await get(path)).text()).toBe('site')
  }
  expect((await get('/download/Gui-amd64.deb')).status).toBe(404)
  expect(await counted()).toEqual([])
})

test('/install.sh is the script as plain text, never kept long, and not a download', async () => {
  env.ASSETS.fetch = async (request) =>
    new URL(request.url).pathname === '/install.sh'
      ? new Response('#!/bin/sh', { headers: { 'content-type': 'application/x-sh' } })
      : new Response('not found', { status: 404 })
  const response = await get('/install.sh', { 'user-agent': 'curl/8.14.1' })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  expect(response.headers.get('cache-control')).toBe('no-cache')
  expect(response.headers.has('content-disposition')).toBe(false)
  expect(await response.text()).toBe('#!/bin/sh')
  expect(await counted()).toEqual([])
})

for (const agent of ['curl/8.14.1', 'Wget/1.25.0', 'Wget']) {
  test(`a Linux download by ${agent}, as the install script makes, is counted`, async () => {
    files['Gui-alpha-arm64.AppImage'] = 'alpha appimage'
    const response = await get('/download/Gui-arm64.AppImage', { 'user-agent': agent })
    expect(await response.text()).toBe('alpha appimage')
    expect(await counted()).toEqual([{ file: 'Gui-alpha-arm64.AppImage' }])
  })
}

/** The static site, which sends the whole file whatever Range asks for, as Cloudflare's does. */
const site = (/** @type {Request} */ request) => {
  const tag = '"video-1"'
  const headers = { 'content-type': 'video/mp4', etag: tag }
  if (new URL(request.url).pathname !== '/video/hero-light.mp4') {
    return new Response('not found', { status: 404 })
  }
  if (request.headers.get('if-none-match') === tag)
    return new Response(null, { status: 304, headers })
  return new Response(request.method === 'HEAD' ? null : 'a short film', { headers })
}

test('a video is sent whole, kept for an hour, and says it can be sent in parts', async () => {
  env.ASSETS.fetch = async (request) => site(request)
  const response = await get('/video/hero-light.mp4')
  expect(response.status).toBe(200)
  expect(response.headers.get('accept-ranges')).toBe('bytes')
  expect(response.headers.get('cache-control')).toBe('public, max-age=3600')
  expect(response.headers.get('content-type')).toBe('video/mp4')
  expect(response.headers.get('x-frame-options')).toBe('DENY')
  expect(await response.text()).toBe('a short film')
})

for (const [range, contentRange, body] of [
  ['bytes=0-1', 'bytes 0-1/12', 'a '],
  ['bytes=8-', 'bytes 8-11/12', 'film'],
  ['bytes=-4', 'bytes 8-11/12', 'film'],
]) {
  test(`${range} of a video is that part, as Safari needs`, async () => {
    env.ASSETS.fetch = async (request) => site(request)
    const response = await get('/video/hero-light.mp4', { range })
    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe(contentRange)
    expect(response.headers.get('content-length')).toBe(String(body.length))
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('etag')).toBe('"video-1"')
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(await response.text()).toBe(body)
  })
}

test('a video range past the end, several ranges, and an If-Range for another video', async () => {
  env.ASSETS.fetch = async (request) => site(request)
  const past = await get('/video/hero-light.mp4', { range: 'bytes=12-' })
  expect(past.status).toBe(416)
  expect(past.headers.get('content-range')).toBe('bytes */12')
  expect(past.headers.get('cache-control')).toBe('no-cache')
  const several = await get('/video/hero-light.mp4', { range: 'bytes=0-1,4-5' })
  expect(several.status).toBe(200)
  expect(await several.text()).toBe('a short film')
  const other = await get('/video/hero-light.mp4', { range: 'bytes=4-', 'if-range': '"video-0"' })
  expect(other.status).toBe(200)
  expect(await other.text()).toBe('a short film')
})

test('a video the browser already has stays kept for another hour', async () => {
  env.ASSETS.fetch = async (request) => site(request)
  const response = await get('/video/hero-light.mp4', { 'if-none-match': '"video-1"' })
  expect(response.status).toBe(304)
  expect(response.headers.get('cache-control')).toBe('public, max-age=3600')
})

test('a video that does not exist is a page, not a video', async () => {
  env.ASSETS.fetch = async (request) => site(request)
  const response = await get('/video/missing.mp4', { range: 'bytes=0-1' })
  expect(response.status).toBe(404)
  expect(response.headers.get('accept-ranges')).toBeNull()
  expect(response.headers.get('cache-control')).toBe('no-cache')
})

test('pages are not cut into parts', async () => {
  const response = await get('/', { range: 'bytes=0-1' })
  expect(response.status).toBe(200)
  expect(response.headers.get('accept-ranges')).toBeNull()
  expect(response.headers.get('cache-control')).toBe('no-cache')
  expect(await response.text()).toBe('site')
})

const INSTALL = '0f8e2a4c-5b1d-4e7f-9a3b-6c2d8e0f1a2b'
/** What was sent to PostHog: each request's URL and body. */
let forwarded = /** @type {{ url: string, body: any }[]} */ ([])
const realFetch = globalThis.fetch

/** PostHog, which takes everything; `fails` makes it unreachable. */
function posthog({ fails = false } = {}) {
  forwarded = []
  globalThis.fetch = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (
      async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
        if (fails) throw new Error('posthog unreachable')
        forwarded.push({ url: String(url), body: JSON.parse(String(init.body)) })
        return new Response('{}')
      }
    )
  )
}

afterEach(() => {
  globalThis.fetch = realFetch
})

/** @param {unknown} body @param {Record<string, string>} [headers] */
const sendUsage = (body, headers = {}) => {
  const request = new Request('https://usegui.com/t/v1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  Object.defineProperty(request, 'cf', { value: { country: 'NZ' } })
  return worker.fetch(request, env, ctx)
}

const sent = async () => {
  await Promise.all(pending)
  return forwarded.flatMap((request) => request.body.batch)
}

test('usage events the app knows go to PostHog under the install ID, with the country', async () => {
  posthog()
  env.POSTHOG_KEY = 'phc_test'
  const at = Date.now() - 60_000
  const response = await sendUsage({
    installId: INSTALL,
    events: [
      {
        event: 'app_opened',
        at,
        props: { version: '0.1.0-alpha.22', os: 'darwin', osVersion: '26.1', arch: 'arm64' },
      },
      {
        event: 'turn_finished',
        at,
        props: { agent: 'claude', outcome: 'done', provider: 'gateway' },
      },
      { event: 'project_opened', at },
    ],
  })
  expect(response.status).toBe(204)
  // After the reply, not before it.
  expect(pending.length).toBeGreaterThan(0)
  const events = await sent()
  expect(forwarded[0].url).toBe('https://us.i.posthog.com/batch/')
  expect(forwarded[0].body.api_key).toBe('phc_test')
  expect(events.map((/** @type {any} */ e) => e.event)).toEqual([
    'app_opened',
    'turn_finished',
    'project_opened',
  ])
  expect(events[0].distinct_id).toBe(INSTALL)
  expect(events[0].timestamp).toBe(new Date(at).toISOString())
  expect(events[0].properties).toEqual({
    version: '0.1.0-alpha.22',
    os: 'darwin',
    osVersion: '26.1',
    arch: 'arm64',
    country: 'NZ',
    $ip: null,
    $geoip_disable: true,
    $process_person_profile: false,
  })
  expect(events[1].properties.provider).toBe('gateway')
})

test('unknown events, unknown props and values that do not fit are dropped, not the batch', async () => {
  posthog()
  env.POSTHOG_KEY = 'phc_test'
  const response = await sendUsage({
    installId: INSTALL,
    events: [
      { event: 'file_opened', props: { path: '/Users/someone/secret.txt' } },
      {
        event: 'turn_finished',
        props: {
          agent: 'claude',
          outcome: 'exploded',
          provider: 'https://evil.example/x',
          prompt: 'hi',
        },
      },
      { event: 'agent_connected', props: { agent: 'Custom Agent With Spaces' } },
      { event: 'canvas_created', props: { name: 'My canvas' } },
      { event: 'update_installed', props: { from: 1, to: '0.1.0-alpha.22' } },
      'nonsense',
      null,
    ],
  })
  expect(response.status).toBe(204)
  const events = await sent()
  expect(events.map((/** @type {any} */ e) => e.event)).toEqual([
    'turn_finished',
    'agent_connected',
    'canvas_created',
    'update_installed',
  ])
  const { $ip, $geoip_disable, $process_person_profile, country, ...turn } = events[0].properties
  expect(turn).toEqual({ agent: 'claude' })
  expect(Object.keys(events[1].properties)).not.toContain('agent')
  expect(Object.keys(events[2].properties)).not.toContain('name')
  expect(events[3].properties.to).toBe('0.1.0-alpha.22')
  expect(Object.keys(events[3].properties)).not.toContain('from')
  expect(JSON.stringify(events)).not.toContain('secret')
  expect(JSON.stringify(events)).not.toContain('evil')
})

test('the failure, turn and framework events keep only the values on their lists', async () => {
  posthog()
  env.POSTHOG_KEY = 'phc_test'
  const response = await sendUsage({
    installId: INSTALL,
    events: [
      {
        event: 'turn_finished',
        props: {
          agent: 'codex',
          outcome: 'failed',
          reason: 'rate_limited',
          picked: 'yes',
          tools: 'no',
          mode: 'own',
        },
      },
      {
        event: 'turn_finished',
        props: {
          agent: 'claude',
          outcome: 'failed',
          reason: 'Error: ENOENT /Users/someone/app',
          picked: 'true',
          tools: 'maybe',
          mode: 'yolo',
          error: 'boom',
        },
      },
      { event: 'project_opened', props: { framework: 'astro' } },
      { event: 'project_opened', props: { framework: 'my-secret-framework', root: '/Users/x' } },
      { event: 'app_start_failed', props: { reason: 'install_failed' } },
      { event: 'app_start_failed', props: { reason: 'npm ERR! code E404', command: 'npm i' } },
      { event: 'agent_unavailable', props: { agent: 'gemini', reason: 'too_old' } },
      { event: 'agent_unavailable', props: { agent: 'claude', reason: 'not_installed' } },
      { event: 'update_failed', props: { stage: 'download' } },
      { event: 'update_failed', props: { stage: 'check' } },
      { event: 'update_failed', props: { stage: 'install', reason: 'signature' } },
      {
        event: 'update_failed',
        props: { stage: 'download', reason: 'net::ERR_FAILED https://secret.example/Gui.zip' },
      },
      { event: 'dev_server_crashed', props: { reason: 'exited' } },
    ],
  })
  expect(response.status).toBe(204)
  const events = await sent()
  /** @param {any} e */
  const props = (e) => {
    const { $ip, $geoip_disable, $process_person_profile, country, ...rest } = e.properties
    return { event: e.event, ...rest }
  }
  expect(events.map(props)).toEqual([
    {
      event: 'turn_finished',
      agent: 'codex',
      outcome: 'failed',
      reason: 'rate_limited',
      picked: 'yes',
      tools: 'no',
      mode: 'own',
    },
    { event: 'turn_finished', agent: 'claude', outcome: 'failed' },
    { event: 'project_opened', framework: 'astro' },
    { event: 'project_opened' },
    { event: 'app_start_failed', reason: 'install_failed' },
    { event: 'app_start_failed' },
    { event: 'agent_unavailable', agent: 'gemini', reason: 'too_old' },
    { event: 'agent_unavailable', agent: 'claude' },
    { event: 'update_failed', stage: 'download' },
    { event: 'update_failed' },
    { event: 'update_failed', stage: 'install', reason: 'signature' },
    { event: 'update_failed', stage: 'download' },
  ])
  for (const leaked of ['ENOENT', 'Users', 'secret', 'npm', 'boom', 'net::']) {
    expect(JSON.stringify(events)).not.toContain(leaked)
  }
})

test('a batch is capped, and an event time that could not be real is now', async () => {
  posthog()
  env.POSTHOG_KEY = 'phc_test'
  const events = Array.from({ length: 150 }, () => ({ event: 'preview_opened', at: 1 }))
  const before = Date.now()
  await sendUsage({ installId: INSTALL, events })
  const kept = await sent()
  expect(kept).toHaveLength(100)
  expect(Date.parse(kept[0].timestamp)).toBeGreaterThanOrEqual(before - 1000)
})

test('a batch that is not one is refused, and nothing is sent', async () => {
  posthog()
  env.POSTHOG_KEY = 'phc_test'
  expect((await sendUsage('not json')).status).toBe(400)
  expect((await sendUsage({ installId: 'someone@example.com', events: [] })).status).toBe(400)
  expect((await sendUsage({ installId: INSTALL, events: 'app_opened' })).status).toBe(400)
  const huge = {
    installId: INSTALL,
    events: [{ event: 'app_opened', props: { x: 'a'.repeat(70_000) } }],
  }
  expect((await sendUsage(huge)).status).toBe(413)
  expect(await sent()).toEqual([])
})

test('the client IP is never forwarded', async () => {
  posthog()
  env.POSTHOG_KEY = 'phc_test'
  await sendUsage(
    { installId: INSTALL, events: [{ event: 'project_opened' }] },
    { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '203.0.113.7' },
  )
  await Promise.all(pending)
  expect(forwarded).toHaveLength(1)
  expect(JSON.stringify(forwarded)).not.toContain('203.0.113.7')
  expect(forwarded[0].body.batch[0].properties.$ip).toBeNull()
})

test('without a PostHog key, events are accepted and dropped', async () => {
  posthog()
  const response = await sendUsage({ installId: INSTALL, events: [{ event: 'project_opened' }] })
  expect(response.status).toBe(204)
  await Promise.all(pending)
  expect(forwarded).toEqual([])
})

test('PostHog failing is logged, not the app’s problem', async () => {
  posthog({ fails: true })
  env.POSTHOG_KEY = 'phc_test'
  const error = console.error
  console.error = () => {}
  try {
    const response = await sendUsage({ installId: INSTALL, events: [{ event: 'project_opened' }] })
    expect(response.status).toBe(204)
    await Promise.all(pending)
  } finally {
    console.error = error
  }
})

test('the kill switch: off tells the app to stop; a list drops just those events', async () => {
  posthog()
  env.POSTHOG_KEY = 'phc_test'
  env.ANALYTICS = 'off'
  const stopped = await sendUsage({ installId: INSTALL, events: [{ event: 'project_opened' }] })
  expect(stopped.status).toBe(200)
  expect(await stopped.json()).toEqual({ stop: true })
  expect(await sent()).toEqual([])

  env.ANALYTICS = 'turn_finished, project_opened'
  const response = await sendUsage({
    installId: INSTALL,
    events: [{ event: 'project_opened' }, { event: 'canvas_created' }, { event: 'turn_finished' }],
  })
  expect(response.status).toBe(204)
  expect((await sent()).map((/** @type {any} */ e) => e.event)).toEqual(['canvas_created'])

  env.ANALYTICS = 'on'
  await sendUsage({ installId: INSTALL, events: [{ event: 'project_opened' }] })
  expect((await sent()).map((/** @type {any} */ e) => e.event)).toEqual([
    'canvas_created',
    'project_opened',
  ])
})

test('an update check is counted without an install ID, with the version Gui sends', async () => {
  posthog()
  env.POSTHOG_KEY = 'phc_test'
  const request = new Request('https://usegui.com/releases/alpha-mac.yml', {
    headers: { 'user-agent': 'Gui/0.1.0-alpha.21', 'x-user-staging-id': 'abc' },
  })
  Object.defineProperty(request, 'cf', { value: { country: 'NZ' } })
  const response = await worker.fetch(request, env, ctx)
  expect(await response.text()).toBe('version: 0.1.0-alpha.15')
  const [event] = await sent()
  expect(event.event).toBe('update_check')
  expect(event.distinct_id).toBe('update-feed')
  const { $ip, $geoip_disable, $process_person_profile, ...props } = event.properties
  expect(props).toEqual({ feed: 'alpha-mac.yml', version: '0.1.0-alpha.21', country: 'NZ' })
  expect($ip).toBeNull()
  expect($process_person_profile).toBe(false)
  expect(JSON.stringify(event)).not.toContain('abc')
})

test('builds and HEADs of the feed are not counted as checks', async () => {
  posthog()
  env.POSTHOG_KEY = 'phc_test'
  await get(`/releases/${ZIP}`)
  await get('/releases/alpha-mac.yml', {}, 'HEAD')
  expect(await sent()).toEqual([])
})

test('the update feed is served when counting it fails, and counts nothing without a key', async () => {
  posthog({ fails: true })
  env.POSTHOG_KEY = 'phc_test'
  const error = console.error
  console.error = () => {}
  try {
    const response = await get('/releases/alpha-mac.yml')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('version: 0.1.0-alpha.15')
    await Promise.all(pending)
    // A waitUntil that throws can't take the feed down either.
    const throwing = {
      waitUntil() {
        throw new Error('no context')
      },
    }
    const request = new Request('https://usegui.com/releases/alpha-mac.yml')
    const feed = await worker.fetch(request, env, throwing)
    expect(await feed.text()).toBe('version: 0.1.0-alpha.15')
  } finally {
    console.error = error
  }

  posthog()
  delete env.POSTHOG_KEY
  await get('/releases/alpha-mac.yml')
  expect(await sent()).toEqual([])
})

/** @param {Record<string, string>} fields A form, and the address it comes from as `ip`. */
const signUp = ({ ip, ...fields }) => {
  const body = new FormData()
  for (const [key, value] of Object.entries(fields)) body.set(key, value)
  return worker.fetch(
    new Request('https://usegui.com/waitlist', {
      method: 'POST',
      body,
      headers: { accept: 'application/json', ...(ip ? { 'cf-connecting-ip': ip } : {}) },
    }),
    env,
    ctx,
  )
}

test('/waitlist keeps a Windows address, the only platform the page offers', async () => {
  const response = await signUp({ email: 'qa@example.invalid', platform: 'windows' })
  expect(await response.json()).toEqual({ ok: true })
  expect(db.query('SELECT email, platform FROM waitlist').all()).toEqual([
    { email: 'qa@example.invalid', platform: 'windows' },
  ])
})

test('/waitlist still keeps linux from a page cached before Linux came out', async () => {
  const response = await signUp({ email: 'old@example.invalid', platform: 'linux' })
  expect(await response.json()).toEqual({ ok: true })
  expect(db.query('SELECT platform FROM waitlist').all()).toEqual([{ platform: 'linux' }])
})

test('/waitlist refuses another platform', async () => {
  const response = await signUp({ email: 'qa@example.invalid', platform: 'mac' })
  expect(response.status).toBe(400)
  expect(db.query('SELECT * FROM waitlist').all()).toEqual([])
})

test("every failure and framework the app can send is on the site's lists", async () => {
  posthog()
  env.POSTHOG_KEY = 'phc_test'
  const reasons = [...AGENT_FAILURES, 'other']
  const frameworks = [...FRAMEWORKS, 'other', 'none', 'unknown']
  const updates = [...UPDATE_FAILURES]
  const response = await sendUsage({
    installId: INSTALL,
    events: [
      ...reasons.map((reason) => ({
        event: 'turn_finished',
        props: { agent: 'codex', outcome: 'failed', reason },
      })),
      ...frameworks.map((framework) => ({ event: 'project_opened', props: { framework } })),
      ...updates.map((reason) => ({
        event: 'update_failed',
        props: { stage: 'download', reason },
      })),
    ],
  })
  expect(response.status).toBe(204)
  const events = await sent()
  const turns = events.slice(0, reasons.length)
  const projects = events.slice(reasons.length, reasons.length + frameworks.length)
  const failures = events.slice(reasons.length + frameworks.length)
  expect(turns.map((e) => e.properties.reason)).toEqual(reasons)
  expect(projects.map((e) => e.properties.framework)).toEqual(frameworks)
  expect(failures.map((e) => e.properties.reason)).toEqual(updates)
})

test("every stage a failed turn can name is on the site's list; one off it is dropped", async () => {
  posthog()
  env.POSTHOG_KEY = 'phc_test'
  const turn = (stage) => ({
    event: 'turn_finished',
    props: { agent: 'codex', outcome: 'failed', reason: 'other', stage },
  })
  const response = await sendUsage({
    installId: INSTALL,
    events: [...TURN_STAGES.map(turn), turn('/Users/someone/project')],
  })
  expect(response.status).toBe(204)
  const events = await sent()
  expect(events.map((e) => e.properties.stage)).toEqual([...TURN_STAGES, undefined])
  expect(events.at(-1)?.properties.reason).toBe('other')
})

test('a failed turn from an older Gui, without stage or reason, is still kept', async () => {
  posthog()
  env.POSTHOG_KEY = 'phc_test'
  const response = await sendUsage({
    installId: INSTALL,
    events: [{ event: 'turn_finished', props: { agent: 'claude', outcome: 'failed' } }],
  })
  expect(response.status).toBe(204)
  const [event] = await sent()
  expect(event.event).toBe('turn_finished')
  expect(event.properties).toMatchObject({ agent: 'claude', outcome: 'failed' })
  expect(event.properties).not.toHaveProperty('reason')
  expect(event.properties).not.toHaveProperty('stage')
})

test("every reason an agent was unavailable is on the site's list, with whether it's in use", async () => {
  posthog()
  env.POSTHOG_KEY = 'phc_test'
  const events = AGENT_UNAVAILABLE.flatMap((reason) =>
    ['yes', 'no'].map((current) => ({
      event: 'agent_unavailable',
      props: { agent: 'codex', reason, current },
    })),
  )
  const response = await sendUsage({ installId: INSTALL, events })
  expect(response.status).toBe(204)
  const kept = (await sent()).map((e) => [e.properties.reason, e.properties.current])
  expect(kept).toEqual(events.map((e) => [e.props.reason, e.props.current]))
})

test('agent_unavailable from an older Gui, without current, is still kept', async () => {
  posthog()
  env.POSTHOG_KEY = 'phc_test'
  const response = await sendUsage({
    installId: INSTALL,
    events: [
      { event: 'agent_unavailable', props: { agent: 'cursor', reason: 'error' } },
      { event: 'agent_unavailable', props: { agent: 'muse', reason: 'timeout', current: 'maybe' } },
    ],
  })
  expect(response.status).toBe(204)
  const kept = (await sent()).map(({ event, properties: { agent, reason, current } }) => ({
    event,
    agent,
    reason,
    current,
  }))
  expect(kept).toEqual([
    { event: 'agent_unavailable', agent: 'cursor', reason: 'error', current: undefined },
    { event: 'agent_unavailable', agent: 'muse', reason: 'timeout', current: undefined },
  ])
})

/**
 * A rate limit like Cloudflare's: `limit` per key, each call counting its delta, decided on the
 * count before the call, and a refused call not counted. Every call is kept in `calls`.
 */
function limiter(limit) {
  const counts = new Map()
  const calls = /** @type {{ key: string, delta?: number }[]} */ ([])
  return {
    calls,
    async limit(/** @type {{ key: string, delta?: number }} */ options) {
      calls.push(options)
      const count = counts.get(options.key) ?? 0
      if (count >= limit) return { success: false }
      counts.set(options.key, count + (options.delta ?? 1))
      return { success: true }
    },
  }
}

/** @param {string} body @param {Record<string, string>} [headers] */
const report = (body, headers = {}) =>
  worker.fetch(
    new Request('https://usegui.com/crash', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    }),
    env,
    ctx,
  )
const CRASH = JSON.stringify({
  kind: 'main',
  message: 'boom',
  stack: 'Error: boom\n    at x',
  version: '0.1.0-alpha.32',
  os: '26.1',
  arch: 'arm64',
})
const crashes = () => db.query('SELECT message FROM crashes').all()

test('/crash keeps a report, then refuses an address past its limit with a bare 429', async () => {
  env.CRASH_LIMITER = limiter(2)
  expect((await report(CRASH, { 'cf-connecting-ip': '203.0.113.7' })).status).toBe(204)
  expect((await report(CRASH, { 'cf-connecting-ip': '203.0.113.7' })).status).toBe(204)
  const refused = await report(CRASH, { 'cf-connecting-ip': '203.0.113.7' })
  expect(refused.status).toBe(429)
  expect(await refused.text()).toBe('')
  // Another address has its own limit.
  expect((await report(CRASH, { 'cf-connecting-ip': '198.51.100.1' })).status).toBe(204)
  expect(crashes()).toHaveLength(3)
  expect(env.CRASH_LIMITER.calls[0].key).toBe('crash:203.0.113.7')
})

test('/crash refuses a body that says it is too large before reading it', async () => {
  env.CRASH_LIMITER = limiter(100)
  const response = await report(CRASH, { 'content-length': '20000' })
  expect(response.status).toBe(413)
  expect(env.CRASH_LIMITER.calls).toEqual([])
  expect((await report('x'.repeat(16_001))).status).toBe(413)
  expect(crashes()).toEqual([])
})

test('/crash keeps at most 2000 reports a day and removes none it kept', async () => {
  const now = Math.floor(Date.now() / 1000)
  const insert = db.prepare(
    "INSERT INTO crashes (kind, message, version, created_at) VALUES ('main', ?, 'v', ?)",
  )
  db.transaction(() => {
    insert.run('old', now - 2 * 86_400)
    for (let i = 0; i < 1999; i++) insert.run('today', now - 60)
  })()
  expect((await report(CRASH)).status).toBe(204)
  const refused = await report(CRASH)
  expect(refused.status).toBe(429)
  expect(await refused.text()).toBe('')
  expect(db.query('SELECT COUNT(*) AS n FROM crashes').get()).toEqual({ n: 2001 })
  expect(db.query("SELECT COUNT(*) AS n FROM crashes WHERE message = 'old'").get()).toEqual({
    n: 1,
  })
})

test('/waitlist refuses an address past its limit with a bare 429 and keeps nothing', async () => {
  env.WAITLIST_LIMITER = limiter(1)
  expect((await signUp({ email: 'a@example.invalid', platform: 'windows' })).status).toBe(200)
  const refused = await signUp({ email: 'b@example.invalid', platform: 'windows' })
  expect(refused.status).toBe(429)
  expect(await refused.text()).toBe('')
  expect(db.query('SELECT email FROM waitlist').all()).toEqual([{ email: 'a@example.invalid' }])
})

const batchOf = (/** @type {number} */ n) => ({
  installId: INSTALL,
  events: Array.from({ length: n }, () => ({ event: 'canvas_created', at: Date.now() })),
})

test('/t/v1 counts events toward the limit, and past it says 429 and sends nothing on', async () => {
  posthog()
  env.POSTHOG_KEY = 'phc_test'
  env.USAGE_LIMITER = limiter(600)
  const ip = { 'cf-connecting-ip': '203.0.113.7' }
  // A whole queue of 500 at once goes through, as does the batch that crosses the limit.
  for (let i = 0; i < 5; i++) expect((await sendUsage(batchOf(100), ip)).status).toBe(204)
  expect((await sendUsage(batchOf(100), ip)).status).toBe(204)
  expect(env.USAGE_LIMITER.calls.map((call) => call.delta)).toEqual([100, 100, 100, 100, 100, 100])
  expect((await sent()).length).toBe(600)
  forwarded = []
  const refused = await sendUsage(batchOf(1), ip)
  expect(refused.status).toBe(429)
  expect(await refused.text()).toBe('')
  expect(await sent()).toEqual([])
  // A refused batch is never counted, and a batch of more than 100 counts as the 100 kept.
  expect((await sendUsage(batchOf(250), { 'cf-connecting-ip': '198.51.100.1' })).status).toBe(204)
  expect(env.USAGE_LIMITER.calls.at(-1)).toEqual({ key: 'usage:198.51.100.1', delta: 100 })
})

test('an IPv6 address is limited by its /64, however it is written', async () => {
  env.WAITLIST_LIMITER = limiter(100)
  for (const ip of ['2001:db8:0:1::1', '2001:0DB8:0000:0001:ffff::9', '2001:db8::1', '::1']) {
    await signUp({ email: 'a@example.invalid', platform: 'windows', ip })
  }
  const keys = env.WAITLIST_LIMITER.calls.map((call) => call.key)
  expect(keys).toEqual([
    'waitlist:2001:db8:0:1::/64',
    'waitlist:2001:db8:0:1::/64',
    'waitlist:2001:db8:0:0::/64',
    'waitlist:0:0:0:0::/64',
  ])
})

test('a limiter that fails lets the request through', async () => {
  env.CRASH_LIMITER = {
    async limit() {
      throw new Error('limiter down')
    },
  }
  const error = console.error
  console.error = () => {}
  try {
    expect((await report(CRASH)).status).toBe(204)
  } finally {
    console.error = error
  }
})

test('downloads and update checks past the count limit are still sent, just not counted', async () => {
  posthog()
  env.POSTHOG_KEY = 'phc_test'
  env.COUNT_LIMITER = limiter(1)
  files['Gui-arm64.dmg'] = 'newest dmg'
  const ip = { 'cf-connecting-ip': '203.0.113.7' }
  for (let i = 0; i < 3; i++) {
    const download = await get('/download', ip)
    expect(await download.text()).toBe('newest dmg')
    const feed = await get('/releases/alpha-mac.yml', ip)
    expect(await feed.text()).toBe('version: 0.1.0-alpha.15')
  }
  expect(await counted()).toEqual([{ file: 'Gui-arm64.dmg' }])
  expect((await sent()).map((/** @type {any} */ e) => e.event)).toEqual(['update_check'])
  // Separate counts for each, so checks never use up the download count.
  expect(env.COUNT_LIMITER.calls.map((call) => call.key)).toContain('download:203.0.113.7')
  expect(env.COUNT_LIMITER.calls.map((call) => call.key)).toContain('update_check:203.0.113.7')
})
