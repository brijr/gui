import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shell } from 'electron'
import type { GitHubProfile, GitHubRepository, GitHubState } from '../shared/github'
import { AccountError, request, savedSession, serviceUrl } from './account'
import { parseRepo } from './clone'
import { developerTools } from './developer-tools'
import { getShellEnv } from './shell-env'

export { connectGitHub } from './account'

/** The account's GitHub connection and the repositories Gui may see through it. */
export async function getGitHub(): Promise<GitHubState> {
  try {
    serviceUrl()
  } catch {
    return { configured: false, profile: null, repositories: [] }
  }
  const token = await savedSession()
  if (!token) return { configured: true, profile: null, repositories: [] }
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
  await developerTools.requireGit()
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

/**
 * The connected repository's token, kept for a few minutes: the bar over the chat reads
 * pull request status every minute, and each credential costs the service a repository list.
 */
const CREDENTIAL_TTL = 5 * 60_000
const credentials = new Map<number, { token: string; fullName: string; until: number }>()
async function recentCredential(id: number) {
  const kept = credentials.get(id)
  if (kept && kept.until > Date.now()) return kept
  const fresh = { ...(await credential(id)), until: Date.now() + CREDENTIAL_TTL }
  credentials.set(id, fresh)
  return fresh
}

/** A GET on api.github.com as the connected user, for a repository they connected. */
export async function readGitHub<T>(id: number, fullName: string, path: string): Promise<T> {
  const access = await recentCredential(id)
  if (access.fullName.toLowerCase() !== fullName.toLowerCase())
    throw new Error('The connected GitHub repository changed. Refresh projects and try again.')
  const response = await fetch(`https://api.github.com/repos/${access.fullName}${path}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: {
      Authorization: `Bearer ${access.token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Gui',
      'X-GitHub-Api-Version': '2026-03-10',
    },
  })
  if (response.status === 401) credentials.delete(id)
  if (!response.ok) throw new Error('Could not read the pull request from GitHub.')
  return (await response.json()) as T
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
  if (access.fullName.toLowerCase() !== fullName.toLowerCase())
    throw new Error('The connected GitHub repository changed. Refresh projects and try again.')
  await withGitHubToken(access.token, (env) =>
    authenticatedGit(
      [
        'fetch',
        '--no-tags',
        '--',
        `https://github.com/${access.fullName}.git`,
        `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`,
      ],
      env,
      root,
    ),
  )
}
