import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { AgentId, TurnItem } from '../src/shared/types'
import { electronExecutable, sleep, waitFor } from './helpers/env'
import { type GuiSession, standInsFile } from './helpers/session'
import { expect, test } from './helpers/test'

// Ask and Auto set the agent's own permission controls, as agents.ts declares them for
// each built-in agent. A stand-in ACP agent (a small Node script) takes the place of Muse
// Code or Grok Build through GUI_AGENT_STAND_INS, so it gets that agent's mapping, and
// records every request. No agent login or usage is needed.

/**
 * Speaks ACP (ndjson JSON-RPC) on stdio, as `kind`: `muse` offers Muse Code's modes as a
 * `mode` config option and as ACP session modes, plus its native approval policies;
 * `muse-old` is an older Muse host, with its modes only as session modes and only the
 * onRequest policy; `grok` has no modes. A prompt containing SWITCH=<mode> changes the
 * mode itself (like Muse's /plan) and reports only the mode; one containing RUN asks to
 * run a command.
 */
const AGENT_SCRIPT = String.raw`
const { appendFileSync } = require('node:fs')
const [log, kind] = process.argv.slice(2)
const MODES = [
  { id: 'default', name: 'On request' },
  { id: 'readOnly', name: 'Read-only' },
  { id: 'plan', name: 'Plan' },
  { id: 'bypassApprovals', name: 'Auto-approve' },
  { id: 'rejectApprovals', name: 'Reject prompts' },
]
const POLICIES =
  kind === 'muse' ? ['onRequest', 'promptUnmatched', 'denyUnmatched', 'allowAll'] : ['onRequest']
const state = { mode: 'default', nativeApprovalPolicy: 'onRequest' }
const select = (id, name, currentValue, options, extra = {}) =>
  ({ id, name, type: 'select', currentValue, options, ...extra })
const configOptions = () => {
  if (kind === 'grok') {
    return [select('model', 'Model', 'grok-code', [{ value: 'grok-code', name: 'Grok Code' }], { category: 'model' })]
  }
  const policies = POLICIES.map((value) => ({ value, name: value }))
  const options = [select('nativeApprovalPolicy', 'Native approval policy', state.nativeApprovalPolicy, policies)]
  if (kind === 'muse') {
    const modes = MODES.map(({ id, name }) => ({ value: id, name }))
    options.unshift(select('mode', 'Mode', state.mode, modes, { category: 'mode' }))
  }
  return options
}
const session = () => ({
  configOptions: configOptions(),
  ...(kind === 'grok' ? {} : { modes: { currentModeId: state.mode, availableModes: MODES } }),
})
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const notify = (sessionId, update) => write({ method: 'session/update', params: { sessionId, update } })

// Requests sent to Gui that it hasn't answered yet, by id.
const pending = new Map()
let lastId = 1000
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = ++lastId
    pending.set(id, resolve)
    write({ id, method, params })
  })

const prompt = async ({ sessionId, prompt }) => {
  const text = prompt.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  const mode = /SWITCH=(\w+)/.exec(text)?.[1]
  if (mode) {
    state.mode = mode
    notify(sessionId, { sessionUpdate: 'current_mode_update', currentModeId: mode })
  }
  if (text.includes('RUN')) {
    const toolCall = { toolCallId: 'run-1', title: 'npm test', kind: 'execute', status: 'pending' }
    notify(sessionId, { sessionUpdate: 'tool_call', ...toolCall })
    const options = [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ]
    await ask('session/request_permission', { sessionId, toolCall, options })
  }
  return { stopReason: 'end_turn' }
}

const handle = (message) => {
  const { id, method, params } = message
  if (method === undefined) {
    // Gui's answer to a request above.
    pending.get(id)?.(message.result)
    pending.delete(id)
    return
  }
  // Notifications, such as session/cancel, need no answer.
  if (id === undefined) return
  appendFileSync(log, JSON.stringify({ pid: process.pid, method, params }) + '\n')
  if (method === 'initialize') {
    const agentCapabilities = { loadSession: true }
    return write({ id, result: { protocolVersion: 1, agentCapabilities, authMethods: [] } })
  }
  if (method === 'session/new') return write({ id, result: { sessionId: 'session-1', ...session() } })
  if (method === 'session/load') return write({ id, result: session() })
  if (method === 'session/set_mode' && kind !== 'grok') {
    state.mode = params.modeId
    return write({ id, result: {} })
  }
  if (method === 'session/set_config_option' && kind !== 'grok') {
    state[params.configId] = params.value
    return write({ id, result: { configOptions: configOptions() } })
  }
  if (method === 'session/prompt') {
    prompt(params).then((result) => write({ id, result }))
    return
  }
  write({ id, error: { code: -32601, message: 'Method not found' } })
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    if (line) handle(JSON.parse(line))
  }
})
`

