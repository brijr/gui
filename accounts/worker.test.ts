import { Database as SQLite } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import worker, { type Database, type Env, type Statement } from './src/worker'

let db: SQLite
let env: Env
const realFetch = globalThis.fetch
let providerError: string | null
let emailVerified: boolean
let secondAccount: boolean
let installationPages: number[]
let refreshCalls: number
let createdBody: unknown
let pullBody: unknown
let creationDenied: boolean

beforeEach(async () => {
  db = new SQLite(':memory:')
  db.exec(await Bun.file(new URL('./migrations/0001_accounts.sql', import.meta.url)).text())
  const prepare = (sql: string): Statement => {
    let values: unknown[] = []
    return {
      bind(...args) {
        values = args
        return this
      },
      async first<T>() {
        return db.query(sql).get(...(values as string[])) as T | null
      },
      async all<T>() {
        return { results: db.query(sql).all(...(values as string[])) as T[] }
      },
      async run() {
        return { meta: { changes: db.query(sql).run(...(values as string[])).changes } }
      },
    }
  }
  const adapter: Database = {
    prepare,
    async batch(statements) {
      db.exec('BEGIN')
      try {
        for (const statement of statements) await statement.run()
        db.exec('COMMIT')
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    },
  }
  env = {
    DB: adapter,
    LOGIN_LIMITER: { limit: async () => ({ success: true }) },
    GITHUB_CLIENT_ID: 'client',
    GITHUB_APP_SLUG: 'gui-test',
    GITHUB_CLIENT_SECRET: 'secret',
    TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
  }
  providerError = null
  emailVerified = true
  secondAccount = false
  installationPages = []
  refreshCalls = 0
  createdBody = null
  pullBody = null
  creationDenied = false
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const params = init?.body as URLSearchParams
    if (url.pathname === '/login/device/code')
      return Response.json({
        device_code: 'device-secret',
        user_code: 'TEST-CODE',
        interval: 5,
        expires_in: 900,
      })
    if (url.pathname === '/login/oauth/access_token') {
      if (params.get('grant_type') === 'refresh_token') refreshCalls++
      return Response.json(
        providerError
          ? { error: providerError }
          : { access_token: 'provider-secret', refresh_token: 'refresh-secret', expires_in: 28800 },
      )
    }
    if (url.pathname === '/user')
      return Response.json({
        id: secondAccount ? 2 : 1,
        login: secondAccount ? 'other' : 'tester',
        name: 'Test User',
      })
    if (url.pathname === '/user/emails')
      return Response.json([{ email: 'test@example.com', verified: emailVerified, primary: true }])
    if (url.pathname === '/user/repos') {
      createdBody = JSON.parse(String(init?.body))
      return creationDenied
        ? Response.json({ message: 'secret provider details' }, { status: 422 })
        : Response.json({ id: 102, full_name: 'tester/design-project', private: true })
    }
    if (url.pathname === '/repos/tester/repo-1/pulls') {
      if (init?.method !== 'POST') return Response.json([])
      pullBody = JSON.parse(String(init.body))
      return Response.json({ html_url: 'https://github.com/tester/repo-1/pull/1' })
    }
    if (url.pathname === '/user/installations') {
      installationPages.push(Number(url.searchParams.get('page')))
      return Response.json({ installations: [{ id: secondAccount ? 22 : 11 }] })
    }
    if (url.pathname === '/user/installations/11/repositories') {
      const page = Number(url.searchParams.get('page'))
      return Response.json({
        repositories:
          page === 1
            ? Array.from({ length: 100 }, (_, i) => ({
                id: i + 1,
                full_name: `tester/repo-${i + 1}`,
                private: true,
              }))
            : [{ id: 101, full_name: 'tester/last', private: true }],
      })
    }
    if (url.pathname === '/user/installations/22/repositories')
      return Response.json({
        repositories: [{ id: 999, full_name: 'other/private', private: true }],
      })
    throw new Error(`Unexpected request ${url}`)
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
  db.close()
})
async function call(path: string, token?: string, method = 'GET', body?: unknown) {
  return worker.fetch(
    new Request(`https://accounts.test${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  )
}
async function login() {
  const attempt = (await (await call('/github/start', undefined, 'POST')).json()) as {
    attempt: string
  }
  db.exec('UPDATE login_attempts SET next_poll_at = 0')
  const response = await call('/github/poll', attempt.attempt, 'POST')
  expect(response.status).toBe(200)
  const body = (await response.json()) as { session: string }
  return { session: body.session, attempt: attempt.attempt }
}

test('login stores verified identity, encrypts provider credentials, and prevents replay', async () => {
  const signedIn = await login()
  const response = await call('/account', signedIn.session)
  expect(await response.json()).toMatchObject({
    profile: { login: 'tester', email: 'test@example.com', updates: false },
  })
  const user = db.query('SELECT * FROM users').get() as {
    github_token: string
    refresh_token: string
  }
  expect(user.github_token).not.toContain('provider-secret')
  expect(user.refresh_token).not.toContain('refresh-secret')
  expect(JSON.stringify(db.query('SELECT * FROM sessions').all())).not.toContain(signedIn.session)
  expect((await call('/github/poll', signedIn.attempt, 'POST')).status).toBe(401)
})

test('project creation is authenticated, private, initialized, validated, and sanitizes provider failures', async () => {
  expect((await call('/repositories', undefined, 'POST', { name: 'design-project' })).status).toBe(
    401,
  )
  const { session } = await login()
  expect((await call('/repositories', session, 'POST', { name: '../bad' })).status).toBe(400)
  expect(createdBody).toBeNull()
  const response = await call('/repositories', session, 'POST', {
    name: 'design-project',
    private: false,
  })
  expect(response.status).toBe(201)
  expect(createdBody).toEqual({ name: 'design-project', private: true, auto_init: true })
  expect(await response.json()).toMatchObject({ repository: { id: 102, private: true } })
  creationDenied = true
  const denied = await call('/repositories', session, 'POST', { name: 'design-project' })
  expect(denied.status).toBe(409)
  expect(await denied.text()).not.toContain('secret provider details')
})

test('pull requests only target repositories connected to the signed-in user', async () => {
  const { session } = await login()
  const body = {
    branch: 'gui/design',
    base: 'main',
    title: 'Design update',
    body: 'Reviewed changes',
  }
  expect((await call('/repositories/999/pulls', session, 'POST', body)).status).toBe(403)
  expect(pullBody).toBeNull()
  expect(await (await call('/repositories/1/pulls', session, 'POST', body)).json()).toEqual({
    url: 'https://github.com/tester/repo-1/pull/1',
  })
  expect(pullBody).toEqual({
    head: body.branch,
    base: body.base,
    title: body.title,
    body: body.body,
  })
})

test('email is optional, and only verified primary email can subscribe', async () => {
  emailVerified = false
  const { session } = await login()
  expect(await (await call('/account', session)).json()).toMatchObject({ profile: { email: null } })
  expect((await call('/account/updates', session, 'POST', { updates: true })).status).toBe(400)
  expect((await call('/repositories', session)).status).toBe(200)
})

test('preferences survive repeat login by immutable GitHub identity; logout invalidates only its session', async () => {
  const first = await login()
  expect((await call('/account/updates', first.session, 'POST', { updates: true })).status).toBe(
    200,
  )
  const second = await login()
  expect(db.query('SELECT count(*) AS n FROM users').get()).toEqual({ n: 1 })
  expect(await (await call('/account', second.session)).json()).toMatchObject({
    profile: { updates: true },
  })
  await call('/logout', first.session, 'POST')
  expect((await call('/account', first.session)).status).toBe(401)
  expect((await call('/account', second.session)).status).toBe(200)
  db.exec('UPDATE sessions SET expires_at = 0')
  expect((await call('/account', second.session)).status).toBe(401)
})

test('repository listing paginates and private clone denies repositories belonging to another user', async () => {
  const first = await login()
  const repos = (await (await call('/repositories', first.session)).json()) as {
    repositories: unknown[]
  }
  expect(repos.repositories).toHaveLength(101)
  expect(installationPages).toEqual([1])
  expect(await (await call('/repositories/101/credential', first.session, 'POST')).json()).toEqual({
    token: 'provider-secret',
    fullName: 'tester/last',
  })
  secondAccount = true
  const second = await login()
  expect((await call('/repositories/101/credential', second.session, 'POST')).status).toBe(403)
  expect((await call('/repositories/999/credential', second.session, 'POST')).status).toBe(200)
})

test('cancelled, denied, expired, and prematurely polled sign-ins do not create sessions', async () => {
  const a = (await (await call('/github/start', undefined, 'POST')).json()) as { attempt: string }
  expect(await (await call('/github/poll', a.attempt, 'POST')).json()).toEqual({ pending: true })
  await call('/github/cancel', a.attempt, 'POST')
  expect((await call('/github/poll', a.attempt, 'POST')).status).toBe(401)
  const b = (await (await call('/github/start', undefined, 'POST')).json()) as { attempt: string }
  providerError = 'access_denied'
  db.exec('UPDATE login_attempts SET next_poll_at = 0')
  expect((await call('/github/poll', b.attempt, 'POST')).status).toBe(401)
  const c = (await (await call('/github/start', undefined, 'POST')).json()) as { attempt: string }
  db.exec('UPDATE login_attempts SET expires_at = 0')
  expect((await call('/github/poll', c.attempt, 'POST')).status).toBe(401)
  expect(db.query('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
})

test('slow-down increases the next allowed poll and refresh rotates encrypted tokens', async () => {
  const attempt = (await (await call('/github/start', undefined, 'POST')).json()) as {
    attempt: string
  }
  db.exec('UPDATE login_attempts SET next_poll_at = 0')
  providerError = 'slow_down'
  expect(await (await call('/github/poll', attempt.attempt, 'POST')).json()).toEqual({
    pending: true,
  })
  expect(db.query('SELECT interval_seconds FROM login_attempts').get()).toEqual({
    interval_seconds: 10,
  })
  providerError = null
  const { session } = await login()
  db.exec('UPDATE users SET token_expires_at = 0')
  expect((await call('/repositories', session)).status).toBe(200)
  expect(refreshCalls).toBe(1)
})

test('deleting the Gui account removes sessions and contact records', async () => {
  const { session } = await login()
  expect((await call('/account', session, 'DELETE')).status).toBe(200)
  expect((await call('/account', session)).status).toBe(401)
  expect(db.query('SELECT count(*) AS n FROM users').get()).toEqual({ n: 0 })
})

test('sign-in throttling stops provider calls before creating attempts', async () => {
  env.LOGIN_LIMITER = { limit: async () => ({ success: false }) }
  expect((await call('/github/start', undefined, 'POST')).status).toBe(429)
  expect(db.query('SELECT count(*) AS n FROM login_attempts').get()).toEqual({ n: 0 })
})
