import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, shell } from 'electron'
import type { GitHubProfile, GitHubRepository, GitHubState } from '../shared/github'
import { asRepoToken, type RepoToken } from '../shared/tokens'
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
import { execFile } from './process'
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
/** A repository's token, asked for fresh each clone so the service checks access every time. */
const credentials = new SessionCredentialCache(savedSession, loadCredential, 0)
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

async function withGitHubToken<T>(
  token: RepoToken,
  action: (env: NodeJS.ProcessEnv) => Promise<T>,
) {
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
/** Gui can't reach the account service for a credential; trying again later may work. */
export class CredentialUnavailable extends Error {}

interface GitHubCredential {
  token: RepoToken
  fullName: string
}

async function loadCredential(id: number, session: string | null) {
  let result: GitHubCredential
  try {
    result = await request(`/repositories/${id}/credential`, session, 'POST')
  } catch (error) {
    // Signed out or no longer connected is the user's to fix; anything else is the service's.
    if (error instanceof AccountError && error.status < 500) throw error
    throw new CredentialUnavailable("Couldn't reach Gui accounts.", { cause: error })
  }
  if (!/^[\w-]+\/[\w.-]+$/.test(result.fullName)) throw new Error('Invalid GitHub repository name.')
  return { token: asRepoToken(result.token), fullName: result.fullName }
}

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
                    "GitHub couldn't complete this git operation. Check repository access and try again.",
                  ),
                )
              : resolve(),
        )
      }),
  )
}
export async function cloneGitHub(id: number, parent: string): Promise<string> {
  const access = await credentials.fresh(id)
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
    throw new Error(`Couldn't clone ${fullName}. Check repository access and try again.`)
  }
}
