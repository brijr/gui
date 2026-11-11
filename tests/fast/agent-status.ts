import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS, type AgentHealth, type AgentId } from '../../src/shared/types'

// Isolated process, run by tests/agent-status.test.ts with `bun test`: the store starts agent
// sessions and finds their CLIs, which are stubbed here, and a run keeps the first stubs it
// loads.
//
// An agent switched off in Settings isn't checked. It used to be marked "checking" on launch
// all the same and stayed so, and switching it on again didn't check it: only an agent whose
// status is still unknown is checked then.

let userData = ''
/** Agents a session was started for, in order: each start is a check. */
const started: AgentId[] = []
/** Agents whose CLI is gone when a check starts them, though the scan found them */
const gone = new Set<AgentId>()
class AgentMissingError extends Error {}
/** Holds the scan for installed agents open, to act while launch is still getting to the checks. */
let scanning: Promise<void> = Promise.resolve()

mock.module('electron', () => ({
  app: { getPath: () => userData },
  shell: { openExternal: async () => undefined },
}))
mock.module('../../src/main/agents', () => ({
  listAgents: async () => {
    await scanning
    return {
      agents: AGENTS.map((agent) => ({
        ...agent,
        command: null,
        installed: true,
        installUrl: null,
        terminalSignIn: null,
      })),
      customError: null,
    }
  },
}))
mock.module('../../src/main/agent', () => ({
  AgentAuthError: class extends Error {},
  AgentSession: class {
    constructor(readonly id: AgentId) {}
    async start() {
      started.push(this.id)
      if (gone.has(this.id)) throw new AgentMissingError(`${this.id} isn't installed.`)
      return { models: null }
    }
    dispose() {}
  },
}))
mock.module('../../src/main/agent-binaries', () => ({
  AgentMissingError,
  agentBinary: async () => ({ kind: 'ready', binary: { path: '', version: '1', source: 'own' } }),
  forgetBinaries: () => undefined,
  installAgentBinary: async () => undefined,
  missingMessage: () => '',
  pinnedAgent: (id: AgentId) => (id === 'claude' || id === 'codex' ? id : null),
  requireAgentBinary: async () => ({ path: '', version: '1', source: 'own' }),
}))
mock.module('../../src/main/shell-env', () => ({ getShellEnv: async () => ({}) }))
mock.module('../../src/main/terminal', () => ({ runInTerminal: async () => undefined }))

const { AgentHealthStore, agentHealth } = await import('../../src/main/agent-status')
const { flushPrefsSync, setPrefs } = await import('../../src/main/prefs')
// The app's own store listens to the same switches; each test makes its own.
agentHealth.dispose()

let store: InstanceType<typeof AgentHealthStore>
const statusOf = (id: AgentId) => store.list().find((agent) => agent.id === id)?.status
/** Every status the agent was shown with, as the windows would have drawn them. */
function watch(id: AgentId) {
  const seen: AgentHealth['status'][] = []
  store.on('change', (health) => {
    const status = health.find((agent) => agent.id === id)?.status
    if (status && seen.at(-1) !== status) seen.push(status)
  })
  return seen
}
async function until(check: () => boolean) {
  for (let tries = 0; tries < 200 && !check(); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  expect(check()).toBe(true)
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'gui-agent-status-'))
  started.length = 0
  gone.clear()
  scanning = Promise.resolve()
})
afterEach(() => {
  // A store left listening would answer the next test's switches too.
  store.dispose()
  // Preferences are saved a moment after they change: into this test's folder, before it goes.
  flushPrefsSync()
  rmSync(userData, { recursive: true, force: true })
})

test('on launch, the agents switched on are checked and say so at once', async () => {
  setPrefs({ disabledAgents: [] })
  store = new AgentHealthStore()
  const launch = store.checkOnLaunch('claude')
  expect(statusOf('claude')).toBe('checking')
  expect(statusOf('codex')).toBe('checking')
  await launch
  expect(statusOf('claude')).toBe('ready')
  expect(statusOf('codex')).toBe('ready')
  expect([...started].sort()).toEqual(['claude', 'codex'])
})

test('an agent switched off is never said to be checking', async () => {
  setPrefs({ disabledAgents: ['codex'] })
  store = new AgentHealthStore()
  const seen = watch('codex')
  const launch = store.checkOnLaunch('claude')
  expect(statusOf('claude')).toBe('checking')
  expect(statusOf('codex')).toBe('unknown')
  await launch
  expect(statusOf('codex')).toBe('unknown')
  expect(seen).not.toContain('checking')
  expect(started).toEqual(['claude'])
})

test('switched on again, it is checked', async () => {
  setPrefs({ disabledAgents: ['codex'] })
  store = new AgentHealthStore()
  await store.checkOnLaunch('claude')
  setPrefs({ disabledAgents: [] })
  expect(statusOf('codex')).toBe('checking')
  await until(() => statusOf('codex') === 'ready')
  expect(started).toEqual(['claude', 'codex'])
})

test('switched off while launch is getting to it, it stops saying so and is checked later', async () => {
  setPrefs({ disabledAgents: [] })
  store = new AgentHealthStore()
  let scanned = () => {}
  scanning = new Promise((resolve) => {
    scanned = resolve
  })
  const launch = store.checkOnLaunch('claude')
  expect(statusOf('codex')).toBe('checking')
  setPrefs({ disabledAgents: ['codex'] })
  scanned()
  await launch
  expect(statusOf('codex')).toBe('unknown')
  expect(started).toEqual(['claude'])

  setPrefs({ disabledAgents: [] })
  await until(() => statusOf('codex') === 'ready')
  expect(started).toEqual(['claude', 'codex'])
})

test('the default agent is checked too, unless it is switched off', async () => {
  setPrefs({ disabledAgents: ['opencode'] })
  store = new AgentHealthStore()
  await store.checkOnLaunch('opencode')
  expect(statusOf('opencode')).toBe('unknown')
  expect([...started].sort()).toEqual(['claude', 'codex'])
})

test('an agent gone since Gui found it reads Not installed, not an error to try again', async () => {
  setPrefs({ disabledAgents: [] })
  store = new AgentHealthStore()
  await store.checkOnLaunch('claude')
  gone.add('opencode')
  await store.check('opencode')
  expect(statusOf('opencode')).toBe('not-installed')
  expect(store.list().find((agent) => agent.id === 'opencode')?.message ?? null).toBeNull()
})
