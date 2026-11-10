import { Database as SQLite } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
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

test('a /download asked for in parts is counted once, for the part from the first byte', async () => {
  files['Gui-arm64.dmg'] = 'newest dmg'
  expect((await get('/download', { range: 'bytes=0-4' })).status).toBe(206)
  expect((await get('/download', { range: 'bytes=5-' })).status).toBe(206)
  expect((await get('/download', { range: 'bytes=50-' })).status).toBe(416)
  expect(await counted()).toEqual([{ file: 'Gui-arm64.dmg' }])
})

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
