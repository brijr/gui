import type { IdentityProvider, SignInProvider } from '../../src/shared/account'
import type { GitHubProfile, GitHubRepository } from '../../src/shared/github'

// Only the D1 operations this service uses. Bun's SQLite test adapter implements the same contract.
export interface Statement {
  bind(...values: unknown[]): Statement
  first<T>(): Promise<T | null>
  all<T>(): Promise<{ results: T[] }>
  run(): Promise<{ meta: { changes: number } }>
}
export interface Database {
  prepare(sql: string): Statement
  batch(statements: Statement[]): Promise<unknown>
}
export interface EmailMessage {
  to: string
  from: string
  subject: string
  html: string
  text: string
}
export interface Env {
  DB: Database
  LOGIN_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> }
  /** Sign-in emails per address, so the service can't be used to flood someone's inbox. */
  EMAIL_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> }
  /** Cloudflare Email Service's send_email binding. */
  EMAIL?: { send(message: EmailMessage): Promise<unknown> }
  EMAIL_FROM?: string
  GITHUB_CLIENT_ID: string
  GITHUB_APP_SLUG: string
  GITHUB_CLIENT_SECRET: string
  /** The GitHub App's ID and private key, which mint the per-repository tokens Gui pushes with. */
  GITHUB_APP_ID?: string
  GITHUB_APP_PRIVATE_KEY?: string
  TOKEN_ENCRYPTION_KEY: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  /** Sign in with Apple: the Services ID, team, and the .p8 key that signs the client secret. */
  APPLE_CLIENT_ID?: string
  APPLE_TEAM_ID?: string
  APPLE_KEY_ID?: string
  APPLE_PRIVATE_KEY?: string
}
interface Account {
  id: string
  email: string | null
  name: string | null
  updates: number
}
/** An account's GitHub connection (the `users` table): the tokens behind repositories. */
interface User {
  github_id: number
  account_id: string
  login: string
  name: string | null
  email: string | null
  github_token: string
  refresh_token: string | null
  token_expires_at: number
}
interface Attempt {
  token_hash: string
  public_id: string
  port: number
  link_account_id: string | null
  provider: string | null
  email: string | null
  email_code_hash: string | null
  email_tries: number
  emails_sent: number
  account_id: string | null
  exchange_hash: string | null
  expires_at: number
}
/** Who signed in, as the provider vouches for them. `email` is only ever a verified one. */
interface Identity {
  provider: IdentityProvider
  subject: string
  email: string | null
  name: string | null
}
interface ProviderToken {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
}
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
const now = () => Math.floor(Date.now() / 1000)
const random = () => crypto.randomUUID() + crypto.randomUUID()
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('')
const hash = async (value: string) =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
const SESSION_SECONDS = 180 * 86400
const ATTEMPT_SECONDS = 15 * 60
const EMAIL_TRIES = 5
const EMAILS_PER_ATTEMPT = 3
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
}
async function key(env: Env) {
  if (!/^[a-f\d]{64}$/i.test(env.TOKEN_ENCRYPTION_KEY))
    throw new HttpError(503, 'Account service is not configured.')
  const bytes = new Uint8Array(
    (env.TOKEN_ENCRYPTION_KEY.match(/../g) ?? []).map((v) => Number.parseInt(v, 16)),
  )
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}
async function encrypt(env: Env, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const bytes = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await key(env),
    new TextEncoder().encode(value),
  )
  return `${hex(iv.buffer)}:${hex(bytes)}`
}
async function decrypt(env: Env, value: string) {
  const [iv, data] = value
    .split(':')
    .map((v) => new Uint8Array((v.match(/../g) ?? []).map((b) => Number.parseInt(b, 16))))
  return new TextDecoder().decode(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await key(env), data),
  )
}
/** A form POST to a provider's token endpoint, answered in JSON. */
async function form<T>(url: string, values: Record<string, string>, name: string): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Gui',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(values).toString(),
    signal: AbortSignal.timeout(15_000),
    redirect: 'manual',
  })
  if (!res.ok) throw new HttpError(502, `${name} could not complete sign-in. Try again.`)
  return res.json() as Promise<T>
}
function gitHubOAuth(path: string, values: Record<string, string>) {
  return form<
    ProviderToken & { device_code: string; user_code: string; interval: number; expires_in: number }
  >(`https://github.com/${path}`, values, 'GitHub')
}
async function github<T>(token: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Gui',
      'X-GitHub-Api-Version': '2026-03-10',
    },
    signal: AbortSignal.timeout(15_000),
    redirect: 'manual',
  })
  if (res.status === 401) throw new HttpError(401, 'GitHub access expired. Reconnect GitHub.')
  if (res.status === 422)
    throw new HttpError(
      409,
      'GitHub could not create this project. Check the name or choose a different one.',
    )
  if (res.status === 403 || res.status === 429)
    throw new HttpError(429, 'GitHub access is unavailable or rate limited. Try again later.')
  if (!res.ok) throw new HttpError(502, 'Could not reach GitHub. Try again.')
  return res.json() as Promise<T>
}
const bearerToken = (request: Request) =>
  request.headers.get('Authorization')?.match(/^Bearer ([a-f\d-]{72})$/i)?.[1]
