import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { app, safeStorage, shell } from 'electron'
import type { AccountProfile, AccountState, SignInProvider } from '../shared/account'

declare const __GUI_ACCOUNTS_URL__: string

/** `change`: signed in or out. Main opens what waited for an account, and tells the pages. */
export const accountEvents = new EventEmitter<{ change: [] }>()

/**
 * The Gui session, encrypted with the Keychain. Named for GitHub, Gui's first sign-in, and
 * kept so: those sessions became Gui accounts on the service and still work.
 */
const sessionFile = () => join(app.getPath('userData'), 'github-session')

export function serviceUrl() {
  const value = !app.isPackaged
    ? (process.env.GUI_ACCOUNTS_URL ?? __GUI_ACCOUNTS_URL__)
    : __GUI_ACCOUNTS_URL__
  if (!value) throw new Error('Gui accounts are not configured in this build yet.')
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Invalid account service address.')
  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      !app.isPackaged &&
      ['localhost', '127.0.0.1'].includes(url.hostname)
    )
  )
    throw new Error('The account service requires HTTPS.')
  return url.origin
}

function configured() {
  try {
    serviceUrl()
    return true
  } catch {
    return false
  }
}

/**
 * Read from the file alone, so the start screen knows at once and without a Keychain prompt.
 * Unpackaged builds started with GUI_ACCOUNT_REQUIRED=0 (the end-to-end tests) don't ask.
 */
export function accountState(): AccountState {
  const service = configured()
  return {
    configured: service,
    required: service && (app.isPackaged || process.env.GUI_ACCOUNT_REQUIRED !== '0'),
    signedIn: existsSync(sessionFile()),
  }
}

/** Whether Gui waits for an account before opening projects. */
export function mustSignIn() {
  const state = accountState()
  return state.required && !state.signedIn
}

export async function savedSession(): Promise<string | null> {
  try {
    // Opening Projects should not ask for Keychain access before the user has signed in.
    const encrypted = await readFile(sessionFile())
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(encrypted)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('Could not unlock your Gui account. Sign out and sign in again.')
  }
}

async function saveSession(token: string) {
  await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 })
  const temporary = `${sessionFile()}.${randomUUID()}`
  try {
    await writeFile(temporary, safeStorage.encryptString(token), { mode: 0o600 })
    await rename(temporary, sessionFile())
  } finally {
    await rm(temporary, { force: true })
  }
  accountEvents.emit('change')
}

async function forgetSession() {
  const had = existsSync(sessionFile())
  await rm(sessionFile(), { force: true })
  if (had) accountEvents.emit('change')
}

export class AccountError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

/** A call to the account service. A session it no longer knows is forgotten here. */
export async function request<T>(
  path: string,
  token?: string | null,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${serviceUrl()}${path}`, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  // A proxy or Cloudflare error page isn't JSON; it still fails as the status says.
  const result = (
    response.ok ? await response.json() : await response.json().catch(() => ({}))
  ) as T & { error?: string }
  if (!response.ok) {
    // Sign-in calls carry the attempt's token, not the session.
    if (response.status === 401 && token && !path.startsWith('/auth/')) await forgetSession()
    throw new AccountError(
      response.status,
      result.error ?? 'Could not reach Gui accounts. Try again.',
    )
  }
  return result
}

export async function getAccount(): Promise<AccountProfile | null> {
  if (!configured()) return null
  const token = await savedSession()
  if (!token) return null
  try {
    return (await request<{ account: AccountProfile }>('/account', token)).account
  } catch (error) {
    if (error instanceof AccountError && error.status === 401) return null
    throw error
  }
}

export async function setAccountUpdates(updates: boolean) {
  await request('/account/updates', await savedSession(), 'POST', { updates })
}

export async function signOut() {
  await cancelSignIn()
  const token = await savedSession().catch(() => null)
  try {
    if (token) await request('/logout', token, 'POST')
  } finally {
    await forgetSession()
  }
}

// ── Signing in ──────────────────────────────────────────────────────────────────────────
//
// Gui listens on a loopback port and opens the browser on the service; the provider (or the
// emailed link) sends the browser back to that port with a one-time code, which Gui trades,
// with the attempt's own token, for a session. A link forwarded to someone else can't sign
// this Gui in: their browser comes back to their own computer.

interface Attempt {
  token: string
  id: string
  /** Adding GitHub to the signed-in account, rather than signing in */
  link: boolean
  server: Server
  done: Promise<void>
  settle: (error?: Error) => void
}
let current: Attempt | null = null
let starting: Promise<Attempt> | null = null

export const CANCELLED = 'Sign-in was cancelled.'

function listen(server: Server) {
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') resolve(address.port)
      else reject(new Error('Could not start signing in.'))
    })
  })
}

/** The page the browser lands on, back from the service. */
function landing(res: ServerResponse, status: number, title: string, detail: string) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  })
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${title}</title><style>body{font:16px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;max-width:28rem;margin:15vh auto;padding:0 1.5rem}h1{font-size:1.375rem;margin:0 0 .5rem}p{margin:0;color:color-mix(in srgb,currentColor 70%,transparent)}</style></head><body><h1>${title}</h1><p>${detail}</p></body></html>`,
  )
}

