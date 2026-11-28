import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENTS, type AgentHealth, type AgentId, type ModelSettings } from '../../src/shared/types'

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
/** Models a check finds, by agent (none for the others) */
const lists = new Map<AgentId, ModelSettings>()
/** Checks running at once, now and at most */
const checks = { running: 0, most: 0 }
class AgentMissingError extends Error {}
class AgentAuthError extends Error {
  readonly methods = []
}
/** Agents whose check finds the user isn't signed in */
const signedOut = new Set<AgentId>()
/** The user's own Codex is below Gui's floor, until they update it */
let codexTooOld = false
/** What `agentBinary` found, until `forgetBinaries` (as in agent-binaries.ts) */
const binaries = new Map<AgentId, unknown>()
function findBinary(id: AgentId) {
  return id === 'codex' && codexTooOld
    ? {
        kind: 'missing',
        found: { path: '/x/codex', version: '0.160.0' },
        mismatch: 'older',
        needed: '0.164.0',
      }
    : { kind: 'ready', binary: { path: '', version: '1', source: 'own' } }
}
/** Holds the scan for installed agents open, to act while launch is still getting to the checks. */
let scanning: Promise<void> = Promise.resolve()

mock.module('electron', () => ({
  app: { getPath: () => userData },
  shell: { openExternal: async () => undefined },
  // Usage data (analytics.ts), which a build from source never sends.
  net: {},
  powerMonitor: {},
  autoUpdater: {},
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
  AgentAuthError,
  AgentSession: class {
    constructor(readonly id: AgentId) {}
    async start() {
      started.push(this.id)
      checks.running++
      checks.most = Math.max(checks.most, checks.running)
      await new Promise((resolve) => setTimeout(resolve, 2))
      checks.running--
      if (gone.has(this.id)) throw new AgentMissingError(`${this.id} isn't installed.`)
      if (signedOut.has(this.id)) throw new AgentAuthError(`Sign in to ${this.id}.`)
      return { models: lists.get(this.id) ?? null }
    }
    dispose() {}
  },
}))
mock.module('../../src/main/agent-binaries', () => ({
  AgentMissingError,
  agentBinary: async (id: AgentId) => {
    if (!binaries.has(id)) binaries.set(id, findBinary(id))
    return binaries.get(id)
  },
  forgetBinaries: (id?: AgentId) => (id ? binaries.delete(id) : binaries.clear()),
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
  signedOut.clear()
  lists.clear()
  checks.most = 0
  scanning = Promise.resolve()
  codexTooOld = false
  binaries.clear()
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

test('after launch, every other agent switched on is checked, two at a time', async () => {
  setPrefs({ disabledAgents: ['amp'] })
  store = new AgentHealthStore()
  await store.checkOnLaunch('claude')
  started.length = 0
  checks.most = 0
  await store.checkInBackground()
  const expected = AGENTS.map((agent) => agent.id).filter(
    (id) => id !== 'claude' && id !== 'codex' && id !== 'amp',
  )
  expect([...started].sort()).toEqual([...expected].sort())
  expect(checks.most).toBe(2)
  expect(statusOf('amp')).toBe('unknown')
  // Checked already: not again.
  started.length = 0
  await store.checkInBackground()
  expect(started).toEqual([])
})

test('an agent’s models are listed from its last check until it is checked again', async () => {
  setPrefs({ disabledAgents: [] })
  const models: ModelSettings = {
    model: { id: 'model', value: 'k3', options: [{ value: 'k3', name: 'Kimi K3', group: null }] },
    effort: null,
    provider: null,
  }
  lists.set('opencode', models)
  store = new AgentHealthStore()
  await store.check('opencode')
  expect(store.listedModels('opencode')).toEqual(models)
  store.dispose()

  // The next launch, before its check: the list from the file.
  lists.clear()
  store = new AgentHealthStore()
  expect(store.listedModels('opencode')).toEqual({ model: models.model, provider: null })
  // Checked, and it has none now: none listed.
  await store.check('opencode')
  expect(store.listedModels('opencode')).toBeNull()
  store.dispose()
  store = new AgentHealthStore()
  expect(store.listedModels('opencode')).toBeNull()
})

// Each check starts the agent's CLI, so the checks after launch skip an agent a check found in
// the last day: it lists its models from then, and is checked when the user picks it.

const HOUR = 60 * 60_000
const T = Date.UTC(2026, 10, 17)
const kimi: ModelSettings = {
  model: { id: 'model', value: 'k3', options: [{ value: 'k3', name: 'Kimi K3', group: null }] },
  effort: null,
  provider: null,
}
/** A launch at `now`: the agents in use, then the others in the background. */
async function launchAt(now: number) {
  store = new AgentHealthStore(() => now)
  await store.checkOnLaunch('claude')
  started.length = 0
  await store.checkInBackground()
}

test('after launch, an agent checked less than a day ago isn’t checked again', async () => {
  setPrefs({ disabledAgents: [] })
  lists.set('opencode', kimi)
  await launchAt(T)
  expect(started).toContain('opencode')
  expect(started).toContain('kiro')
  store.dispose()

  // Next launch, an hour on: its list from then, unchecked. So is an agent with none to list.
  await launchAt(T + HOUR)
  expect(started).not.toContain('opencode')
  expect(started).not.toContain('kiro')
  expect(statusOf('opencode')).toBe('unknown')
  expect(store.listedModels('opencode')).toEqual({ model: kimi.model, provider: null })
  // Picked by the user: checked right away all the same.
  store.ensureChecked('opencode')
  await until(() => statusOf('opencode') === 'ready')
  expect(started).toContain('opencode')
  store.dispose()

  // A day after its last check: checked again.
  await launchAt(T + 26 * HOUR)
  expect(started).toContain('opencode')
})

test('a clock set back makes the last check’s time due', async () => {
  setPrefs({ disabledAgents: [] })
  lists.set('opencode', kimi)
  await launchAt(T)
  store.dispose()
  await launchAt(T - HOUR)
  expect(started).toContain('opencode')
})

test('an agent not signed in isn’t started again until a day on, unless the user asks', async () => {
  setPrefs({ disabledAgents: [] })
  signedOut.add('opencode')
  await launchAt(T)
  expect(statusOf('opencode')).toBe('signed-out')
  store.dispose()

  await launchAt(T + HOUR)
  expect(started).not.toContain('opencode')
  expect(store.listedModels('opencode')).toBeNull()
  await store.check('opencode')
  expect(statusOf('opencode')).toBe('signed-out')
  store.dispose()

  await launchAt(T + 26 * HOUR)
  expect(started).toContain('opencode')
})

test('an agent with no models to list isn’t started again until a day on', async () => {
  setPrefs({ disabledAgents: [] })
  await launchAt(T)
  expect(started).toContain('kiro')
  expect(statusOf('kiro')).toBe('ready')
  store.dispose()

  await launchAt(T + HOUR)
  expect(started).not.toContain('kiro')
  store.dispose()

  await launchAt(T + 26 * HOUR)
  expect(started).toContain('kiro')
})

test('a check that fails doesn’t count, so the next launch checks again', async () => {
  setPrefs({ disabledAgents: [] })
  lists.set('opencode', kimi)
  await launchAt(T - 26 * HOUR)
  store.dispose()
  gone.add('opencode')
  await launchAt(T)
  expect(statusOf('opencode')).toBe('not-installed')
  store.dispose()
  gone.clear()
  await launchAt(T + HOUR)
  expect(started).toContain('opencode')
})

test('a too-old Codex the user updates is used on their return to Gui, or on Check again', async () => {
  setPrefs({ disabledAgents: [] })
  codexTooOld = true
  store = new AgentHealthStore()
  await store.checkOnLaunch('claude')
  expect(statusOf('codex')).toBe('not-installed')
  expect(store.list().find((agent) => agent.id === 'codex')?.install).toBe('update')

  // They ran `codex update` in a terminal and came back to Gui.
  codexTooOld = false
  await store.onAppFocus()
  expect(statusOf('codex')).toBe('ready')

  // Check again reads the version again too.
  codexTooOld = true
  await store.checkAll()
  expect(statusOf('codex')).toBe('not-installed')
  codexTooOld = false
  await store.checkAll()
  expect(statusOf('codex')).toBe('ready')
})
