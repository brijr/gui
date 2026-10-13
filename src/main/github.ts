import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, shell } from 'electron'
import type { GitHubProfile, GitHubRepository, GitHubState } from '../shared/github'
import {
  AccountError,
  accountEvents,
  connectGitHub as connectAccountGitHub,
  request,
  savedSession,
  serviceUrl,
} from './account'
import { parseRepo } from './clone'
import { developerTools } from './developer-tools'
import { ScopedRequestCache } from './scoped-request-cache'
import {
  type CredentialLease,
  CredentialScopeChanged,
  SessionCredentialCache,
} from './session-credential-cache'
import { getShellEnv } from './shell-env'

export async function connectGitHub() {
  await connectAccountGitHub()
  listing.clear()
  credentials.clear()
}

const listing = new ScopedRequestCache<string, GitHubState>(15_000)
app.on('browser-window-focus', () => listing.clear())
accountEvents.on('change', () => {
  listing.clear()
  credentials.clear()
})

/** The account's GitHub connection and the repositories Gui may see through it. */
export async function getGitHub(refresh = false): Promise<GitHubState> {
  if (refresh) listing.clear()
  try {
    serviceUrl()
  } catch {
    return { configured: false, profile: null, repositories: [] }
  }
  const token = await savedSession()
  if (!token) return { configured: true, profile: null, repositories: [] }
  return listing.get(token, () => loadGitHub(token))
}

async function loadGitHub(token: string): Promise<GitHubState> {
  try {
    const { profile } = await request<{ profile: GitHubProfile | null }>('/account', token)
    if (!profile) return { configured: true, profile: null, repositories: [] }
    const { repositories } = await request<{ repositories: GitHubRepository[] }>(
      '/repositories',
      token,
    )
    return { configured: true, profile, repositories }
  } catch (error) {
    if (error instanceof AccountError && (error.status === 401 || error.status === 403))
      return { configured: true, profile: null, repositories: [] }
    throw error
  }
}
/** Drops the GitHub connection. Gui stays signed in, and GitHub stays a way to sign in. */
export async function disconnectGitHub() {
  await request('/github', await savedSession(), 'DELETE')
  listing.clear()
  credentials.clear()
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
  listing.clear()
  return repository
}

