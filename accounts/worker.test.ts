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
let githubUnauthorized: boolean
let installationUnauthorized: boolean
let workosUser: {
  id: string
  email: string
  email_verified: boolean
  first_name: string | null
  last_name: string | null
}
let revokedSessions: string[]
let deletedUsers: string[]
let appKey: CryptoKeyPair
let tokenRequests: { installation: string; body: unknown }[]

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const jwt = (claims: Record<string, unknown>) =>
  `${encode({ alg: 'none' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 600, ...claims })}.sig`
const migrations = async () =>
  Promise.all(
    ['0001_accounts.sql', '0002_gui_accounts.sql', '0003_workos.sql'].map((name) =>
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
    WORKOS_CLIENT_ID: 'client_workos',
    WORKOS_API_KEY: 'sk_test_workos',
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: await appPrivateKey(),
  }
  workosUser = {
    id: 'user_1',
    email: 'test@example.com',
    email_verified: true,
    first_name: 'Ada',
    last_name: 'Lovelace',
  }
  revokedSessions = []
  deletedUsers = []
  providerError = null
  emailVerified = true
  secondAccount = false
  installationPages = []
  refreshCalls = 0
  githubUnauthorized = false
  installationUnauthorized = false
  tokenRequests = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.hostname === 'api.github.com' && githubUnauthorized)
      return Response.json({ message: 'Bad credentials' }, { status: 401 })
    const params = new URLSearchParams(String(init?.body ?? ''))
    if (url.hostname === 'api.workos.com') {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer sk_test_workos')
      if (init?.method === 'DELETE') {
        deletedUsers.push(url.pathname.split('/').pop() ?? '')
        return new Response(null, { status: 202 })
      }
      const body = JSON.parse(String(init?.body))
      if (url.pathname === '/user_management/sessions/revoke') {
        revokedSessions.push(body.session_id)
        return Response.json({})
      }
      expect(url.pathname).toBe('/user_management/authenticate')
      expect(body).toMatchObject({
        client_id: 'client_workos',
        client_secret: 'sk_test_workos',
        grant_type: 'authorization_code',
      })
      if (body.code !== 'c') return Response.json({ error: 'invalid_grant' }, { status: 400 })
      return Response.json({
        user: workosUser,
        access_token: jwt({ sid: `session_${workosUser.id}` }),
        refresh_token: 'workos-refresh',
        authentication_method: 'GoogleOAuth',
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
    const minting = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(url.pathname)
    if (minting) {
      if (installationUnauthorized)
        return Response.json({ message: 'Bad credentials' }, { status: 401 })
      // Signed by the app's key, as the app: never with the user's token.
      const jwt = new Headers(init?.headers).get('Authorization')?.replace(/^Bearer /, '') ?? ''
      const [header, claims, signature] = jwt.split('.')
      expect(
        await crypto.subtle.verify(
          'RSASSA-PKCS1-v1_5',
          appKey.publicKey,
          Buffer.from(signature, 'base64url'),
          new TextEncoder().encode(`${header}.${claims}`),
        ),
      ).toBe(true)
      expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({
        iss: '12345',
      })
      tokenRequests.push({ installation: minting[1], body: JSON.parse(String(init?.body)) })
      return Response.json({ token: `repository-token-${minting[1]}` }, { status: 201 })
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
/** The GitHub App's key, as GitHub hands it out: PKCS#1 PEM. */
async function appPrivateKey() {
  appKey = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
  // A 2048-bit key's PKCS#8 wrapping is 26 bytes ahead of the PKCS#1 key inside it.
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', appKey.privateKey)).subarray(26)
  return `-----BEGIN RSA PRIVATE KEY-----\n${der.toString('base64')}\n-----END RSA PRIVATE KEY-----`
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
    // A new account must choose to receive product updates.
    account: { email: 'test@example.com', updates: false },
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
  // Opting in sticks: signing in again does not change the choice.
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
  // A read-only token for that one repository's contents, from the installation that reaches
  // it: seeing a repository through the installation doesn't mean the user may push to it.
  expect(await (await call('/repositories/101/credential', first.session, 'POST')).json()).toEqual({
    token: 'repository-token-11',
    fullName: 'tester/last',
  })
  expect(tokenRequests).toEqual([
    {
      installation: '11',
      body: {
        repository_ids: [101],
        permissions: { contents: 'read' },
      },
    },
  ])
  secondAccount = true
  const second = await login()
  expect((await call('/repositories/101/credential', second.session, 'POST')).status).toBe(403)
  expect((await call('/repositories/999/credential', second.session, 'POST')).status).toBe(200)
})

test('without the app key, credentials are unavailable rather than the user token', async () => {
  env.GITHUB_APP_PRIVATE_KEY = undefined
  const { session } = await login()
  const response = await call('/repositories/101/credential', session, 'POST')
  expect(response.status).toBe(503)
  expect(await response.text()).not.toContain('provider-secret')
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
async function signIn() {
  const { attempt, id } = await start()
  const state = await providerState(id, 'workos')
  const session = await collect(attempt, await browse(`/callback/workos?code=c&state=${state}`))
  if (!session) throw new Error('No session')
  return { session, state }
}

test('migrating keeps GitHub users signed in, and only an explicit email choice carries over', async () => {
  db.close()
  db = new SQLite(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  const [first, second, third] = await migrations()
  db.exec(first ?? '')
  db.exec(`INSERT INTO users (github_id, login, email, updates, preference_changed_at, created_at, last_login_at, github_token, token_expires_at)
    VALUES (1, 'defaulted', 'a@example.com', 1, NULL, 1, 1, 'x', 1), (2, 'chose', 'b@example.com', 1, 5, 1, 1, 'x', 1)`)
  db.exec(`INSERT INTO sessions VALUES ('hash-1', 1, 9999999999), ('hash-2', 2, 9999999999)`)
  db.exec(second ?? '')
  db.exec(third ?? '')
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

test('sign-in goes through AuthKit in the browser and back to Gui by loopback, once', async () => {
  const { attempt, id } = await start()
  const redirect = new URL((await browse(`/signin/workos?a=${id}`)).headers.get('Location') ?? '')
  expect(redirect.origin + redirect.pathname).toBe(
    'https://api.workos.com/user_management/authorize',
  )
  expect(Object.fromEntries(redirect.searchParams)).toMatchObject({
    client_id: 'client_workos',
    provider: 'authkit',
    response_type: 'code',
    redirect_uri: 'https://accounts.test/callback/workos',
  })
  const state = redirect.searchParams.get('state') ?? ''
  const session = await collect(attempt, await browse(`/callback/workos?code=c&state=${state}`))
  expect(await (await call('/account', session ?? undefined)).json()).toMatchObject({
    account: { email: 'test@example.com', name: 'Ada Lovelace', updates: false },
    profile: null,
  })
  // Gui keeps its own session; WorkOS's ends, so signing in again asks again.
  expect(revokedSessions).toEqual(['session_user_1'])
  // The state is single-use.
  expect((await browse(`/callback/workos?code=c&state=${state}`)).status).toBe(400)
  // No GitHub yet: repositories ask for it without signing Gui out.
  expect((await call('/repositories', session ?? undefined)).status).toBe(403)
})

test('a cancelled, refused, or expired browser sign-in shows a page and creates nothing', async () => {
  const { attempt, id } = await start()
  const state = await providerState(id, 'workos')
  const cancelled = await browse(`/callback/workos?error=access_denied&state=${state}`)
  expect(cancelled.status).toBe(400)
  expect(await cancelled.text()).toContain('Sign-in was cancelled')
  expect((await call('/auth/token', attempt, 'POST', { code: 'guess' })).status).toBe(401)
  const refused = await start()
  const refusedState = await providerState(refused.id, 'workos')
  expect((await browse(`/callback/workos?code=stale&state=${refusedState}`)).status).toBe(502)
  const later = await start()
  db.exec('UPDATE auth_attempts SET expires_at = 0')
  expect((await browse(`/signin/workos?a=${later.id}`)).status).toBe(400)
  expect(db.query('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 })
  expect(db.query('SELECT count(*) AS n FROM accounts').get()).toEqual({ n: 0 })
})

test('the same verified email reaches one account, from WorkOS or Gui’s GitHub sign-in', async () => {
  const github = await login()
  const workos = await signIn()
  expect(db.query('SELECT count(*) AS n FROM accounts').get()).toEqual({ n: 1 })
  expect(await (await call('/account', workos.session)).json()).toMatchObject({
    profile: { login: 'tester' },
  })
  expect((await call('/account', github.session)).status).toBe(200)
  // An unverified email never joins an existing account.
  workosUser = { ...workosUser, id: 'user_2', email_verified: false }
  await signIn()
  expect(db.query('SELECT count(*) AS n FROM accounts').get()).toEqual({ n: 2 })
})

test('GitHub connects to a signed-in account, and disconnecting keeps Gui signed in', async () => {
  const { session } = await signIn()
  const link = await start(session)
  // WorkOS is for signing in; this attempt only connects GitHub.
  expect((await browse(`/signin/workos?a=${link.id}`)).status).toBe(400)
  const state = await providerState(link.id, 'github')
  expect(
    await collect(link.attempt, await browse(`/callback/github?code=c&state=${state}`)),
  ).toBeNull()
  expect(await (await call('/account', session)).json()).toMatchObject({
    profile: { login: 'tester' },
  })
  expect((await call('/repositories', session)).status).toBe(200)
  expect((await call('/github', session, 'DELETE')).status).toBe(200)
  expect((await call('/repositories', session)).status).toBe(403)
  expect((await call('/account', session)).status).toBe(200)
})

test('GitHub in the browser only connects; it does not sign in', async () => {
  const { id } = await start()
  expect((await browse(`/signin/github?a=${id}`)).status).toBe(400)
})

test('a GitHub user already in another account cannot be linked to this one', async () => {
  await login()
  workosUser = { ...workosUser, id: 'user_9', email: 'someone@example.com' }
  const { session } = await signIn()
  const link = await start(session)
  const state = await providerState(link.id, 'github')
  const response = await browse(`/callback/github?code=c&state=${state}`)
  expect(response.status).toBe(409)
  expect(await response.text()).toContain('another Gui account')
  expect((await call('/repositories', session)).status).toBe(403)
})

test('signing in that is not set up says so instead of failing', async () => {
  env.WORKOS_API_KEY = undefined
  const { id } = await start()
  expect((await browse(`/signin/workos?a=${id}`)).status).toBe(503)
  expect((await browse(`/signin/google?a=${id}`)).status).toBe(404)
})

test('deleting the Gui account deletes the person at WorkOS too', async () => {
  const { session } = await signIn()
  expect((await call('/account', session, 'DELETE')).status).toBe(200)
  expect(deletedUsers).toEqual(['user_1'])
  expect(db.query('SELECT count(*) AS n FROM accounts').get()).toEqual({ n: 0 })
  expect((await call('/account', session)).status).toBe(401)
})

for (const failure of ['no refresh token', 'rejected refresh', 'provider unauthorized'] as const) {
  test(`GitHub ${failure} asks to reconnect while retaining the Gui session`, async () => {
    const { session } = await login()
    if (failure === 'no refresh token')
      db.exec('UPDATE users SET token_expires_at = 0, refresh_token = NULL')
    if (failure === 'rejected refresh') {
      db.exec('UPDATE users SET token_expires_at = 0')
      providerError = 'bad_refresh_token'
    }
    if (failure === 'provider unauthorized') githubUnauthorized = true
    const response = await call('/repositories', session)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'github_reconnect_required' })
    expect((await call('/account', session)).status).toBe(200)
  })
}

test('invalid Gui sessions have their own stable error code', async () => {
  const { session } = await login()
  db.exec('UPDATE sessions SET expires_at = 0')
  const response = await call('/account', session)
  expect(response.status).toBe(401)
  expect(await response.json()).toMatchObject({ code: 'account_session_invalid' })
})

test('refused service app credentials do not ask the user to reconnect GitHub', async () => {
  const { session } = await login()
  installationUnauthorized = true
  const response = await call('/repositories/101/credential', session, 'POST')
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: 'Cloning through Gui is unavailable right now.' })
  expect((await call('/account', session)).status).toBe(200)
})
