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
    RELEASES: { get: async () => null },
    ASSETS: { fetch: async () => new Response('site') },
  }
})

afterEach(async () => {
  await Promise.all(pending)
  pending.length = 0
  db.close()
  delete globalThis.caches
})

const get = (path = '/downloads') =>
  worker.fetch(new Request(`https://usegui.com${path}`), env, ctx)

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