async function withGitHubToken<T>(token: string, action: (env: NodeJS.ProcessEnv) => Promise<T>) {
  const credentials = await mkdtemp(join(tmpdir(), 'gui-github-'))
  try {
    await chmod(credentials, 0o700)
    const askpass = join(credentials, 'askpass')
    // Answers github.com only: a URL rewritten to another host never gets the token.
    await writeFile(
      askpass,
      `#!/bin/sh
case "$1" in
  "Username for 'https://github.com'"*) printf '%s\\n' x-access-token ;;
  "Password for 'https://x-access-token@github.com'"*) printf '%s\\n' "$GUI_GIT_TOKEN" ;;
  *) exit 1 ;;
esac
`,
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
    // Without the user's global and system config, nothing there (an insteadOf that turns
    // github.com into SSH or another host, a credential helper) redirects the token's use.
    env.GIT_CONFIG_GLOBAL = '/dev/null'
    env.GIT_CONFIG_NOSYSTEM = '1'
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
/**
 * Gui can't use the GitHub connection here (the account service is unreachable, or the
 * repository sends github.com elsewhere), so it goes the user's own way: git or gh.
 */
export class CredentialUnavailable extends Error {}

interface GitHubCredential {
  token: string
  fullName: string
}

async function loadCredential(id: number, session: string | null) {
  let result: GitHubCredential
  try {
    result = await request(`/repositories/${id}/credential`, session, 'POST')
  } catch (error) {
    // Signed out or no longer connected is the user's to fix; anything else is the service's.
    if (error instanceof AccountError && error.status < 500) throw error
    throw new CredentialUnavailable('Could not reach Gui accounts.', { cause: error })
  }
  if (!/^[\w-]+\/[\w.-]+$/.test(result.fullName)) throw new Error('Invalid GitHub repository name.')
  return result
}
const credential = (id: number) => credentials.fresh(id)

async function authenticatedGit(
  args: string[],
  env: NodeJS.ProcessEnv,
  access: CredentialLease<GitHubCredential>,
  cwd?: string,
) {
  await developerTools.requireGit()
  await access.run(
    () =>
      new Promise<void>((resolve, reject) => {
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
      }),
  )
}
export async function cloneGitHub(id: number, parent: string): Promise<string> {
  const access = await credential(id)
  const { token, fullName } = access.value
  const repo = parseRepo(fullName)
  if (!repo) throw new Error('Invalid GitHub repository name.')
  const destination = join(parent, repo.name)
  await mkdir(destination)
  try {
    await access.run(() =>
      withGitHubToken(token, (env) =>
        authenticatedGit(['clone', '--', repo.url, destination], env, access),
      ),
    )
    return destination
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    if (error instanceof CredentialScopeChanged) throw error
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
/**
 * Whether the repository's own config rewrites `url` (url.*.insteadOf, as for SSH): git
 * would push or fetch somewhere else, and ask for the token there. That repository goes the
 * user's own way instead. Global and system config are already out of `env`.
 */
async function assertNotRewritten(root: string, env: NodeJS.ProcessEnv, url: string) {
  const rewrites = await new Promise<string>((resolve) => {
    execFile(
      'git',
      ['config', '--get-regexp', '^url\\..*\\.(push)?insteadof$'],
      { env, cwd: root, timeout: 10_000 },
      (_error, stdout) => resolve(stdout ?? ''),
    )
  })
  for (const line of rewrites.split('\n')) {
    const from = line.slice(line.indexOf(' ') + 1).trim()
    if (line.includes(' ') && from && url.startsWith(from))
      throw new CredentialUnavailable('This repository rewrites github.com addresses.')
  }
}

export async function pushGitHub(id: number, fullName: string, root: string, branch: string) {
  const access = await credential(id)
  if (access.value.fullName.toLowerCase() !== fullName.toLowerCase())
    throw new Error('The connected GitHub repository changed. Refresh projects and try again.')
  // Push to the checked canonical endpoint, regardless of local pushurl overrides.
  const ref = `refs/heads/${branch}`
  const url = `https://github.com/${access.value.fullName}.git`
  await access.run(() =>
    withGitHubToken(access.value.token, async (env) => {
      await assertNotRewritten(root, env, url)
      await authenticatedGit(
        ['push', '--no-follow-tags', '--', url, `${ref}:${ref}`],
        env,
        access,
        root,
      )
    }),
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

/**
 * The connected repository's token, kept for a few minutes: the bar over the chat reads
 * pull request status every minute. Mutations bypass this read cache for fresh authorization.
 */
const CREDENTIAL_TTL = 5 * 60_000
const credentials = new SessionCredentialCache(savedSession, loadCredential, CREDENTIAL_TTL)
const recentCredential = (id: number) => credentials.get(id)

/** A GET on api.github.com as the connected user, for a repository they connected. */
export async function readGitHub<T>(id: number, fullName: string, path: string): Promise<T> {
  const access = await recentCredential(id)
  if (access.value.fullName.toLowerCase() !== fullName.toLowerCase())
    throw new Error('The connected GitHub repository changed. Refresh projects and try again.')
  return access.run(async (value) => {
    const response = await fetch(`https://api.github.com/repos/${value.fullName}${path}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${value.token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Gui',
        'X-GitHub-Api-Version': '2026-03-10',
      },
    })
    if (response.status === 401) access.evict()
    if (!response.ok) throw new Error('Could not read the pull request from GitHub.')
    return (await response.json()) as T
  })
}

/** Updates the remote-tracking ref for `branch` from the connected repository. */
export async function fetchGitHub(
  id: number,
  fullName: string,
  root: string,
  remote: string,
  branch: string,
) {
  const access = await recentCredential(id)
  if (access.value.fullName.toLowerCase() !== fullName.toLowerCase())
    throw new Error('The connected GitHub repository changed. Refresh projects and try again.')
  const url = `https://github.com/${access.value.fullName}.git`
  await access.run(() =>
    withGitHubToken(access.value.token, async (env) => {
      await assertNotRewritten(root, env, url)
      await authenticatedGit(
        ['fetch', '--no-tags', '--', url, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
        env,
        access,
        root,
      )
    }),
  )
}
