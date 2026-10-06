import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, safeStorage, shell } from 'electron'
import type {
  GitHubLogin,
  GitHubPoll,
  GitHubProfile,
  GitHubRepository,
  GitHubState,
} from '../shared/github'
import { parseRepo } from './clone'
import { getShellEnv } from './shell-env'

declare const __GUI_ACCOUNTS_URL__: string
interface LoginAttempt {
  token: string
  code: GitHubLogin
  generation: number
}
let attempt: LoginAttempt | null = null
let generation = 0
let loginStarting = false
let loginPolling = false
const sessionFile = () => join(app.getPath('userData'), 'github-session')
function serviceUrl() {
  const value = !app.isPackaged
    ? (process.env.GUI_ACCOUNTS_URL ?? __GUI_ACCOUNTS_URL__)
    : __GUI_ACCOUNTS_URL__
  if (!value) throw new Error('GitHub connection is not configured in this build yet.')
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
async function savedSession(): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(await readFile(sessionFile()))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error('Could not unlock your GitHub connection. Disconnect and try again.')
  }
}
class AccountError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
async function request<T>(
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
  const result = (await response.json()) as T & { error?: string }
  if (!response.ok) {
    if (response.status === 401 && token && token !== attempt?.token)
      await rm(sessionFile(), { force: true })
    throw new AccountError(
      response.status,
      result.error ?? 'Could not connect to GitHub. Try again.',
    )
  }
  return result
}
export async function getGitHub(): Promise<GitHubState> {
  try {
    serviceUrl()
  } catch {
    return { configured: false, profile: null, repositories: [] }
  }
  const token = await savedSession()
  if (!token) return { configured: true, profile: null, repositories: [] }
  try {
    const { profile } = await request<{ profile: GitHubProfile }>('/account', token)
    const { repositories } = await request<{ repositories: GitHubRepository[] }>(
      '/repositories',
      token,
    )
    return { configured: true, profile, repositories }
  } catch (error) {
    if (error instanceof AccountError && error.status === 401)
      return { configured: true, profile: null, repositories: [] }
    throw error
  }
}
export async function startGitHub(): Promise<GitHubLogin> {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error('Secure storage is unavailable. GitHub sign-in needs the macOS keychain.')
  if (loginStarting || attempt)
    throw new Error('GitHub sign-in is already in progress. Cancel it before starting again.')
  loginStarting = true
  const current = ++generation
  try {
    const result = await request<GitHubLogin & { attempt: string }>('/github/start', null, 'POST')
    if (current !== generation) {
      await request('/github/cancel', result.attempt, 'POST')
      throw new Error('GitHub sign-in was cancelled.')
    }
    const code = { code: result.code, interval: result.interval, expiresAt: result.expiresAt }
    attempt = { token: result.attempt, code, generation: current }
    await shell.openExternal('https://github.com/login/device')
    return code
  } catch (error) {
    await cancelGitHub().catch(() => undefined)
    throw error
  } finally {
    loginStarting = false
  }
}
export async function cancelGitHub() {
  generation++
  const current = attempt
  attempt = null
  if (current) await request('/github/cancel', current.token, 'POST')
}
export async function pollGitHub(): Promise<GitHubPoll> {
  const current = attempt
  if (!current) throw new Error('Start GitHub sign-in again.')
  if (Date.now() >= current.code.expiresAt) {
    await cancelGitHub()
    throw new Error('GitHub sign-in expired. Try again.')
  }
  if (loginPolling) return { pending: true }
  loginPolling = true
  try {
    const result = await request<GitHubPoll & { session?: string }>(
      '/github/poll',
      current.token,
      'POST',
    )
    if (result.pending) return { pending: true }
    if (!result.session) throw new Error('GitHub did not complete sign-in. Try again.')
    if (current.generation !== generation) {
      await request('/logout', result.session, 'POST')
      return { pending: true }
    }
    await mkdir(app.getPath('userData'), { recursive: true, mode: 0o700 })
    const temporary = `${sessionFile()}.${randomUUID()}`
    try {
      await writeFile(temporary, safeStorage.encryptString(result.session), { mode: 0o600 })
      if (current.generation !== generation) {
        await request('/logout', result.session, 'POST')
        return { pending: true }
      }
      await rename(temporary, sessionFile())
      if (current.generation !== generation) {
        await rm(sessionFile(), { force: true })
        await request('/logout', result.session, 'POST')
        return { pending: true }
      }
    } finally {
      await rm(temporary, { force: true })
    }
    attempt = null
    return { pending: false }
  } catch (error) {
    await cancelGitHub().catch(() => undefined)
    throw error
  } finally {
    loginPolling = false
  }
}
export async function disconnectGitHub() {
  await cancelGitHub().catch(() => undefined)
  const token = await savedSession().catch(() => null)
  try {
    if (token) await request('/logout', token, 'POST')
  } finally {
    await rm(sessionFile(), { force: true })
  }
}
export async function gitHubUpdates(updates: boolean) {
  await request('/account/updates', await savedSession(), 'POST', { updates })
}
export async function manageGitHub() {
  const { installUrl } = await request<{ installUrl: string }>('/account', await savedSession())
  const url = new URL(installUrl)
  if (
    url.origin !== 'https://github.com' ||
    !/^\/apps\/[a-z\d-]+\/installations\/new$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid GitHub installation address.')
  await shell.openExternal(url.href)
}

export async function createGitHub(name: string): Promise<GitHubRepository> {
  const { repository } = await request<{ repository: GitHubRepository }>(
    '/repositories',
    await savedSession(),
    'POST',
    { name },
  )
  return repository
}

async function withGitHubToken<T>(token: string, action: (env: NodeJS.ProcessEnv) => Promise<T>) {
  const credentials = await mkdtemp(join(tmpdir(), 'gui-github-'))
  try {
    await chmod(credentials, 0o700)
    const askpass = join(credentials, 'askpass')
    await writeFile(
      askpass,
      '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "x-access-token" ;; *) printf "%s\\n" "$GUI_GIT_TOKEN" ;; esac\n',
      { mode: 0o700 },
    )
    const env: NodeJS.ProcessEnv = {
      ...(await getShellEnv()),
      GIT_ASKPASS: askpass,
      GIT_ASKPASS_REQUIRE: 'force',
      GIT_TERMINAL_PROMPT: '0',
      GUI_GIT_TOKEN: token,
    }
    for (const name of Object.keys(env)) if (/^GIT_(TRACE|CONFIG)/.test(name)) delete env[name]
    for (const name of [
      'GIT_DIR',
      'GIT_WORK_TREE',
      'GIT_INDEX_FILE',
      'GIT_COMMON_DIR',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    ])
      delete env[name]
    return await action(env)
  } finally {
    await rm(credentials, { recursive: true, force: true })
  }
}
async function credential(id: number) {
  const result = await request<{ token: string; fullName: string }>(
    `/repositories/${id}/credential`,
    await savedSession(),
    'POST',
  )
  if (!/^[\w-]+\/[\w.-]+$/.test(result.fullName)) throw new Error('Invalid GitHub repository name.')
  return result
}
async function authenticatedGit(args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  await new Promise<void>((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'credential.helper=', ...args],
      { env, cwd, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 },
      (error) =>
        error
          ? reject(
              new Error(
                'GitHub could not complete this git operation. Check repository access and try again.',
              ),
            )
          : resolve(),
    )
  })
}
export async function cloneGitHub(id: number, parent: string): Promise<string> {
  const { token, fullName } = await credential(id)
  const repo = parseRepo(fullName)
  if (!repo) throw new Error('Invalid GitHub repository name.')
  const destination = join(parent, repo.name)
  await mkdir(destination)
  try {
    await withGitHubToken(token, (env) =>
      authenticatedGit(['clone', '--', repo.url, destination], env),
    )
    return destination
  } catch {
    await rm(destination, { recursive: true, force: true })
    throw new Error(`Could not clone ${fullName}. Check repository access and try again.`)
  }
}
export async function connectedGitHub(fullName: string) {
  const state = await getGitHub()
  const repository = state.repositories.find(
    (item) => item.fullName.toLowerCase() === fullName.toLowerCase(),
  )
  return state.profile && repository ? { repository, profile: state.profile } : null
}
export async function pushGitHub(id: number, fullName: string, root: string, branch: string) {
  const access = await credential(id)
  if (access.fullName.toLowerCase() !== fullName.toLowerCase())
    throw new Error('The connected GitHub repository changed. Refresh projects and try again.')
  // Push to the checked canonical endpoint, regardless of local pushurl overrides.
  const ref = `refs/heads/${branch}`
  await withGitHubToken(access.token, (env) =>
    authenticatedGit(
      [
        'push',
        '--no-follow-tags',
        '--',
        `https://github.com/${access.fullName}.git`,
        `${ref}:${ref}`,
      ],
      env,
      root,
    ),
  )
}
export async function pullGitHub(
  id: number,
  branch: string,
  base: string,
  title: string,
  body: string,
) {
  const result = await request<{ url: string }>(
    `/repositories/${id}/pulls`,
    await savedSession(),
    'POST',
    { branch, base, title, body },
  )
  const url = new URL(result.url)
  if (
    url.origin !== 'https://github.com' ||
    !/^\/[\w-]+\/[\w.-]+\/pull\/\d+$/.test(url.pathname) ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid GitHub pull request address.')
  return url.href
}
