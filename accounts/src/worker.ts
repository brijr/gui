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
export interface Env {
  DB: Database
  LOGIN_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> }
  GITHUB_CLIENT_ID: string
  GITHUB_APP_SLUG: string
  GITHUB_CLIENT_SECRET: string
  TOKEN_ENCRYPTION_KEY: string
}
interface User {
  github_id: number
  login: string
  name: string | null
  email: string | null
  updates: number
  github_token: string
  refresh_token: string | null
  token_expires_at: number
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
async function provider(path: string, values: Record<string, string>) {
  const res = await fetch(`https://github.com/${path}`, {
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
  if (!res.ok) throw new HttpError(502, 'GitHub could not complete sign-in. Try again.')
  return res.json() as Promise<
    ProviderToken & { device_code: string; user_code: string; interval: number; expires_in: number }
  >
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
async function session(request: Request, env: Env): Promise<{ user: User; tokenHash: string }> {
  const bearer = request.headers.get('Authorization')?.match(/^Bearer ([a-f\d-]{72})$/i)?.[1]
  if (!bearer) throw new HttpError(401, 'Connect GitHub to continue.')
  const tokenHash = await hash(bearer)
  const user = await env.DB.prepare(
    'SELECT users.* FROM users JOIN sessions USING (github_id) WHERE token_hash = ? AND expires_at > ?',
  )
    .bind(tokenHash, now())
    .first<User>()
  if (!user) throw new HttpError(401, 'Your Gui session expired. Reconnect GitHub.')
  return { user, tokenHash }
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
    const data = await provider('login/oauth/access_token', {
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
function profile(user: User): GitHubProfile {
  return { login: user.login, name: user.name, email: user.email, updates: !!user.updates }
}
async function repositories(token: string): Promise<GitHubRepository[]> {
  const output: GitHubRepository[] = []
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
async function route(request: Request, env: Env, diagnostic: { stage: string }): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  if (request.method === 'POST' && path === '/github/start') {
    diagnostic.stage = 'sign-in configuration'
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_APP_SLUG || !env.GITHUB_CLIENT_SECRET)
      throw new HttpError(503, 'GitHub connection is not configured yet.')
    await key(env)
    diagnostic.stage = 'sign-in rate limit'
    const allowed = await env.LOGIN_LIMITER.limit({
      key: request.headers.get('CF-Connecting-IP') ?? 'local',
    })
    if (!allowed.success)
      throw new HttpError(429, 'Too many sign-in attempts. Try again in a minute.')
    // Bounded cleanup also keeps abandoned sign-ins and expired sessions out of storage.
    diagnostic.stage = 'sign-in cleanup'
    await env.DB.batch([
      env.DB.prepare('DELETE FROM login_attempts WHERE expires_at <= ?').bind(now()),
      env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now()),
    ])
    diagnostic.stage = 'GitHub device authorization'
    const data = await provider('login/device/code', { client_id: env.GITHUB_CLIENT_ID })
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
    const bearer = request.headers.get('Authorization')?.match(/^Bearer ([a-f\d-]{72})$/i)?.[1]
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
    const data = await provider('login/oauth/access_token', {
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
    const user = await github<{ id: number; login: string; name: string | null }>(
      data.access_token,
      '/user',
    )
    const emails = await github<{ email: string; primary: boolean; verified: boolean }[]>(
      data.access_token,
      '/user/emails',
    )
    const email = emails.find((item) => item.primary && item.verified)?.email ?? null
    // Cancellation and replay cannot create sessions after the attempt was removed.
    const consumed = await env.DB.prepare(
      'DELETE FROM login_attempts WHERE token_hash = ? AND expires_at > ?',
    )
      .bind(tokenHash, now())
      .run()
    if (!consumed.meta.changes) throw new HttpError(401, 'Sign-in cancelled or expired.')
    const sessionToken = random()
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (github_id, login, name, email, created_at, last_login_at, github_token, refresh_token, token_expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(github_id) DO UPDATE SET login=excluded.login, name=excluded.name, email=excluded.email,
        last_login_at=excluded.last_login_at, github_token=excluded.github_token, refresh_token=excluded.refresh_token, token_expires_at=excluded.token_expires_at`).bind(
        user.id,
        user.login,
        user.name,
        email,
        now(),
        now(),
        await encrypt(env, data.access_token),
        data.refresh_token ? await encrypt(env, data.refresh_token) : null,
        now() + (data.expires_in ?? 28800),
      ),
      env.DB.prepare('INSERT INTO sessions VALUES (?, ?, ?)').bind(
        await hash(sessionToken),
        user.id,
        now() + 30 * 86400,
      ),
    ])
    return json({ pending: false, session: sessionToken })
  }
  const { user, tokenHash } = await session(request, env)
  if (path === '/account' && request.method === 'GET')
    return json({
      profile: profile(user),
      installUrl: `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`,
    })
  if (path === '/account/updates' && request.method === 'POST') {
    const body = (await request.json()) as { updates?: unknown }
    if (typeof body.updates !== 'boolean')
      throw new HttpError(400, 'Choose whether to receive product updates.')
    if (body.updates && !user.email)
      throw new HttpError(400, 'Add a verified primary email in GitHub before subscribing.')
    await env.DB.prepare(
      'UPDATE users SET updates = ?, preference_changed_at = ? WHERE github_id = ?',
    )
      .bind(Number(body.updates), now(), user.github_id)
      .run()
    return json({ ok: true })
  }
  if (path === '/logout' && request.method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run()
    return json({ ok: true })
  }
  if (path === '/account' && request.method === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE github_id = ?').bind(user.github_id),
      env.DB.prepare('DELETE FROM users WHERE github_id = ?').bind(user.github_id),
    ])
    return json({ ok: true })
  }
  if (path === '/repositories' && request.method === 'GET')
    return json({ repositories: await repositories(await accessToken(env, user)) })
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
    const token = await accessToken(env, user)
    const repo = (await repositories(token)).find((item) => item.id === Number(clone[1]))
    if (!repo)
      throw new HttpError(403, 'This repository is no longer connected to your GitHub account.')
    return json({ token, fullName: repo.fullName })
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