async function session(
  request: Request,
  env: Env,
): Promise<{ account: Account; tokenHash: string }> {
  const bearer = bearerToken(request)
  if (!bearer) throw new HttpError(401, 'Sign in to Gui to continue.')
  const tokenHash = await hash(bearer)
  const found = await env.DB.prepare(
    'SELECT accounts.*, sessions.expires_at AS session_expires_at FROM accounts JOIN sessions ON sessions.account_id = accounts.id WHERE token_hash = ? AND expires_at > ?',
  )
    .bind(tokenHash, now())
    .first<Account & { session_expires_at: number }>()
  if (!found) throw new HttpError(401, 'Your Gui session expired. Sign in again.')
  // A Gui that's used stays signed in: the session moves forward once it's a month old.
  if (found.session_expires_at < now() + SESSION_SECONDS - 30 * 86400)
    await env.DB.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')
      .bind(now() + SESSION_SECONDS, tokenHash)
      .run()
  return { account: found, tokenHash }
}
async function connection(env: Env, account: Account) {
  const user = await env.DB.prepare('SELECT * FROM users WHERE account_id = ?')
    .bind(account.id)
    .first<User>()
  // Not 401: the Gui session is fine, and older Gui versions sign out on 401.
  if (!user) throw new HttpError(403, 'Connect GitHub in Settings → GitHub to continue.')
  return user
}
async function accessToken(env: Env, user: User) {
  if (user.token_expires_at > now() + 60) return decrypt(env, user.github_token)
  if (!user.refresh_token) throw new HttpError(401, 'GitHub access expired. Reconnect GitHub.')
  const lock = await env.DB.prepare(
    'UPDATE users SET refresh_lock_until = ? WHERE github_id = ? AND refresh_lock_until < ?',
  )
    .bind(now() + 30, user.github_id, now())
    .run()
  if (!lock.meta.changes)
    throw new HttpError(409, 'GitHub connection is refreshing. Try again shortly.')
  try {
    // Another request may have refreshed between the session read and acquiring the lock.
    const fresh = await env.DB.prepare('SELECT * FROM users WHERE github_id = ?')
      .bind(user.github_id)
      .first<User>()
    if (!fresh) throw new HttpError(401, 'Reconnect GitHub.')
    if (fresh.token_expires_at > now() + 60) return decrypt(env, fresh.github_token)
    if (!fresh.refresh_token) throw new HttpError(401, 'Reconnect GitHub.')
    const data = await gitHubOAuth('login/oauth/access_token', {
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: await decrypt(env, fresh.refresh_token),
    })
    if (!data.access_token || !data.refresh_token)
      throw new HttpError(401, 'GitHub access expired. Reconnect GitHub.')
    await env.DB.prepare(
      'UPDATE users SET github_token = ?, refresh_token = ?, token_expires_at = ? WHERE github_id = ?',
    )
      .bind(
        await encrypt(env, data.access_token),
        await encrypt(env, data.refresh_token),
        now() + (data.expires_in ?? 28800),
        user.github_id,
      )
      .run()
    return data.access_token
  } finally {
    await env.DB.prepare('UPDATE users SET refresh_lock_until = 0 WHERE github_id = ?')
      .bind(user.github_id)
      .run()
  }
}
/** A repository, with the app installation that reaches it. */
interface ConnectedRepository extends GitHubRepository {
  installationId: number
}

async function repositories(token: string): Promise<ConnectedRepository[]> {
  const output: ConnectedRepository[] = []
  for (let page = 1; ; page++) {
    const { installations } = await github<{ installations: { id: number }[] }>(
      token,
      `/user/installations?per_page=100&page=${page}`,
    )
    for (const installation of installations) {
      for (let repoPage = 1; ; repoPage++) {
        const result = await github<{
          repositories: { id: number; full_name: string; private: boolean }[]
        }>(
          token,
          `/user/installations/${installation.id}/repositories?per_page=100&page=${repoPage}`,
        )
        output.push(
          ...result.repositories.map((repo) => ({
            id: repo.id,
            fullName: repo.full_name,
            private: repo.private,
            installationId: installation.id,
          })),
        )
        if (result.repositories.length < 100) break
      }
    }
    if (installations.length < 100) break
  }
  return [...new Map(output.map((repo) => [repo.id, repo])).values()].sort((a, b) =>
    a.fullName.localeCompare(b.fullName),
  )
}

/**
 * A token for one repository that can only read and write its contents and read its pull
 * requests, valid for an hour: what Gui clones, pushes, and follows a pull request with. Never the user's own token, which reaches every connected
 * repository with every permission the app has (administration among them), and which git
 * hooks in the project could read from the push's environment.
 */
async function repositoryToken(env: Env, repo: ConnectedRepository) {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY)
    throw new HttpError(503, 'Pushing through Gui is unavailable right now.')
  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY)
  const { token } = await github<{ token: string }>(
    jwt,
    `/app/installations/${repo.installationId}/access_tokens`,
    { repository_ids: [repo.id], permissions: { contents: 'write', pull_requests: 'read' } },
  ).catch((error: unknown) => {
    // The app's own credentials were refused: that's the service's setup, not the user's.
    if (error instanceof HttpError && error.status === 401)
      throw new HttpError(503, 'Pushing through Gui is unavailable right now.')
    throw error
  })
  return token
}