type Kind = 'muse' | 'muse-old' | 'grok'

interface Call {
  pid: number
  method: string
  params: Record<string, unknown>
}

interface StandIn {
  /** The requests each chat session's agent process received, oldest process first. */
  runs: () => Call[][]
  /** Launches the agent as another kind from its next session on. */
  become: (kind: Kind) => void
}

/**
 * Stands the script in for built-in agent `id`, opens the project with it as the chat's
 * agent. Picking it may start a health check session too, outside the project.
 */
async function useStandIn(session: GuiSession, id: AgentId, kind: Kind): Promise<StandIn> {
  const { base, root } = session.fixture
  const log = join(base, 'agent-calls.ndjson')
  const script = join(base, 'modes-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  const become = (as: Kind) => {
    const standIn = { command: electronExecutable(), args: [script, log, as] }
    const env = { ELECTRON_RUN_AS_NODE: '1' }
    writeFileSync(standInsFile(session.fixture), JSON.stringify({ [id]: { ...standIn, env } }))
  }
  become(kind)
  await waitFor(async () => (await session.state()).project !== null, 'the project to open')
  await session.chrome.evaluate((agentId) => window.gui.setAgent(agentId), id)
  const selected = async () => (await session.chatSnapshot()).meta.agentId === id
  await waitFor(selected, 'the agent to be selected')
  return {
    become,
    runs: () => {
      if (!existsSync(log)) return []
      const calls = readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Call)
      const opened = calls.filter(
        ({ method, params }) =>
          (method === 'session/new' || method === 'session/load') && params.cwd === root,
      )
      const pids = [...new Set(opened.map((call) => call.pid))]
      return pids.map((pid) => calls.filter((call) => call.pid === pid))
    },
  }
}

/** What a process was asked to change, and when it was prompted, in order. */
const steps = (calls: Call[] | undefined) =>
  (calls ?? []).flatMap(({ method, params }) => {
    if (method === 'session/set_mode') return [`set_mode ${params.modeId}`]
    if (method === 'session/set_config_option') return [`${params.configId}=${params.value}`]
    return method === 'session/prompt' ? ['prompt'] : []
  })

/** The `_meta` each chat process's session started with, and whether it was resumed. */
const starts = (runs: Call[][]) =>
  runs.map((calls) => {
    const start = calls.find((c) => c.method === 'session/new' || c.method === 'session/load')
    return { method: start?.method, meta: start?.params._meta }
  })

const send = (chat: Page, text: string) =>
  chat.evaluate((message) => window.gui.send(message), text)

const autoChip = (chat: Page) => chat.getByRole('button', { name: 'Auto mode', exact: true })

async function autoModeIs(session: GuiSession, on: boolean) {
  const autoApprove = async () => (await session.chatSnapshot()).meta.autoApprove
  await waitFor(async () => (await autoApprove()) === on, `Auto mode to be ${on ? 'on' : 'off'}`)
}

/** Waits for the chat header's mode to read `name`. */
async function modeIs(session: GuiSession, name: string) {
  const modeName = async () => (await session.chatSnapshot()).meta.modeName
  await waitFor(async () => (await modeName()) === name, `the mode to be ${name}`)
  await expect(session.chat.getByText(name, { exact: true })).toBeVisible()
}

/** Sends a message and waits for its turn, the `index`th, to finish well. */
async function turn(session: GuiSession, index: number, text: string) {
  expect(await send(session.chat, text)).toBe(true)
  const { turn } = await session.waitForTurn(index)
  expect(turn.status).toBe('done')
  return turn
}

type PermissionCard = Extract<TurnItem, { kind: 'permission' }>