async function onLoopback(attempt: Attempt, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const code = url.searchParams.get('code')
  if (req.method !== 'GET' || url.pathname !== '/callback' || !code)
    return landing(res, 404, 'Not found', 'Go back to Gui.')
  if (current !== attempt)
    return landing(res, 410, 'This sign-in ended', 'Go back to Gui and try again.')
  try {
    const { session } = await request<{ session: string | null }>(
      '/auth/token',
      attempt.token,
      'POST',
      { code },
    )
    if (current !== attempt) throw new Error('This sign-in ended.')
    if (session) await saveSession(session)
    landing(
      res,
      200,
      attempt.link ? 'GitHub is connected' : 'You’re signed in to Gui',
      'You can close this tab and go back to Gui.',
    )
    attempt.settle()
  } catch (error) {
    landing(res, 400, 'Sign-in didn’t finish', 'Go back to Gui and try again.')
    attempt.settle(error instanceof Error ? error : new Error(String(error)))
  }
}

/** The sign-in under way, or a new one. Choosing another provider keeps the same one. */
async function begin(link: boolean): Promise<Attempt> {
  if (current?.link === link) return current
  if (starting) await starting.catch(() => undefined)
  if (current?.link === link) return current
  await cancelSignIn()
  if (!safeStorage.isEncryptionAvailable())
    throw new Error('Secure storage is unavailable. Signing in needs the macOS keychain.')
  starting = (async () => {
    const server = createServer()
    try {
      const port = await listen(server)
      const session = link ? await savedSession() : null
      if (link && !session) throw new Error('Sign in to Gui first.')
      const result = await request<{ attempt: string; id: string; expiresAt: number }>(
        '/auth/start',
        session,
        'POST',
        { port },
      )
      let settle: (error?: Error) => void = () => undefined
      const done = new Promise<void>((resolve, reject) => {
        settle = (error) => (error ? reject(error) : resolve())
      })
      // Nothing may be waiting on it yet (an email sent, its link not clicked).
      done.catch(() => undefined)
      const attempt: Attempt = { token: result.attempt, id: result.id, link, server, done, settle }
      const expiry = setTimeout(
        () => attempt.settle(new Error('Sign-in expired. Try again.')),
        Math.max(0, result.expiresAt - Date.now()),
      )
      attempt.settle = (error) => {
        if (current === attempt) current = null
        clearTimeout(expiry)
        server.close()
        settle(error)
      }
      server.on('request', (req, res) => void onLoopback(attempt, req, res))
      current = attempt
      return attempt
    } catch (error) {
      server.close()
      throw error
    }
  })()
  try {
    return await starting
  } finally {
    starting = null
  }
}

/** Opens the provider in the browser; resolves once Gui is signed in. */
export async function signIn(provider: SignInProvider) {
  const attempt = await begin(false)
  await shell.openExternal(`${serviceUrl()}/signin/${provider}?a=${attempt.id}`)
  return attempt.done
}

/** Adds GitHub to the signed-in account. */
export async function connectGitHub() {
  const attempt = await begin(true)
  await shell.openExternal(`${serviceUrl()}/signin/github?a=${attempt.id}`)
  return attempt.done
}

export async function emailSignIn(email: string) {
  const attempt = await begin(false)
  await request('/auth/email', attempt.token, 'POST', { email })
}

export async function emailCode(code: string) {
  const attempt = current
  if (!attempt || attempt.link) throw new Error('Ask for a new email, then enter its code.')
  const { session } = await request<{ session: string }>(
    '/auth/email/code',
    attempt.token,
    'POST',
    {
      code,
    },
  )
  await saveSession(session)
  attempt.settle()
}

/** Resolves when the sign-in under way finishes, as when the emailed link is opened. */
export function waitForSignIn() {
  if (!current) return Promise.reject(new Error('Start signing in again.'))
  return current.done
}

export async function cancelSignIn() {
  const attempt = current
  if (!attempt) return
  attempt.settle(new Error(CANCELLED))
  await request('/auth/cancel', attempt.token, 'POST').catch(() => undefined)
}