/** The GitHub App's JWT (RS256), for minting installation tokens. */
async function appJwt(appId: string, privateKey: string) {
  const pkcs1 = privateKey.includes('BEGIN RSA PRIVATE KEY')
  const der = Uint8Array.from(atob(privateKey.replace(/-----[^-]+-----|\s/g, '')), (c) =>
    c.charCodeAt(0),
  )
  const signer = await crypto.subtle.importKey(
    'pkcs8',
    pkcs1 ? pkcs1ToPkcs8(der) : der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  // Backdated a minute for clock drift; GitHub allows ten minutes at most.
  const input = `${encodeJson({ alg: 'RS256', typ: 'JWT' })}.${encodeJson({
    iss: appId,
    iat: now() - 60,
    exp: now() + 540,
  })}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signer,
    new TextEncoder().encode(input),
  )
  return `${input}.${base64url(new Uint8Array(signature))}`
}

/** GitHub hands out PKCS#1 keys; WebCrypto only imports PKCS#8, which wraps one. */
function pkcs1ToPkcs8(pkcs1: Uint8Array) {
  const length = (n: number) => {
    if (n < 0x80) return [n]
    const bytes: number[] = []
    for (; n > 0; n >>= 8) bytes.unshift(n & 0xff)
    return [0x80 | bytes.length, ...bytes]
  }
  // version 0, then AlgorithmIdentifier { rsaEncryption, NULL }
  const rsa = [0x02, 0x01, 0x00, 0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d]
  const body = [...rsa, 0x01, 0x01, 0x01, 0x05, 0x00, 0x04, ...length(pkcs1.length)]
  return new Uint8Array([0x30, ...length(body.length + pkcs1.length), ...body, ...pkcs1])
}

/**
 * The account an identity signs in to: the one it's already part of, else the account with
 * the same verified email (so Google and an emailed link reach one account), else a new one.
 * With `linkTo`, the identity joins that account, unless another account already has it.
 */
async function accountFor(env: Env, identity: Identity, linkTo?: string | null): Promise<string> {
  const known = await env.DB.prepare(
    'SELECT account_id FROM identities WHERE provider = ? AND subject = ?',
  )
    .bind(identity.provider, identity.subject)
    .first<{ account_id: string }>()
  if (linkTo && known && known.account_id !== linkTo)
    throw new HttpError(409, 'This sign-in already belongs to another Gui account.')
  let id = linkTo ?? known?.account_id ?? null
  if (!id && identity.email)
    id =
      (
        await env.DB.prepare(
          'SELECT id FROM accounts WHERE email = ? COLLATE NOCASE ORDER BY created_at LIMIT 1',
        )
          .bind(identity.email)
          .first<{ id: string }>()
      )?.id ?? null
  const created = !id
  if (!id) {
    id = crypto.randomUUID()
    // Product updates start off. The app asks, and sets them if the person says yes.
    await env.DB.prepare(
      'INSERT INTO accounts (id, email, name, updates, created_at, last_login_at) VALUES (?, ?, ?, 0, ?, ?)',
    )
      .bind(id, identity.email, identity.name, now(), now())
      .run()
  }
  if (!known)
    await env.DB.prepare(
      'INSERT OR IGNORE INTO identities (provider, subject, account_id, email, created_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(identity.provider, identity.subject, id, identity.email, now())
      .run()
  // Two first sign-ins at once: the identity went to whichever account was made first.
  const owner = await env.DB.prepare(
    'SELECT account_id FROM identities WHERE provider = ? AND subject = ?',
  )
    .bind(identity.provider, identity.subject)
    .first<{ account_id: string }>()
  if (!owner) throw new HttpError(500, 'Could not save the sign-in. Try again.')
  if (created && owner.account_id !== id)
    await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run()
  await env.DB.prepare(
    'UPDATE accounts SET last_login_at = ?, email = COALESCE(email, ?), name = COALESCE(name, ?) WHERE id = ?',
  )
    .bind(now(), identity.email, identity.name, owner.account_id)
    .run()
  return owner.account_id
}

/** The GitHub user behind a token, as an identity, with their verified primary email. */
async function gitHubIdentity(token: string) {
  const user = await github<{ id: number; login: string; name: string | null }>(token, '/user')
  const emails = await github<{ email: string; primary: boolean; verified: boolean }[]>(
    token,
    '/user/emails',
  )
  const email = emails.find((item) => item.primary && item.verified)?.email ?? null
  const identity: Identity = {
    provider: 'github',
    subject: String(user.id),
    email,
    name: user.name ?? user.login,
  }
  return { user, email, identity }
}

/** Saves the account's GitHub connection, replacing a different GitHub user it had before. */
async function saveConnection(
  env: Env,
  accountId: string,
  user: { id: number; login: string; name: string | null },
  email: string | null,
  data: ProviderToken & { access_token: string },
) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM users WHERE account_id = ? AND github_id != ?').bind(
      accountId,
      user.id,
    ),
    env.DB.prepare(`INSERT INTO users (github_id, account_id, login, name, email, created_at, last_login_at, github_token, refresh_token, token_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(github_id) DO UPDATE SET account_id=excluded.account_id, login=excluded.login, name=excluded.name, email=excluded.email,
      last_login_at=excluded.last_login_at, github_token=excluded.github_token, refresh_token=excluded.refresh_token, token_expires_at=excluded.token_expires_at`).bind(
      user.id,
      accountId,
      user.login,
      user.name,
      email,
      now(),
      now(),
      await encrypt(env, data.access_token),
      data.refresh_token ? await encrypt(env, data.refresh_token) : null,
      now() + (data.expires_in ?? 28800),
    ),
  ])
}

async function newSession(env: Env, accountId: string) {
  const token = random()
  await env.DB.prepare('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)')
    .bind(await hash(token), accountId, now() + SESSION_SECONDS)
    .run()
  return token
}

// ── Sign-in pages ────────────────────────────────────────────────────────────────────────

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  )

/** A small page in the browser, for what happens there: errors, and the emailed link. */
function page(title: string, body: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)} · Gui</title><style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;max-width:28rem;margin:15vh auto;padding:0 1.5rem}h1{font-size:1.375rem;margin:0 0 .5rem}p{margin:0 0 1rem;color:color-mix(in srgb,currentColor 70%,transparent)}button{font:inherit;font-weight:600;padding:.6rem 1rem;border-radius:.5rem;border:0;background:#2563eb;color:#fff;cursor:pointer}</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
    {
      status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
      },
    },
  )
}
const failed = (message: string, status = 400) =>
  page(
    'Sign-in didn’t finish',
    `<p>${escapeHtml(message)}</p><p>Go back to Gui and try again.</p>`,
    status,
  )

/** Sends the browser back to the Gui that started this sign-in, with a one-time code. */
async function finish(env: Env, attempt: Attempt, accountId: string) {
  const exchange = random()
  const done = await env.DB.prepare(
    'UPDATE auth_attempts SET account_id = ?, exchange_hash = ? WHERE token_hash = ? AND expires_at > ?',
  )
    .bind(accountId, await hash(exchange), attempt.token_hash, now())
    .run()
  if (!done.meta.changes) return failed('This sign-in expired.')
  return new Response(null, {
    status: 303,
    headers: {
      Location: `http://127.0.0.1:${attempt.port}/callback?code=${exchange}`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  })
}

function configured(env: Env, provider: SignInProvider) {
  if (provider === 'github') return !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)
  if (provider === 'google') return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
  return !!(env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY)
}
const isProvider = (value: string): value is SignInProvider =>
  value === 'google' || value === 'apple' || value === 'github'

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
const encodeJson = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)))