test('Ask and Auto set Muse Code’s own mode and approval policy, and leave a mode it picks', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  const agent = await useStandIn(session, 'muse', 'muse')
  const { chat } = session

  // Auto (a fresh profile's default): before the first prompt, Auto-approve through the
  // `mode` config option. The approval policy is already the one Auto wants.
  await autoModeIs(session, true)
  await turn(session, 0, 'Hello')
  expect(agent.runs()).toHaveLength(1)
  expect(steps(agent.runs()[0])).toEqual(['mode=bypassApprovals', 'prompt'])
  await modeIs(session, 'Auto-approve')

  // Ask between turns applies at once: On request, and the policy that asks about every
  // call the user's rules don't allow.
  await autoChip(chat).click()
  await autoModeIs(session, false)
  await modeIs(session, 'On request')
  expect(steps(agent.runs()[0])).toEqual([
    'mode=bypassApprovals',
    'prompt',
    'mode=default',
    'nativeApprovalPolicy=promptUnmatched',
  ])

  // The agent switches itself to Plan, reporting only its mode: Gui shows it, and the
  // next turn keeps it.
  await turn(session, 1, 'SWITCH=plan Plan the next step')
  await modeIs(session, 'Plan')
  await turn(session, 2, 'Go on')
  await modeIs(session, 'Plan')
  expect(steps(agent.runs()[0]).slice(4)).toEqual(['prompt', 'prompt'])

  // Auto during a turn waits for the next prompt (the agent is busy).
  expect(await send(chat, 'RUN the tests')).toBe(true)
  const card = await waitFor(async () => {
    const current = (await session.chatSnapshot()).turns[3]
    const open = current?.items.find(
      (item): item is PermissionCard => item.kind === 'permission' && item.resolved === null,
    )
    return current && open ? { turnId: current.id, itemId: open.id } : null
  }, 'the command to ask')
  await autoChip(chat).click()
  await autoModeIs(session, true)
  await sleep(1000)
  await chat.evaluate(
    ({ turnId, itemId }) => window.gui.respondPermission(turnId, itemId, 'allow'),
    card,
  )
  expect((await session.waitForTurn(3)).turn.status).toBe('done')
  await sleep(500)
  expect(steps(agent.runs()[0]).slice(6)).toEqual(['prompt'])
  await modeIs(session, 'Plan')
  await turn(session, 4, 'Carry on')
  expect(steps(agent.runs()[0]).slice(7)).toEqual([
    'mode=bypassApprovals',
    'nativeApprovalPolicy=onRequest',
    'prompt',
  ])
  await modeIs(session, 'Auto-approve')
  await session.shot('agent-mode-auto')

  // An older host offers the mode only as session modes, and onRequest only: Gui uses
  // session/set_mode, and leaves the policy it can't change.
  agent.become('muse-old')
  await chat.evaluate(() => window.gui.newSession())
  await waitFor(async () => (await session.chatSnapshot()).turns.length === 0, 'a new chat')
  await turn(session, 0, 'Hello')
  expect(agent.runs()).toHaveLength(2)
  expect(steps(agent.runs()[1])).toEqual(['set_mode bypassApprovals', 'prompt'])
  await modeIs(session, 'Auto-approve')
  await autoChip(chat).click()
  await modeIs(session, 'On request')
  expect(steps(agent.runs()[1])).toEqual(['set_mode bypassApprovals', 'prompt', 'set_mode default'])
})

test('Ask and Auto start Grok Build’s session with its own permission mode, resuming it on a switch', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  const agent = await useStandIn(session, 'grok', 'grok')
  const { chat } = session

  // Auto: the session starts in Grok's auto mode.
  await autoModeIs(session, true)
  await turn(session, 0, 'Hello')
  expect(starts(agent.runs())).toEqual([{ method: 'session/new', meta: { autoMode: true } }])

  // Ask between turns takes effect with the next message, which resumes the session with
  // always-approve and auto mode off. It remembers the conversation, so no notice.
  await autoChip(chat).click()
  await autoModeIs(session, false)
  await sleep(500)
  expect(agent.runs()).toHaveLength(1)
  const resumed = await turn(session, 1, 'Hello again')
  expect(resumed.items.filter((item) => item.kind === 'notice')).toEqual([])
  const ask = { method: 'session/load', meta: { yoloMode: false, autoMode: false } }
  expect(starts(agent.runs())).toEqual([{ method: 'session/new', meta: { autoMode: true } }, ask])
  expect(agent.runs()[1]?.find((call) => call.method === 'session/load')?.params.sessionId).toBe(
    'session-1',
  )

  // Without a switch the session carries on; Auto resumes it in auto mode again. Grok has
  // no modes to set, so nothing else is asked of it.
  await turn(session, 2, 'And again')
  expect(agent.runs()).toHaveLength(2)
  await autoChip(chat).click()
  await autoModeIs(session, true)
  await turn(session, 3, 'Once more')
  expect(starts(agent.runs()).at(-1)).toEqual({ method: 'session/load', meta: { autoMode: true } })
  expect(agent.runs().map(steps)).toEqual([['prompt'], ['prompt', 'prompt'], ['prompt']])
})
