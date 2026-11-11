import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TestInfo } from '@playwright/test'
import { type AgentId, CUSTOM_AGENT_PREFIX, type TurnItem } from '../src/shared/types'
import { electronExecutable, sleep, waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// Subagents as their own sessions (the ACP subagents RFD), against a stand-in ACP agent that
// sends what claude-agent-acp sends a client declaring `clientCapabilities.subagents`: each
// subagent announced on the parent with `subagent_update`, its task and answer as
// `session_message`s, and its own steps, words and questions on its own session. No login,
// no usage.

const AGENT: AgentId = `${CUSTOM_AGENT_PREFIX}Subagents`
const STYLES = 'child-styles'
const ROUTES = 'child-routes'

/**
 * Two subagents at once: Styles reads two files and answers; Routes asks to run a command,
 * then works until it's stopped alone. Then the agent sums up. Every message from Gui is
 * logged.
 */
const AGENT_SCRIPT = String.raw`
const { appendFileSync } = require('node:fs')
const [log] = process.argv.slice(2)
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const notify = (sessionId, update) => write({ method: 'session/update', params: { sessionId, update } })
const pending = new Map()
let lastId = 1000
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = ++lastId
    pending.set(id, resolve)
    write({ id, method, params })
  })
const cancels = new Map()
const cancelled = (sessionId) => new Promise((resolve) => cancels.set(sessionId, resolve))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const STYLES = '${STYLES}'
const ROUTES = '${ROUTES}'
let cwd = '/'
let subagents = false
const say = (text) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
const tool = (toolCallId, title, kind, status, file) => ({
  sessionUpdate: 'tool_call', toolCallId, title, kind, status,
  ...(file ? { locations: [{ path: cwd + '/' + file }] } : {}),
})
const done = (toolCallId, status = 'completed') => ({ sessionUpdate: 'tool_call_update', toolCallId, status })
const state = (root, sessionId, value) =>
  notify(root, { sessionUpdate: 'subagent_update', sessionId, state: value })

async function launch(root, sessionId, title, task) {
  notify(root, {
    sessionUpdate: 'subagent_update', sessionId, title, description: 'Explore',
    capabilities: { cancel: {} }, state: { state: 'running' },
  })
  // The launch's task, in the parent's transcript and the child's.
  const message = {
    sessionUpdate: 'session_message', messageId: 'launch-' + sessionId,
    senderSessionId: root, recipientSessionId: sessionId, content: [{ type: 'text', text: task }],
  }
  notify(root, { ...message, recipientMessageId: message.messageId })
  notify(sessionId, { ...message, senderMessageId: message.messageId })
}

async function prompt({ sessionId: root }) {
  if (!subagents) {
    notify(root, say('This client did not declare clientCapabilities.subagents.'))
    return { stopReason: 'end_turn' }
  }
  notify(root, say("I'll look at the styles and the routes at once."))
  await launch(root, STYLES, 'Styles', 'Find where the button colors are defined.')
  await launch(root, ROUTES, 'Routes', 'List the app routes.')
  notify(STYLES, tool('s1', 'Read src/App.css', 'read', 'in_progress', 'src/App.css'))
  notify(ROUTES, tool('r1', 'grep -rn "path:" src', 'search', 'completed'))
  notify(STYLES, say('Looking at the stylesheet.'))
  // Routes needs the user; Styles waits on the same answer, so both show working.
  const run = { toolCallId: 'r2', title: 'npm run routes', kind: 'execute' }
  notify(ROUTES, tool('r2', 'npm run routes', 'execute', 'pending'))
  state(root, ROUTES, { state: 'requires_action' })
  const answer = await ask('session/request_permission', {
    sessionId: ROUTES,
    toolCall: run,
    // Leading with No flags it, so Gui asks the user even in Auto mode.
    options: [
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    ],
  })
  state(root, ROUTES, { state: 'running' })
  const allowed = answer?.outcome?.optionId === 'allow'
  notify(ROUTES, { sessionUpdate: 'tool_call_update', toolCallId: 'r2', status: allowed ? 'in_progress' : 'failed' })
  // Styles finishes, and answers its parent.
  notify(STYLES, done('s1'))
  notify(STYLES, tool('s2', 'Read src/index.css', 'read', 'completed', 'src/index.css'))
  const found = 'The buttons use --accent, defined in src/index.css.'
  notify(STYLES, say(found))
  state(root, STYLES, { state: 'idle', stopReason: 'end_turn' })
  notify(root, {
    sessionUpdate: 'session_message', messageId: 'launch-' + STYLES + ':reply',
    senderSessionId: STYLES, recipientSessionId: root, content: [{ type: 'text', text: found }],
  })
  // Routes works until it's stopped on its own session; the agent goes on.
  await cancelled(ROUTES)
  notify(ROUTES, done('r2', 'failed'))
  state(root, ROUTES, { state: 'idle', stopReason: 'cancelled' })
  await sleep(100)
  notify(root, say('The button colors come from --accent in src/index.css.'))
  return { stopReason: 'end_turn' }
}

const handle = (message) => {
  const { id, method, params } = message
  if (method === undefined) {
    const resolve = pending.get(id)
    pending.delete(id)
    resolve?.(message.result)
    return
  }
  appendFileSync(log, JSON.stringify({ method, params }) + '\n')
  if (method === 'session/cancel') {
    cancels.get(params.sessionId)?.()
    cancels.delete(params.sessionId)
    return
  }
  if (id === undefined) return
  if (method === 'initialize') {
    const declared = params.clientCapabilities?.subagents
    subagents = typeof declared === 'object' && declared !== null
    return write({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
  }
  if (method === 'session/new') {
    cwd = params.cwd
    return write({ id, result: { sessionId: 'session-' + process.pid } })
  }
  if (method === 'session/prompt') {
    prompt(params).then(
      (result) => write({ id, result }),
      (error) => write({ id, error: { code: -32603, message: error.message } }),
    )
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

interface Call {
  method: string
  params: Record<string, unknown>
}

/** Adds the stand-in to agents.json, selects it, and returns what it was sent so far. */
async function useStandIn(session: GuiSession) {
  const { base, userData } = session.fixture
  const script = join(base, 'subagents-agent.cjs')
  const log = join(base, 'subagents-calls.ndjson')
  writeFileSync(script, AGENT_SCRIPT)
  const agents = {
    Subagents: {
      command: electronExecutable(),
      args: [script, log],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
  }
  writeFileSync(join(userData, 'agents.json'), JSON.stringify(agents))
  await session.chrome.evaluate(() => window.gui.checkAgents())
  const listed = async () => (await session.state()).agents.some((agent) => agent.id === AGENT)
  await waitFor(listed, 'the stand-in agent to be listed')
  await waitFor(async () => (await session.state()).project !== null, 'the project to open')
  await session.chrome.evaluate((id) => window.gui.setAgent(id), AGENT)
  const selected = async () => (await session.chatSnapshot()).meta.agentId === AGENT
  await waitFor(selected, 'the stand-in agent to be selected')
  return (): Call[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Call)
      : []
}

type SubagentItem = Extract<TurnItem, { kind: 'subagent' }>

async function firstTurn(session: GuiSession) {
  const { turns } = await session.chatSnapshot()
  const items = turns[0]?.items ?? []
  const subagent = (id: string) =>
    items.find((item): item is SubagentItem => item.kind === 'subagent' && item.id === id)
  return { turn: turns[0], items, styles: subagent(STYLES), routes: subagent(ROUTES) }
}

/** The chat page as Playwright renders it (never the desktop), kept with the test's results. */
async function chatShot(session: GuiSession, testInfo: TestInfo, name: string) {
  const file = testInfo.outputPath(`${name}.png`)
  mkdirSync(dirname(file), { recursive: true })
  await session.chat.screenshot({ path: file })
  await testInfo.attach(name, { path: file, contentType: 'image/png' })
}

test('subagents show as groups where they started, and one can be stopped alone', async ({
  launch,
}, testInfo) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  const calls = await useStandIn(session)
  const chat = session.chat

  expect(await chat.evaluate(() => window.gui.send('Where do the button colors come from?'))).toBe(
    true,
  )

  // Both at once: Styles on its step, Routes waiting on the user's answer.
  const asked = await waitFor(async () => {
    const now = await firstTurn(session)
    const card = now.items.find((item) => item.kind === 'permission' && item.resolved === null)
    return now.styles && now.routes?.status === 'waiting' && card ? { ...now, card } : null
  }, 'both subagents to run, and Routes to ask')
  expect(calls().find((call) => call.method === 'initialize')?.params.clientCapabilities).toEqual(
    expect.objectContaining({ subagents: {} }),
  )
  expect(asked.styles).toMatchObject({
    title: 'Styles',
    status: 'running',
    prompt: 'Find where the button colors are defined.',
    canStop: true,
  })
  expect(asked.card).toMatchObject({ subagent: ROUTES, toolKind: 'execute' })
  // Each subagent's steps are its own; none are the agent's.
  const owners = (owner: string | undefined) =>
    asked.items.filter((item) => item.kind === 'tool' && item.subagent === owner).map((i) => i.id)
  expect(owners(STYLES)).toEqual(['s1'])
  expect(owners(ROUTES)).toEqual(['r1', 'r2'])
  expect(owners(undefined)).toEqual([])

  const styles = chat.locator(`section[data-subagent="${STYLES}"]`)
  const routes = chat.locator(`section[data-subagent="${ROUTES}"]`)
  await expect(styles).toContainText('Styles · Read App.css')
  await expect(routes).toContainText('Routes · Waiting for you')
  const card = chat.getByRole('region', { name: 'Run a command?' })
  await expect(card).toContainText('Routes')
  await chatShot(session, testInfo, 'subagents-parallel')

  // Answered, Routes works on; Styles ends with its answer, folded to one line.
  await chat.evaluate(([turnId, itemId]) => window.gui.respondPermission(turnId, itemId, 'allow'), [
    asked.turn.id,
    asked.card.id,
  ] as const)
  await waitFor(async () => {
    const { styles: done, routes: working } = await firstTurn(session)
    return done?.status === 'done' && working?.status === 'running'
  }, 'Styles to finish while Routes works')
  await expect(styles).toContainText('Styles · 2 steps')
  // Its closing words were its answer: shown once, as the answer.
  const after = await firstTurn(session)
  expect(after.styles?.answer).toBe('The buttons use --accent, defined in src/index.css.')
  expect(
    after.items.filter((item) => item.kind === 'text' && item.subagent === STYLES).map((i) => i.id),
  ).toHaveLength(1)
  await expect(styles.getByRole('button', { name: /^Stop/ })).toHaveCount(0)

  // Stop Routes alone: the cancel goes to its session, and the agent's turn goes on.
  await routes.getByRole('button', { name: 'Stop Routes' }).click()
  const { turn } = await session.waitForTurn(0)
  expect(turn.status).toBe('done')
  const cancels = calls().filter((call) => call.method === 'session/cancel')
  expect(cancels.map((call) => call.params.sessionId)).toEqual([ROUTES])
  const ended = await firstTurn(session)
  expect(ended.routes).toMatchObject({ status: 'stopped' })
  expect(ended.styles).toMatchObject({ status: 'done' })
  await expect(routes).toContainText('Routes · Stopped')

  // Opened, a group shows its task, steps and answer.
  await styles.getByRole('button', { name: /^Styles/ }).click()
  await expect(
    styles.getByText('The buttons use --accent, defined in src/index.css.'),
  ).toBeVisible()
  await expect(styles.getByRole('button', { name: 'Task' })).toBeVisible()
  // Past its reveal, so the picture shows it as it rests.
  await sleep(500)
  await chatShot(session, testInfo, 'subagents-done')

  // Gui's saved transcript keeps them: archived and reopened, they're back as they ended.
  await chat.evaluate(() => window.gui.newSession())
  await expect.poll(async () => (await session.chatSnapshot()).turns.length).toBe(0)
  const [archived] = await chat.evaluate(() => window.gui.listChats())
  await chat.evaluate((id) => window.gui.openChat(id), archived.id)
  await expect.poll(async () => (await firstTurn(session)).routes?.status).toBe('stopped')
  expect((await firstTurn(session)).styles).toMatchObject({ status: 'done', title: 'Styles' })
  await expect(routes).toContainText('Routes · Stopped')
  await expect(styles).toContainText('Styles · 2 steps')
})