/**
 * Apple's client secret: a short-lived ES256 JWT signed with the Sign in with Apple key.
 * WebCrypto's ECDSA signature is already JWS's r‖s form.
 */
async function appleSecret(env: Env) {
  const pem = (env.APPLE_PRIVATE_KEY ?? '').replace(/-----[^-]+-----|\s/g, '')
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0))
  const signer = await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  const input = `${encodeJson({ alg: 'ES256', kid: env.APPLE_KEY_ID })}.${encodeJson({
    iss: env.APPLE_TEAM_ID,
    iat: now(),
    exp: now() + 300,
    aud: 'https://appleid.apple.com',
    sub: env.APPLE_CLIENT_ID,
  })}`
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signer,
    new TextEncoder().encode(input),
  )
  return `${input}.${base64url(new Uint8Array(signature))}`
}

/**
 * An ID token's claims. It comes straight from the provider's token endpoint over TLS, in
 * exchange for our client secret, so OpenID Connect lets us skip the signature; the issuer,
 * audience, and expiry are still checked.
 */
function idClaims(token: unknown, issuers: string[], audience: string) {
  if (typeof token !== 'string') throw new HttpError(502, 'Sign-in did not return an identity.')
  const part = token.split('.')[1] ?? ''
  const claims = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
    ),
  ) as {
    iss?: string
    aud?: string
    exp?: number
    sub?: string
    email?: string
    email_verified?: boolean | string
    name?: string
  }
  if (
    !claims.sub ||
    !issuers.includes(claims.iss ?? '') ||
    claims.aud !== audience ||
    !claims.exp ||
    claims.exp < now()
  )
    throw new HttpError(502, 'Sign-in returned an identity Gui could not check.')
  const verified = claims.email_verified === true || claims.email_verified === 'true'
  return { sub: claims.sub, email: verified ? (claims.email ?? null) : null, name: claims.name }
}

/** Where a provider sends the browser back to; registered with each provider. */
const callbackUrl = (request: Request, provider: SignInProvider) =>
  `${new URL(request.url).origin}/callback/${provider}`

function authorizeUrl(env: Env, request: Request, provider: SignInProvider, state: string) {
  const redirect = callbackUrl(request, provider)
  if (provider === 'google')
    return `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID ?? '',
      redirect_uri: redirect,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    })}`
  if (provider === 'apple')
    return `https://appleid.apple.com/auth/authorize?${new URLSearchParams({
      client_id: env.APPLE_CLIENT_ID ?? '',
      redirect_uri: redirect,
      response_type: 'code',
      // Asking for name and email makes Apple POST the result back (form_post).
      scope: 'name email',
      response_mode: 'form_post',
      state,
    })}`
  return `https://github.com/login/oauth/authorize?${new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: redirect,
    state,
  })}`
}

/** Trades the provider's code for who signed in. GitHub's also becomes the connection. */
async function providerIdentity(
  env: Env,
  request: Request,
  provider: SignInProvider,
  code: string,
  appleUser: string | null,
) {
  const redirect = callbackUrl(request, provider)
  if (provider === 'google') {
    const tokens = await form<{ id_token?: string }>(
      'https://oauth2.googleapis.com/token',
      {
        code,
        client_id: env.GOOGLE_CLIENT_ID ?? '',
        client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
        redirect_uri: redirect,
        grant_type: 'authorization_code',
      },
      'Google',
    )
    const claims = idClaims(
      tokens.id_token,
      ['https://accounts.google.com', 'accounts.google.com'],
      env.GOOGLE_CLIENT_ID ?? '',
    )
    return {
      identity: {
        provider,
        subject: claims.sub,
        email: claims.email,
        name: claims.name ?? null,
      } satisfies Identity,
    }
  }
  if (provider === 'apple') {
    const tokens = await form<{ id_token?: string }>(
      'https://appleid.apple.com/auth/token',
      {
        code,
        client_id: env.APPLE_CLIENT_ID ?? '',
        client_secret: await appleSecret(env),
        redirect_uri: redirect,
        grant_type: 'authorization_code',
      },
      'Apple',
    )
    const claims = idClaims(
      tokens.id_token,
      ['https://appleid.apple.com'],
      env.APPLE_CLIENT_ID ?? '',
    )
    // Apple sends the name once, on the first sign-in, beside the code rather than in it.
    let name: string | null = null
    try {
      const parsed = JSON.parse(appleUser ?? '{}') as {
        name?: { firstName?: string; lastName?: string }
      }
      name =
        [parsed.name?.firstName, parsed.name?.lastName].filter(Boolean).join(' ').slice(0, 200) ||
        null
    } catch {}
    return {
      identity: { provider, subject: claims.sub, email: claims.email, name } satisfies Identity,
    }
  }
  const data = await gitHubOAuth('login/oauth/access_token', {
    client_id: env.GITHUB_CLIENT_ID,
    client_secret: env.GITHUB_CLIENT_SECRET,
    code,
    redirect_uri: redirect,
  })
  if (!data.access_token) throw new HttpError(401, 'GitHub sign-in was denied or expired.')
  const { user, email, identity } = await gitHubIdentity(data.access_token)
  return {
    identity,
    github: { user, email, data: data as ProviderToken & { access_token: string } },
  }
}

