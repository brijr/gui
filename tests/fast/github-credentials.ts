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
printf '%s\\t%s\\n' "$*" "$GUI_GIT_TOKEN" >> "$GUI_GIT_PROBE"
`,
  { mode: 0o700 },
)

try {
  // The Gui account changes while a clone waits for its credential: git never sees it.
  const accountGate = deferred<Credential>()
  requestImpl = async (url, token) =>
    url === path(1) ? accountGate.promise : normalRequest(url, token)
  const cloning = github.cloneGitHub(1, base)
  await until(() => count(1) === 1)
  session = 'account-B'
  events.emit('change')
  requestImpl = normalRequest
  accountGate.resolve({ token: 'old-account-credential', fullName: 'owner/private' })
  await changed(cloning)
  assert.equal((await git()).length, 0, 'A stale account credential must not reach git')

  // GitHub is disconnected and connected again (another provider account) meanwhile.
  const providerGate = deferred<Credential>()
  requestImpl = async (url, token) =>
    url === path(2) ? providerGate.promise : normalRequest(url, token)
  const reconnecting = github.cloneGitHub(2, base)
  await until(() => count(2) === 1)
  await github.disconnectGitHub()
  nextProvider = 'provider-B'
  await github.connectGitHub()
  requestImpl = normalRequest
  providerGate.resolve({ token: 'old-provider-credential', fullName: 'owner/private' })
  await changed(reconnecting)
  assert.equal((await git()).length, 0, 'A stale provider credential must not reach git')

  // A valid credential can become stale while preparing its environment/developer tools.
  const toolsGate = deferred<void>()
  let toolsStarted = false
  requireGit = () => {
    toolsStarted = true
    return toolsGate.promise
  }
  const preparedParent = join(base, 'prepared')
  await mkdir(preparedParent)
  const preparing = github.cloneGitHub(3, preparedParent)
  await until(() => toolsStarted)
  nextProvider = 'provider-C'
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

  // Each clone asks the service again, so revoked access is noticed at once.
  for (const name of ['first', 'second']) {
    const parent = join(base, name)
    await mkdir(parent)
    assert.equal(await github.cloneGitHub(4, parent), join(parent, 'private'))
  }
  assert.equal(count(4), 2, 'Every clone performs a fresh authorization')
  assert.equal((await git()).length, 2)
  assert.ok((await git()).every((operation) => operation.token === credentialFor(session, 4).token))

  requestImpl = async () => {
    throw new Error('Service offline')
  }
  await assert.rejects(
    github.cloneGitHub(5, base),
    (error) => error instanceof github.CredentialUnavailable,
  )
  for (const status of [401, 403]) {
    const denied = new AccountError(status, 'Repository is disconnected')
    requestImpl = async () => {
      throw denied
    }
    await assert.rejects(github.cloneGitHub(6, base), (error) => error === denied)
  }

  const staleFailure = deferred<Credential>()
  requestImpl = async () => staleFailure.promise
  const failing = github.cloneGitHub(7, base)
  await until(() => count(7) === 1)
  session = 'account-C'
  events.emit('change')
  staleFailure.reject(new Error('Service offline'))
  await changed(failing)
  console.log('GitHub credential races and fallback passed.')
} finally {
  await rm(base, { recursive: true, force: true })
}
