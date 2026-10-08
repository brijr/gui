import { Database as SQLite } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import worker, { type Database, type EmailMessage, type Env, type Statement } from './src/worker'

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
let sentEmails: EmailMessage[]
let googleUser: { sub: string; email: string; email_verified: boolean; name: string }
let appleSubject: string

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const idToken = (claims: Record<string, unknown>) =>
  `${encode({ alg: 'none' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 600, ...claims })}.sig`
const migrations = async () =>
  Promise.all(
    ['0001_accounts.sql', '0002_gui_accounts.sql'].map((name) =>
      Bun.file(new URL(`./migrations/${name}`, import.meta.url)).text(),
    ),
  )

beforeEach(async () => {
  db = new SQLite(':memory:')
  // D1 enforces foreign keys.
  db.exec('PRAGMA foreign_keys = ON')
  for (const sql of await migrations()) db.exec(sql)
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
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    APPLE_CLIENT_ID: 'dev.gui.signin',
    APPLE_TEAM_ID: 'TEAM',
    APPLE_KEY_ID: 'KEY',
    APPLE_PRIVATE_KEY: await applePrivateKey(),
    EMAIL: {
      async send(message) {
        sentEmails.push(message)
      },
    },
    EMAIL_LIMITER: { limit: async () => ({ success: true }) },
  }
  sentEmails = []
  googleUser = { sub: 'g-1', email: 'test@example.com', email_verified: true, name: 'Google User' }
  appleSubject = 'apple-1'
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
    const params = new URLSearchParams(String(init?.body ?? ''))
    if (url.hostname === 'oauth2.googleapis.com') {
      expect(params.get('client_secret')).toBe('google-secret')
      return Response.json({
        id_token: idToken({
          iss: 'https://accounts.google.com',
          aud: 'google-client',
          ...googleUser,
        }),
      })
    }
    if (url.hostname === 'appleid.apple.com') {
      // A signed ES256 client secret, never the key itself.
      expect(params.get('client_secret')?.split('.')).toHaveLength(3)
      expect(params.get('client_secret')).not.toContain('PRIVATE')
      return Response.json({
        id_token: idToken({
          iss: 'https://appleid.apple.com',
          aud: 'dev.gui.signin',
          sub: appleSubject,
          email: 'relay@privaterelay.appleid.com',
          email_verified: 'true',
        }),
      })
    }
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
async function applePrivateKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  return `-----BEGIN PRIVATE KEY-----\n${der.toString('base64')}\n-----END PRIVATE KEY-----`
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
    // Not subscribed until the person says so.
    account: { email: 'test@example.com', updates: false, providers: ['github'] },
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
  expect(await (await call('/account', session)).json()).toMatchObject({
    profile: { email: null, updates: false },
  })
  expect((await call('/account/updates', session, 'POST', { updates: true })).status).toBe(400)
  expect((await call('/repositories', session)).status).toBe(200)
})