const EMAIL_PATTERN = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/

async function sendSignInEmail(env: Env, request: Request, to: string, code: string, link: string) {
  if (!env.EMAIL) throw new HttpError(503, 'Email sign-in is not available yet.')
  const url = `${new URL(request.url).origin}/email?t=${link}`
  await env.EMAIL.send({
    to,
    from: env.EMAIL_FROM ?? 'signin@usegui.com',
    subject: `Sign in to Gui: ${code}`,
    text: `Sign in to Gui on your Mac with this link:\n\n${url}\n\nOr enter this code in Gui: ${code}\n\nThe link and code stop working after 15 minutes. If you did not try to sign in to Gui, you can ignore this email.`,
    html: `<div style="font:16px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;max-width:28rem"><p>Sign in to Gui on your Mac:</p><p><a href="${escapeHtml(url)}" style="display:inline-block;padding:.6rem 1rem;border-radius:.5rem;background:#2563eb;color:#fff;font-weight:600;text-decoration:none">Sign in to Gui</a></p><p>Or enter this code in Gui:</p><p style="font:600 1.5rem ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.2em">${code}</p><p style="color:#6b7280">The link and code stop working after 15 minutes. If you did not try to sign in to Gui, you can ignore this email.</p></div>`,
  })
}

/** Six digits from a uniform random source. */
function emailCode() {
  const values = crypto.getRandomValues(new Uint32Array(1))
  return String((values[0] ?? 0) % 1_000_000).padStart(6, '0')
}

async function attemptFor(request: Request, env: Env) {
  const bearer = bearerToken(request)
  if (!bearer) throw new HttpError(401, 'Sign-in expired. Try again.')
  const attempt = await env.DB.prepare(
    'SELECT * FROM auth_attempts WHERE token_hash = ? AND expires_at > ?',
  )
    .bind(await hash(bearer), now())
    .first<Attempt>()
  if (!attempt) throw new HttpError(401, 'Sign-in expired. Try again.')
  return attempt
}

async function limited(env: Env, request: Request) {
  const allowed = await env.LOGIN_LIMITER.limit({
    key: request.headers.get('CF-Connecting-IP') ?? 'local',
  })
  if (!allowed.success)
    throw new HttpError(429, 'Too many sign-in attempts. Try again in a minute.')
}

