// Actual github.ts in a child process: platform stubs do not affect other test modules.
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CredentialScopeChanged } from '../../src/main/session-credential-cache'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'GitHub operation did not settle')
    await new Promise((done) => setTimeout(done, 1))
  }
}

const events = new EventEmitter()
let session = 'account-A'
let provider = 'provider-A'
let nextProvider = provider
class AccountError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
interface Credential {
  token: string
  fullName: string
}
const requests: { path: string; session: string | null }[] = []
const reads: string[] = []
let gitBin = ''
let gitLog = ''
const git = async () =>
  (await readFile(gitLog, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => ({ args: line.split('\t')[0], token: line.split('\t')[1] }))
const credentialFor = (token: string | null, id: number): Credential => ({
  token: `${token}:${provider}:${id}`,
  fullName: 'owner/private',
})
const normalRequest = async (path: string, token: string | null) => {
  const match = /^\/repositories\/(\d+)\/credential$/.exec(path)
  return match ? credentialFor(token, Number(match[1])) : { ok: true }
}
let requestImpl: (path: string, token: string | null) => Promise<unknown> = normalRequest
let requireGit = () => Promise.resolve()
let fetchImpl = (_token: string) => Promise.resolve(Response.json({ ok: true }))

mock.module('electron', () => ({ app: { on() {} }, shell: {} }))
mock.module('../../src/main/account', () => ({
  AccountError,
  accountEvents: events,
  savedSession: async () => session,
  serviceUrl: () => 'https://example.test',
  connectGitHub: async () => {
    provider = nextProvider
  },
  request: async (path: string, token: string | null) => {
    requests.push({ path, session: token })
    return requestImpl(path, token)
  },
}))
mock.module('../../src/main/clone', () => ({
  parseRepo: (fullName: string) => ({
    name: fullName.split('/')[1],
    url: `https://github.com/${fullName}.git`,
  }),
}))
mock.module('../../src/main/developer-tools', () => ({
  developerTools: { requireGit: () => requireGit() },
}))
mock.module('../../src/main/shell-env', () => ({
  getShellEnv: async () => ({ PATH: gitBin, GUI_GIT_PROBE: gitLog }),
}))
globalThis.fetch = async (_url, options) => {
  const authorization = new Headers(options?.headers).get('Authorization') ?? ''
  reads.push(authorization)
  return fetchImpl(authorization)
}
const github = await import('../../src/main/github')
const changed = (operation: Promise<unknown>) =>
  assert.rejects(
    operation,
    (error) =>
      error instanceof CredentialScopeChanged && !(error instanceof github.CredentialUnavailable),
  )
const path = (id: number) => `/repositories/${id}/credential`
const count = (id: number) => requests.filter((entry) => entry.path === path(id)).length
const base = await mkdtemp(join(tmpdir(), 'gui-github-credential-test-'))
gitBin = join(base, 'bin')
gitLog = join(base, 'git.log')
await mkdir(gitBin)
// Use an isolated executable: Bun does not consistently stub native child_process exports.
await writeFile(
  join(gitBin, 'git'),
  `#!/bin/sh
case "$1" in config) exit 0 ;; esac
printf '%s\\t%s\\n' "$*" "$GUI_GIT_TOKEN" >> "$GUI_GIT_PROBE"
`,
  { mode: 0o700 },
)

try {
  const accountGate = deferred<Credential>()
  requestImpl = async (url, token) =>
    url === path(1) ? accountGate.promise : normalRequest(url, token)
  const oldRead = github.readGitHub(1, 'owner/private', '/pulls')
  await until(() => count(1) === 1)
  session = 'account-B'
  events.emit('change')
  requestImpl = normalRequest
  accountGate.resolve({ token: 'old-account-credential', fullName: 'owner/private' })
  await changed(oldRead)
  assert.equal(reads.length, 0, 'An old account credential cannot reach the GitHub API')
  await github.readGitHub(1, 'owner/private', '/pulls')
  await github.readGitHub(1, 'owner/private', '/pulls')
  assert.equal(count(1), 2)
  assert.ok(reads.every((token) => token.includes('account-B')))

  const providerGate = deferred<Credential>()
  requestImpl = async (url, token) =>
    url === path(2) ? providerGate.promise : normalRequest(url, token)
  const oldProvider = github.readGitHub(2, 'owner/private', '/pulls')
  await until(() => count(2) === 1)
  await github.disconnectGitHub()
  nextProvider = 'provider-B'
  await github.connectGitHub()
  requestImpl = normalRequest
  providerGate.resolve({ token: 'old-provider-credential', fullName: 'owner/private' })
  await changed(oldProvider)
  const coalescedGate = deferred<Credential>()
  requestImpl = async (url, token) =>
    url === path(2) ? coalescedGate.promise : normalRequest(url, token)
  const concurrent = [
    github.readGitHub(2, 'owner/private', '/pulls'),
    github.readGitHub(2, 'owner/private', '/pulls'),
  ]
  await until(() => count(2) === 2)
  coalescedGate.resolve(credentialFor(session, 2))
  await Promise.all(concurrent)
  requestImpl = normalRequest
  await github.readGitHub(2, 'owner/private', '/pulls')
  assert.equal(count(2), 2, 'Coalesced and cached reads only request the new provider once')

  const cloneGate = deferred<Credential>()
  requestImpl = async (url, token) =>
    url === path(3) ? cloneGate.promise : normalRequest(url, token)
  const cloning = github.cloneGitHub(3, base)
  await until(() => count(3) === 1)
  session = 'account-C'
  events.emit('change')
  requestImpl = normalRequest
  cloneGate.resolve({ token: 'old-clone-credential', fullName: 'owner/private' })
  await changed(cloning)
  assert.equal((await git()).length, 0, 'A stale fresh clone credential must not reach git')

  const pushGate = deferred<Credential>()
  requestImpl = async (url, token) =>
    url === path(4) ? pushGate.promise : normalRequest(url, token)
  const pushing = github.pushGitHub(4, 'owner/private', base, 'topic')
  await until(() => count(4) === 1)
  await github.disconnectGitHub()
  nextProvider = 'provider-C'
  await github.connectGitHub()
  requestImpl = normalRequest
  pushGate.resolve({ token: 'old-push-credential', fullName: 'owner/private' })
  await changed(pushing)
  assert.equal((await git()).length, 0, 'A stale fresh push credential must not reach git')

  // A valid credential can become stale while preparing its environment/developer tools.
  const toolsGate = deferred<void>()
  let toolsStarted = false
  requireGit = () => {
    toolsStarted = true
    return toolsGate.promise
  }
  const preparedParent = join(base, 'prepared')
  await mkdir(preparedParent)
  const preparing = github.cloneGitHub(5, preparedParent)
  await until(() => toolsStarted)
  nextProvider = 'provider-D'
  await github.connectGitHub()
  toolsGate.resolve()
  await changed(preparing)
  assert.equal(
    (await git()).length,
    0,
    'Identity is rechecked after preparation, before spawning git',
  )
  assert.equal(await stat(join(preparedParent, 'private')).catch(() => null), null)
  requireGit = () => Promise.resolve()

  const validParent = join(base, 'valid')
  await mkdir(validParent)
  await github.readGitHub(6, 'owner/private', '/pulls')
  assert.equal(await github.cloneGitHub(6, validParent), join(validParent, 'private'))
  await github.pushGitHub(6, 'owner/private', base, 'topic')
  assert.equal(count(6), 3, 'Clone and push perform fresh authorization despite a cached read')
  assert.equal((await git()).length, 2)
  assert.ok((await git()).every((operation) => operation.token === credentialFor(session, 6).token))

  const responseGate = deferred<Response>()
  let oldRequestStarted = false
  const previousToken = `Bearer ${credentialFor(session, 7).token}`
  fetchImpl = (authorization) => {
    if (authorization === previousToken) {
      oldRequestStarted = true
      return responseGate.promise
    }
    return Promise.resolve(Response.json({ ok: true }))
  }
  const lateRead = github.readGitHub(7, 'owner/private', '/pulls')
  await until(() => oldRequestStarted)
  session = 'account-D'
  events.emit('change')
  await github.readGitHub(7, 'owner/private', '/pulls')
  responseGate.resolve(Response.json({}, { status: 401 }))
  await changed(lateRead)
  await github.readGitHub(7, 'owner/private', '/pulls')
  assert.equal(count(7), 2, 'A late old-account 401 cannot evict the new credential')
  fetchImpl = () => Promise.resolve(Response.json({ ok: true }))

  requestImpl = async () => {
    throw new Error('Service offline')
  }
  await assert.rejects(
    github.readGitHub(8, 'owner/private', '/pulls'),
    (error) => error instanceof github.CredentialUnavailable,
  )
  requestImpl = normalRequest
  await github.readGitHub(8, 'owner/private', '/pulls')
  assert.equal(count(8), 2, 'A service failure remains retryable')
  for (const status of [401, 403]) {
    const denied = new AccountError(status, 'Repository is disconnected')
    requestImpl = async () => {
      throw denied
    }
    await assert.rejects(
      github.pushGitHub(9, 'owner/private', base, 'topic'),
      (error) => error === denied,
    )
  }

  const staleFailure = deferred<Credential>()
  requestImpl = async () => staleFailure.promise
  const failing = github.pushGitHub(10, 'owner/private', base, 'topic')
  await until(() => count(10) === 1)
  session = 'account-E'
  events.emit('change')
  staleFailure.reject(new Error('Service offline'))
  await changed(failing)
  console.log('GitHub credential races and fallback passed.')
} finally {
  await rm(base, { recursive: true, force: true })
}