test('preferences survive repeat login by immutable GitHub identity; logout invalidates only its session', async () => {
  const first = await login()
  // Opting in sticks: signing in again doesn't change the choice.
  expect((await call('/account/updates', first.session, 'POST', { updates: true })).status).toBe(
    200,
  )
  const second = await login()
  expect(db.query('SELECT count(*) AS n FROM users').get()).toEqual({ n: 1 })
  expect(db.query('SELECT count(*) AS n FROM accounts').get()).toEqual({ n: 1 })
  expect(await (await call('/account', second.session)).json()).toMatchObject({
    account: { updates: true },
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
  for (const table of ['users', 'accounts', 'identities', 'sessions'])
    expect(db.query(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 })
})

test('sign-in throttling stops provider calls before creating attempts', async () => {
  env.LOGIN_LIMITER = { limit: async () => ({ success: false }) }
  expect((await call('/github/start', undefined, 'POST')).status).toBe(429)
  expect(db.query('SELECT count(*) AS n FROM login_attempts').get()).toEqual({ n: 0 })
})

/** What the browser does: follows the worker's pages, but never the loopback redirect. */
async function browse(path: string, init?: RequestInit) {
  return worker.fetch(new Request(`https://accounts.test${path}`, init), env)
}
async function start(session?: string) {
  const response = await call('/auth/start', session, 'POST', { port: 49152 })
  expect(response.status).toBe(200)
  return (await response.json()) as { attempt: string; id: string }
}
/** Gui's loopback gets the one-time code; Gui trades it for a session. */
async function collect(attempt: string, response: Response) {
  expect(response.status).toBe(303)
  const location = new URL(response.headers.get('Location') ?? '')
  expect(location.origin).toBe('http://127.0.0.1:49152')
  const code = location.searchParams.get('code') ?? ''
  const token = await call('/auth/token', attempt, 'POST', { code })
  expect(token.status).toBe(200)
  const body = (await token.json()) as { session: string | null }
  // Once only.
  expect((await call('/auth/token', attempt, 'POST', { code })).status).toBe(401)
  return body.session
}
async function providerState(id: string, provider: string) {
  const redirect = await browse(`/signin/${provider}?a=${id}`)
  expect(redirect.status).toBe(302)
  return new URL(redirect.headers.get('Location') ?? '').searchParams.get('state') ?? ''
}
async function signInWithGoogle() {
  const { attempt, id } = await start()
  const state = await providerState(id, 'google')
  const session = await collect(attempt, await browse(`/callback/google?code=c&state=${state}`))
  if (!session) throw new Error('No session')
  return { session, state }
}

test('migrating keeps GitHub users signed in, and only an explicit email choice carries over', async () => {
  db.close()
  db = new SQLite(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const [first, second] = await migrations()
  db.exec(first ?? '')
  db.exec(`INSERT INTO users (github_id, login, email, updates, preference_changed_at, created_at, last_login_at, github_token, token_expires_at)
    VALUES (1, 'defaulted', 'a@example.com', 1, NULL, 1, 1, 'x', 1), (2, 'chose', 'b@example.com', 1, 5, 1, 1, 'x', 1)`)
  db.exec(`INSERT INTO sessions VALUES ('hash-1', 1, 9999999999), ('hash-2', 2, 9999999999)`)
  db.exec(second ?? '')
  expect(db.query('SELECT email, updates FROM accounts ORDER BY email').all()).toEqual([
    { email: 'a@example.com', updates: 0 },
    { email: 'b@example.com', updates: 1 },
  ])
  expect(
    db
      .query('SELECT users.login FROM sessions JOIN users USING (account_id) ORDER BY token_hash')
      .all(),
  ).toEqual([{ login: 'defaulted' }, { login: 'chose' }])
  expect(db.query("SELECT count(*) AS n FROM identities WHERE provider = 'github'").get()).toEqual({
    n: 2,
  })
})

test('Google sign-in goes through the browser and back to Gui by loopback, once', async () => {
  const { session, state } = await signInWithGoogle()
  expect(await (await call('/account', session)).json()).toMatchObject({
    account: {
      email: 'test@example.com',
      name: 'Google User',
      updates: false,
      providers: ['google'],
    },
    profile: null,
  })
  // The provider's state is single-use.
  expect((await browse(`/callback/google?code=c&state=${state}`)).status).toBe(400)
  // No GitHub yet: repositories ask for it without signing Gui out.
  expect((await call('/repositories', session)).status).toBe(403)
})

test('a cancelled or expired browser sign-in shows a page and creates nothing', async () => {
  const { attempt, id } = await start()
  const state = await providerState(id, 'google')
  const cancelled = await browse(`/callback/google?error=access_denied&state=${state}`)
  expect(cancelled.status).toBe(400)
  expect(await cancelled.text()).toContain('Sign-in was cancelled')
  expect((await call('/auth/token', attempt, 'POST', { code: 'guess' })).status).toBe(401)
  const later = await start()
  db.exec('UPDATE auth_attempts SET expires_at = 0')
  expect((await browse(`/signin/google?a=${later.id}`)).status).toBe(400)
  expect(db.query('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
})

test('Apple posts its answer back, and its first-time name is kept', async () => {
  const { attempt, id } = await start()
  const state = await providerState(id, 'apple')
  const response = await browse('/callback/apple', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: 'c',
      state,
      user: JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' } }),
    }),
  })
  const session = await collect(attempt, response)
  expect(await (await call('/account', session ?? undefined)).json()).toMatchObject({
    account: {
      name: 'Ada Lovelace',
      email: 'relay@privaterelay.appleid.com',
      providers: ['apple'],
    },
  })
})

test('the same verified email reaches one account, whichever way someone signs in', async () => {
  const google = await signInWithGoogle()
  const github = await login()
  expect(db.query('SELECT count(*) AS n FROM accounts').get()).toEqual({ n: 1 })
  expect(await (await call('/account', github.session)).json()).toMatchObject({
    account: { providers: ['google', 'github'] },
  })
  expect((await call('/account', google.session)).status).toBe(200)
  // An unverified email never joins an existing account.
  googleUser = { sub: 'g-2', email: 'test@example.com', email_verified: false, name: 'Other' }
  await signInWithGoogle()
  expect(db.query('SELECT count(*) AS n FROM accounts').get()).toEqual({ n: 2 })
})

test('emailed sign-in: a code typed into Gui, limited tries, no account until it matches', async () => {
  const { attempt } = await start()
  expect((await call('/auth/email', attempt, 'POST', { email: 'not an email' })).status).toBe(400)
  expect(
    (await call('/auth/email', attempt, 'POST', { email: 'Designer@Example.com' })).status,
  ).toBe(200)
  const message = sentEmails[0]
  if (!message) throw new Error('No email')
  expect(message.to).toBe('Designer@Example.com')
  const code = /(\d{6})/.exec(message.subject)?.[1] ?? ''
  expect(message.text).toContain(code)
  const wrong = code === '000000' ? '111111' : '000000'
  expect((await call('/auth/email/code', attempt, 'POST', { code: wrong })).status).toBe(400)
  expect(db.query('SELECT count(*) AS n FROM accounts').get()).toEqual({ n: 0 })
  const right = await call('/auth/email/code', attempt, 'POST', { code })
  expect(right.status).toBe(200)
  const { session } = (await right.json()) as { session: string }
  expect(await (await call('/account', session)).json()).toMatchObject({
    account: { email: 'Designer@Example.com', providers: ['email'] },
  })
  // Used up.
  expect((await call('/auth/email/code', attempt, 'POST', { code })).status).toBe(401)
})

test('wrong email codes run out', async () => {
  const { attempt } = await start()
  await call('/auth/email', attempt, 'POST', { email: 'designer@example.com' })
  const code = /(\d{6})/.exec(sentEmails[0]?.subject ?? '')?.[1] ?? ''
  const wrong = code === '000000' ? '111111' : '000000'
  for (let i = 0; i < 5; i++) await call('/auth/email/code', attempt, 'POST', { code: wrong })
  expect((await call('/auth/email/code', attempt, 'POST', { code })).status).toBe(429)
})

test('emailed link: opening it only asks, and confirming signs in on this Mac once', async () => {
  const { attempt } = await start()
  await call('/auth/email', attempt, 'POST', { email: 'designer@example.com' })
  const link = new URL(/https:\/\/\S+/.exec(sentEmails[0]?.text ?? '')?.[0] ?? '')
  const token = link.searchParams.get('t') ?? ''
  // A mail scanner opening the link changes nothing.
  const opened = await browse(`${link.pathname}${link.search}`)
  expect(opened.status).toBe(200)
  expect(await opened.text()).toContain('<form method="post" action="/email">')
  expect(db.query('SELECT count(*) AS n FROM accounts').get()).toEqual({ n: 0 })
  const confirm = () =>
    browse('/email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ t: token }),
    })
  const session = await collect(attempt, await confirm())
  expect((await call('/account', session ?? undefined)).status).toBe(200)
  expect((await confirm()).status).toBe(400)
})

test('sign-in emails are limited per address and per sign-in', async () => {
  const { attempt } = await start()
  for (let i = 0; i < 3; i++)
    expect((await call('/auth/email', attempt, 'POST', { email: 'a@example.com' })).status).toBe(
      200,
    )
  expect((await call('/auth/email', attempt, 'POST', { email: 'a@example.com' })).status).toBe(429)
  env.EMAIL_LIMITER = { limit: async () => ({ success: false }) }
  const other = await start()
  expect(
    (await call('/auth/email', other.attempt, 'POST', { email: 'b@example.com' })).status,
  ).toBe(429)
  expect(sentEmails).toHaveLength(3)
})

test('GitHub connects to a signed-in account, and disconnecting keeps Gui signed in', async () => {
  const { session } = await signInWithGoogle()
  const link = await start(session)
  const state = await providerState(link.id, 'github')
  expect(
    await collect(link.attempt, await browse(`/callback/github?code=c&state=${state}`)),
  ).toBeNull()
  expect(await (await call('/account', session)).json()).toMatchObject({
    account: { providers: ['google', 'github'] },
    profile: { login: 'tester' },
  })
  expect((await call('/repositories', session)).status).toBe(200)
  expect((await call('/github', session, 'DELETE')).status).toBe(200)
  expect((await call('/repositories', session)).status).toBe(403)
  expect((await call('/account', session)).status).toBe(200)
})

test('a GitHub user already in another account cannot be linked to this one', async () => {
  await login()
  googleUser = { sub: 'g-9', email: 'someone@example.com', email_verified: true, name: 'Someone' }
  const { session } = await signInWithGoogle()
  const link = await start(session)
  const state = await providerState(link.id, 'github')
  const response = await browse(`/callback/github?code=c&state=${state}`)
  expect(response.status).toBe(409)
  expect(await response.text()).toContain('another Gui account')
  expect((await call('/repositories', session)).status).toBe(403)
})

test('ways of signing in that are not set up say so instead of failing', async () => {
  env.GOOGLE_CLIENT_SECRET = undefined
  const { id } = await start()
  expect((await browse(`/signin/google?a=${id}`)).status).toBe(503)
  env.EMAIL = undefined
  const { attempt } = await start()
  expect((await call('/auth/email', attempt, 'POST', { email: 'a@example.com' })).status).toBe(503)
})