/** The sign-in routes: Gui starts an attempt, the browser finishes it, Gui collects a session. */
async function signInRoute(
  request: Request,
  env: Env,
  path: string,
  diagnostic: { stage: string },
): Promise<Response | null> {
  const url = new URL(request.url)
  if (request.method === 'POST' && path === '/auth/start') {
    diagnostic.stage = 'sign-in start'
    await key(env)
    const body = (await request.json().catch(() => ({}))) as { port?: unknown }
    if (
      typeof body.port !== 'number' ||
      !Number.isInteger(body.port) ||
      body.port < 1024 ||
      body.port > 65535
    )
      throw new HttpError(400, 'Invalid sign-in request.')
    // With a session, this adds a sign-in (GitHub) to the signed-in account.
    const linkTo = bearerToken(request) ? (await session(request, env)).account.id : null
    await limited(env, request)
    await env.DB.batch([
      env.DB.prepare('DELETE FROM auth_attempts WHERE expires_at <= ?').bind(now()),
      env.DB.prepare('DELETE FROM login_attempts WHERE expires_at <= ?').bind(now()),
      env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now()),
    ])
    const attempt = random()
    const publicId = hex(crypto.getRandomValues(new Uint8Array(16)).buffer)
    const expiresAt = now() + ATTEMPT_SECONDS
    await env.DB.prepare(
      'INSERT INTO auth_attempts (token_hash, public_id, port, link_account_id, expires_at) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(await hash(attempt), publicId, body.port, linkTo, expiresAt)
      .run()
    return json({ attempt, id: publicId, expiresAt: expiresAt * 1000 })
  }

  const signIn = /^\/signin\/([a-z]+)$/.exec(path)
  if (request.method === 'GET' && signIn) {
    const provider = signIn[1] ?? ''
    if (!isProvider(provider)) return failed('Gui doesn’t know this way of signing in.', 404)
    if (!configured(env, provider))
      return failed('This way of signing in isn’t available yet.', 503)
    const state = random()
    const started = await env.DB.prepare(
      'UPDATE auth_attempts SET state_hash = ?, provider = ? WHERE public_id = ? AND expires_at > ? AND account_id IS NULL',
    )
      .bind(await hash(state), provider, url.searchParams.get('a') ?? '', now())
      .run()
    if (!started.meta.changes) return failed('This sign-in expired.')
    return Response.redirect(authorizeUrl(env, request, provider, state), 302)
  }

  const callback = /^\/callback\/([a-z]+)$/.exec(path)
  if (callback && (request.method === 'GET' || request.method === 'POST')) {
    const provider = callback[1] ?? ''
    if (!isProvider(provider)) return failed('Gui doesn’t know this way of signing in.', 404)
    diagnostic.stage = `${provider} callback`
    const params =
      request.method === 'POST' ? new URLSearchParams(await request.text()) : url.searchParams
    const state = params.get('state')
    if (!state) return failed('The sign-in page sent an incomplete answer.')
    // The state is single-use: whoever presents it first ends it.
    const attempt = await env.DB.prepare(
      'UPDATE auth_attempts SET state_hash = NULL WHERE state_hash = ? AND provider = ? AND expires_at > ? RETURNING *',
    )
      .bind(await hash(state), provider, now())
      .first<Attempt>()
    if (!attempt) return failed('This sign-in expired.')
    const code = params.get('code')
    if (params.get('error') || !code) return failed('Sign-in was cancelled.')
    try {
      const result = await providerIdentity(env, request, provider, code, params.get('user'))
      const accountId = await accountFor(env, result.identity, attempt.link_account_id)
      if (result.github)
        await saveConnection(
          env,
          accountId,
          result.github.user,
          result.github.email,
          result.github.data,
        )
      return await finish(env, attempt, accountId)
    } catch (error) {
      if (error instanceof HttpError) return failed(error.message, error.status)
      throw error
    }
  }

  if (request.method === 'POST' && path === '/auth/email') {
    diagnostic.stage = 'email sign-in'
    const attempt = await attemptFor(request, env)
    if (attempt.link_account_id) throw new HttpError(400, 'Use a provider to add a sign-in.')
    const body = (await request.json().catch(() => ({}))) as { email?: unknown }
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    if (email.length > 254 || !EMAIL_PATTERN.test(email))
      throw new HttpError(400, 'Enter an email address, like you@example.com.')
    await limited(env, request)
    const perAddress = await env.EMAIL_LIMITER?.limit({ key: email.toLowerCase() })
    if (perAddress && !perAddress.success)
      throw new HttpError(
        429,
        'Gui just sent an email to this address. Wait a minute, then try again.',
      )
    if (attempt.emails_sent >= EMAILS_PER_ATTEMPT)
      throw new HttpError(429, 'Too many emails for one sign-in. Start again.')
    const code = emailCode()
    const link = random()
    await env.DB.prepare(
      'UPDATE auth_attempts SET email = ?, email_code_hash = ?, email_link_hash = ?, email_tries = 0, emails_sent = emails_sent + 1 WHERE token_hash = ?',
    )
      .bind(
        email,
        await hash(`${attempt.token_hash}:${code}`),
        await hash(link),
        attempt.token_hash,
      )
      .run()
    diagnostic.stage = 'email delivery'
    await sendSignInEmail(env, request, email, code, link)
    return json({ ok: true })
  }

  // Opening the link only asks: mail scanners open links too, and must not sign anyone in.
  if (request.method === 'GET' && path === '/email') {
    const token = url.searchParams.get('t') ?? ''
    if (!/^[a-f\d-]{72}$/i.test(token)) return failed('This link is incomplete.')
    return page(
      'Sign in to Gui',
      `<p>Continue to sign in to Gui on this Mac.</p><form method="post" action="/email"><input type="hidden" name="t" value="${escapeHtml(token)}"><button type="submit">Sign in to Gui</button></form><p style="margin-top:1.5rem">On another device? Enter the code from the email in Gui instead.</p>`,
    )
  }
  if (request.method === 'POST' && path === '/email') {
    diagnostic.stage = 'email link'
    const token = new URLSearchParams(await request.text()).get('t') ?? ''
    const attempt = await env.DB.prepare(
      'UPDATE auth_attempts SET email_link_hash = NULL, email_code_hash = NULL WHERE email_link_hash = ? AND expires_at > ? AND account_id IS NULL RETURNING *',
    )
      .bind(await hash(token), now())
      .first<Attempt>()
    if (!attempt?.email) return failed('This link expired or was already used.')
    const accountId = await accountFor(env, {
      provider: 'email',
      subject: attempt.email.toLowerCase(),
      email: attempt.email,
      name: null,
    })
    return finish(env, attempt, accountId)
  }

  // The code from the email, typed into Gui: no browser, so the session comes straight back.
  if (request.method === 'POST' && path === '/auth/email/code') {
    diagnostic.stage = 'email code'
    const attempt = await attemptFor(request, env)
    const body = (await request.json().catch(() => ({}))) as { code?: unknown }
    const code = typeof body.code === 'string' ? body.code.replace(/\D/g, '') : ''
    if (!attempt.email || !attempt.email_code_hash)
      throw new HttpError(400, 'Ask for a new email, then enter its code.')
    const tried = await env.DB.prepare(
      'UPDATE auth_attempts SET email_tries = email_tries + 1 WHERE token_hash = ? AND email_tries < ?',
    )
      .bind(attempt.token_hash, EMAIL_TRIES)
      .run()
    if (!tried.meta.changes) throw new HttpError(429, 'Too many wrong codes. Ask for a new email.')
    if ((await hash(`${attempt.token_hash}:${code}`)) !== attempt.email_code_hash)
      throw new HttpError(400, 'That code doesn’t match. Check the email and try again.')
    const consumed = await env.DB.prepare(
      'DELETE FROM auth_attempts WHERE token_hash = ? AND email_code_hash = ?',
    )
      .bind(attempt.token_hash, attempt.email_code_hash)
      .run()
    if (!consumed.meta.changes) throw new HttpError(401, 'Sign-in expired. Try again.')
    const accountId = await accountFor(env, {
      provider: 'email',
      subject: attempt.email.toLowerCase(),
      email: attempt.email,
      name: null,
    })
    return json({ session: await newSession(env, accountId) })
  }

  if (request.method === 'POST' && path === '/auth/token') {
    diagnostic.stage = 'sign-in exchange'
    const attempt = await attemptFor(request, env)
    const body = (await request.json().catch(() => ({}))) as { code?: unknown }
    if (typeof body.code !== 'string' || !attempt.account_id || !attempt.exchange_hash)
      throw new HttpError(401, 'Sign-in did not finish. Try again.')
    if ((await hash(body.code)) !== attempt.exchange_hash)
      throw new HttpError(401, 'Sign-in did not finish. Try again.')
    // Once only: replaying the code finds nothing.
    const consumed = await env.DB.prepare('DELETE FROM auth_attempts WHERE token_hash = ?')
      .bind(attempt.token_hash)
      .run()
    if (!consumed.meta.changes) throw new HttpError(401, 'Sign-in did not finish. Try again.')
    if (attempt.link_account_id) return json({ session: null })
    return json({ session: await newSession(env, attempt.account_id) })
  }

  if (request.method === 'POST' && path === '/auth/cancel') {
    const bearer = bearerToken(request)
    if (bearer)
      await env.DB.prepare('DELETE FROM auth_attempts WHERE token_hash = ?')
        .bind(await hash(bearer))
        .run()
    return json({ ok: true })
  }
  return null
}

