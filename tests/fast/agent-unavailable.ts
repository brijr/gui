import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS, type AgentId } from '../../src/shared/types'

// Isolated process, run by tests/agent-unavailable.test.ts with `bun test`: the store's agent
// sessions and CLIs are stubbed here, and a run keeps the first stubs it loads.
//
// `agent_unavailable` is sent for agents the user never picked too: Claude Code and Codex are
// checked on every launch, and every other installed agent by the background checks. Each
// event says whether the agent was the one in use (`current`), so a blocked user can be told
// from an old Codex lying around, and keeps the reason the check found.

let userData = ''
const tracked: { event: string; props: unknown }[] = []
/** How each agent's check fails, by agent (the others start) */
const failures = new Map<AgentId, () => Error>()
class AgentMissingError extends Error {}
class AgentAuthError extends Error {
  readonly failure = 'signed_out'
  readonly methods = []
}

mock.module('electron', () => ({
  app: { getPath: () => userData },
  shell: { openExternal: async () => undefined },
  net: {},
  powerMonitor: {},
  autoUpdater: {},
}))
mock.module('../../src/main/analytics', () => ({
  track: (event: string, props: unknown) => tracked.push({ event, props }),
}))
mock.module('../../src/main/agents', () => ({
  listAgents: async () => ({
    agents: AGENTS.map((agent) => ({
      ...agent,
      command: null,
      installed: true,
      installUrl: null,
      terminalSignIn: null,
    })),
    customError: null,
  }),
}))
mock.module('../../src/main/agent', () => ({
  AgentAuthError,
  AgentSession: class {
    constructor(readonly id: AgentId) {}
    async start() {
      const fail = failures.get(this.id)
      if (fail) throw fail()
      return { models: null }
    }
    dispose() {}
  },
}))
// The user's own Codex is older than Gui's floor; Claude Code is fine.
mock.module('../../src/main/agent-binaries', () => ({
  AgentMissingError,
  agentBinary: async (id: string) =>
    id === 'codex'
      ? { kind: 'missing', found: { path: '/x/codex', version: '0.160.0' }, mismatch: 'older' }
      : { kind: 'ready', binary: { path: '', version: '2.1.330', source: 'yours' } },
  forgetBinaries: () => undefined,
  installAgentBinary: async () => undefined,
  missingMessage: () => '',
  pinnedAgent: (id: AgentId) => (id === 'claude' || id === 'codex' ? id : null),
  requireAgentBinary: async () => ({ path: '', version: '1', source: 'yours' }),
}))
mock.module('../../src/main/shell-env', () => ({ getShellEnv: async () => ({}) }))
mock.module('../../src/main/terminal', () => ({ runInTerminal: async () => undefined }))

const { AgentHealthStore, agentHealth } = await import('../../src/main/agent-status')
const { flushPrefsSync, setPrefs } = await import('../../src/main/prefs')
const { AgentError, TimeoutError } = await import('../../src/main/errors')
agentHealth.dispose()
let store: InstanceType<typeof AgentHealthStore>

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'gui-agent-unavailable-'))
  tracked.length = 0
  failures.clear()
  setPrefs({ disabledAgents: [], agentId: 'claude' })
})
afterEach(() => {
  store.dispose()
  flushPrefsSync()
  rmSync(userData, { recursive: true, force: true })
})

const unavailable = () => tracked.filter((t) => t.event === 'agent_unavailable').map((t) => t.props)

test('a Claude Code user with an old Codex on the PATH: Codex too_old, not the one in use', async () => {
  store = new AgentHealthStore()
  await store.checkOnLaunch('claude')
  expect(unavailable()).toEqual([{ agent: 'codex', reason: 'too_old', current: 'no' }])
})

test('an agent that failed while merely installed is counted once more when it fails in use', async () => {
  store = new AgentHealthStore()
  await store.checkOnLaunch('claude')
  store.inUse = (id) => id === 'codex'
  await store.checkOnLaunch('codex')
  await store.checkOnLaunch('codex')
  expect(unavailable()).toEqual([
    { agent: 'codex', reason: 'too_old', current: 'no' },
    { agent: 'codex', reason: 'too_old', current: 'yes' },
  ])
})

test('the agent in use that fails is current', async () => {
  setPrefs({ agentId: 'codex' })
  store = new AgentHealthStore()
  await store.checkOnLaunch('codex')
  expect(unavailable()).toEqual([{ agent: 'codex', reason: 'too_old', current: 'yes' }])
})

test('an open chat’s own agent is in use too', async () => {
  failures.set('cursor', () => new AgentAuthError('Sign in to Cursor.'))
  store = new AgentHealthStore()
  store.inUse = (id) => id === 'cursor'
  await store.check('cursor')
  expect(unavailable()).toEqual([{ agent: 'cursor', reason: 'signed_out', current: 'yes' }])
})

test('an installed Cursor the user never picked is counted by the background checks as not current', async () => {
  failures.set('cursor', () => new AgentAuthError('Sign in to Cursor.'))
  store = new AgentHealthStore()
  await store.checkOnLaunch('claude')
  tracked.length = 0
  await store.checkInBackground()
  expect(unavailable()).toEqual([{ agent: 'cursor', reason: 'signed_out', current: 'no' }])
})

test('each failure keeps the reason the check found', async () => {
  failures.set('cursor', () => new AgentError('Cursor stopped unexpectedly.', null, 'agent_quit'))
  failures.set('opencode', () => new TimeoutError("The agent didn't respond. Try again.", null))
  failures.set('grok', () => new AgentError('No connection.', null, 'offline'))
  failures.set('amp', () => new Error('Something else.'))
  store = new AgentHealthStore()
  for (const id of ['cursor', 'opencode', 'grok', 'amp'] as const) await store.check(id)
  expect(unavailable()).toEqual([
    { agent: 'cursor', reason: 'agent_quit', current: 'no' },
    { agent: 'opencode', reason: 'timeout', current: 'no' },
    { agent: 'grok', reason: 'offline', current: 'no' },
    { agent: 'amp', reason: 'error', current: 'no' },
  ])
})

test('once per agent and reason each launch', async () => {
  failures.set('cursor', () => new AgentError('Cursor stopped unexpectedly.', null, 'agent_quit'))
  store = new AgentHealthStore()
  await store.check('cursor')
  await store.check('cursor')
  failures.set('cursor', () => new AgentAuthError('Sign in to Cursor.'))
  await store.check('cursor')
  expect(unavailable()).toEqual([
    { agent: 'cursor', reason: 'agent_quit', current: 'no' },
    { agent: 'cursor', reason: 'signed_out', current: 'no' },
  ])
})