/**
 * GitHub's device flow, which Gui used to sign in with before Gui accounts. Versions out
 * there still use it, so it signs in to the account that has that GitHub user.
 */
async function deviceRoute(
  request: Request,
  env: Env,
  path: string,
  diagnostic: { stage: string },
) {
  if (request.method === 'POST' && path === '/github/start') {
    diagnostic.stage = 'sign-in configuration'
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_APP_SLUG || !env.GITHUB_CLIENT_SECRET)
      throw new HttpError(503, 'GitHub connection is not configured yet.')
    await key(env)
    diagnostic.stage = 'sign-in rate limit'
    await limited(env, request)
    // Bounded cleanup also keeps abandoned sign-ins and expired sessions out of storage.
    diagnostic.stage = 'sign-in cleanup'
    await env.DB.batch([
      env.DB.prepare('DELETE FROM login_attempts WHERE expires_at <= ?').bind(now()),
      env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now()),
    ])
    diagnostic.stage = 'GitHub device authorization'
    const data = await gitHubOAuth('login/device/code', { client_id: env.GITHUB_CLIENT_ID })
    if (!data.device_code || !data.user_code)
      throw new HttpError(502, 'GitHub could not start sign-in.')
    const attempt = random()
    const expiresAt = now() + data.expires_in
    diagnostic.stage = 'sign-in attempt storage'
    await env.DB.prepare('INSERT INTO login_attempts VALUES (?, ?, ?, ?, ?)')
      .bind(
        await hash(attempt),
        await encrypt(env, data.device_code),
        expiresAt,
        data.interval,
        now() + data.interval,
      )
      .run()
    return json({
      attempt,
      code: data.user_code,
      interval: data.interval,
      expiresAt: expiresAt * 1000,
    })
  }
  if (request.method === 'POST' && (path === '/github/poll' || path === '/github/cancel')) {
    const bearer = bearerToken(request)
    if (!bearer) throw new HttpError(401, 'Sign-in expired. Try again.')
    const tokenHash = await hash(bearer)
    if (path === '/github/cancel') {
      await env.DB.prepare('DELETE FROM login_attempts WHERE token_hash = ?').bind(tokenHash).run()
      return json({ ok: true })
    }
    const attempt = await env.DB.prepare(
      'SELECT * FROM login_attempts WHERE token_hash = ? AND expires_at > ?',
    )
      .bind(tokenHash, now())
      .first<{ device_code: string; interval_seconds: number }>()
    if (!attempt) throw new HttpError(401, 'Sign-in expired. Try again.')
    const claimed = await env.DB.prepare(
      'UPDATE login_attempts SET next_poll_at = ? WHERE token_hash = ? AND next_poll_at <= ?',
    )
      .bind(now() + Math.max(attempt.interval_seconds, 30), tokenHash, now())
      .run()
    if (!claimed.meta.changes) return json({ pending: true })
    const data = await gitHubOAuth('login/oauth/access_token', {
      client_id: env.GITHUB_CLIENT_ID,
      device_code: await decrypt(env, attempt.device_code),
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
    if (data.error === 'authorization_pending' || data.error === 'slow_down') {
      const interval = attempt.interval_seconds + (data.error === 'slow_down' ? 5 : 0)
      await env.DB.prepare(
        'UPDATE login_attempts SET next_poll_at = ?, interval_seconds = ? WHERE token_hash = ?',
      )
        .bind(now() + interval, interval, tokenHash)
        .run()
      return json({ pending: true })
    }
    if (!data.access_token) {
      await env.DB.prepare('DELETE FROM login_attempts WHERE token_hash = ?').bind(tokenHash).run()
      throw new HttpError(401, 'GitHub sign-in was denied or expired. Try again.')
    }
    const { user, email, identity } = await gitHubIdentity(data.access_token)
    // Cancellation and replay cannot create sessions after the attempt was removed.
    const consumed = await env.DB.prepare(
      'DELETE FROM login_attempts WHERE token_hash = ? AND expires_at > ?',
    )
      .bind(tokenHash, now())
      .run()
    if (!consumed.meta.changes) throw new HttpError(401, 'Sign-in cancelled or expired.')
    const accountId = await accountFor(env, identity)
    await saveConnection(
      env,
      accountId,
      user,
      email,
      data as ProviderToken & { access_token: string },
    )
    return json({ pending: false, session: await newSession(env, accountId) })
  }
  return null
}

async function route(request: Request, env: Env, diagnostic: { stage: string }): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const signedIn = await signInRoute(request, env, path, diagnostic)
  if (signedIn) return signedIn
  const device = await deviceRoute(request, env, path, diagnostic)
  if (device) return device

  const { account, tokenHash } = await session(request, env)
  if (path === '/account' && request.method === 'GET') {
    const user = await env.DB.prepare('SELECT * FROM users WHERE account_id = ?')
      .bind(account.id)
      .first<User>()
    const { results } = await env.DB.prepare(
      'SELECT DISTINCT provider FROM identities WHERE account_id = ? ORDER BY created_at',
    )
      .bind(account.id)
      .all<{ provider: IdentityProvider }>()
    // `profile` is the GitHub connection, in the shape Gui versions before accounts read.
    const profile: GitHubProfile | null = user && {
      login: user.login,
      name: user.name,
      email: account.email,
      updates: !!account.updates,
    }
    return json({
      account: {
        email: account.email,
        name: account.name,
        updates: !!account.updates,
        providers: results.map((row) => row.provider),
      },
      profile,
      installUrl: `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`,
    })
  }
  if (path === '/account/updates' && request.method === 'POST') {
    const body = (await request.json()) as { updates?: unknown }
    if (typeof body.updates !== 'boolean')
      throw new HttpError(400, 'Choose whether to receive product updates.')
    if (body.updates && !account.email)
      throw new HttpError(400, 'Add an email to your account before subscribing.')
    await env.DB.prepare('UPDATE accounts SET updates = ?, preference_changed_at = ? WHERE id = ?')
      .bind(Number(body.updates), now(), account.id)
      .run()
    return json({ ok: true })
  }
  if (path === '/logout' && request.method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run()
    return json({ ok: true })
  }
  if (path === '/account' && request.method === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE account_id = ?').bind(account.id),
      env.DB.prepare('DELETE FROM auth_attempts WHERE account_id = ? OR link_account_id = ?').bind(
        account.id,
        account.id,
      ),
      env.DB.prepare('DELETE FROM users WHERE account_id = ?').bind(account.id),
      env.DB.prepare('DELETE FROM identities WHERE account_id = ?').bind(account.id),
      env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(account.id),
    ])
    return json({ ok: true })
  }
  // Disconnecting GitHub drops its tokens. GitHub stays a way to sign in to this account.
  if (path === '/github' && request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM users WHERE account_id = ?').bind(account.id).run()
    return json({ ok: true })
  }
  const user = await connection(env, account)
  if (path === '/repositories' && request.method === 'GET') {
    const list = await repositories(await accessToken(env, user))
    return json({
      repositories: list.map(({ id, fullName, private: isPrivate }) => ({
        id,
        fullName,
        private: isPrivate,
      })),
    })
  }
  if (path === '/repositories' && request.method === 'POST') {
    const body = (await request.json()) as { name?: unknown }
    if (typeof body.name !== 'string' || !/^[\w-][\w.-]{0,99}$/.test(body.name))
      throw new HttpError(
        400,
        'Use up to 100 letters, numbers, dots, hyphens, or underscores for the project name.',
      )
    const created = await github<{ id: number; full_name: string; private: boolean }>(
      await accessToken(env, user),
      '/user/repos',
      { name: body.name, private: true, auto_init: true },
    )
    return json(
      { repository: { id: created.id, fullName: created.full_name, private: created.private } },
      201,
    )
  }
  const clone = /^\/repositories\/(\d+)\/credential$/.exec(path)
  if (clone && request.method === 'POST') {
    const repo = (await repositories(await accessToken(env, user))).find(
      (item) => item.id === Number(clone[1]),
    )
    if (!repo)
      throw new HttpError(403, 'This repository is no longer connected to your GitHub account.')
    return json({ token: await repositoryToken(env, repo), fullName: repo.fullName })
  }
  const pull = /^\/repositories\/(\d+)\/pulls$/.exec(path)
  if (pull && request.method === 'POST') {
    const body = (await request.json()) as {
      branch?: unknown
      base?: unknown
      title?: unknown
      body?: unknown
    }
    if (
      typeof body.branch !== 'string' ||
      typeof body.base !== 'string' ||
      typeof body.title !== 'string' ||
      typeof body.body !== 'string' ||
      !body.branch ||
      !body.base ||
      !body.title.trim() ||
      body.branch.length > 255 ||
      body.base.length > 255 ||
      body.title.length > 256 ||
      body.body.length > 65536
    )
      throw new HttpError(400, 'Enter a branch, base branch, title, and description.')
    const token = await accessToken(env, user)
    const repo = (await repositories(token)).find((item) => item.id === Number(pull[1]))
    if (!repo)
      throw new HttpError(403, 'This repository is no longer connected to your GitHub account.')
    const owner = repo.fullName.split('/')[0]
    const query = new URLSearchParams({
      state: 'open',
      head: `${owner}:${body.branch}`,
      base: body.base,
    })
    const existing = await github<{ html_url: string }[]>(
      token,
      `/repos/${repo.fullName}/pulls?${query}`,
    )
    if (existing[0]) return json({ url: existing[0].html_url })
    const created = await github<{ html_url: string }>(token, `/repos/${repo.fullName}/pulls`, {
      head: body.branch,
      base: body.base,
      title: body.title,
      body: body.body,
    })
    return json({ url: created.html_url })
  }
  throw new HttpError(404, 'Not found.')
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const diagnostic = { stage: 'account request' }
    try {
      return await route(request, env, diagnostic)
    } catch (error) {
      if (!(error instanceof HttpError))
        console.error({
          event: 'account_request_failed',
          stage: diagnostic.stage,
          errorKind: error instanceof Error ? error.name : 'unknown',
        })
      // Never return provider responses, credentials, SQL errors, or stacks to clients.
      return error instanceof HttpError
        ? json({ error: error.message }, error.status)
        : json({ error: 'The account service could not complete this request. Try again.' }, 500)
    }
  },
}
