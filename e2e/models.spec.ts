import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AgentId, CUSTOM_AGENT_PREFIX, type ModelSettings } from '../src/shared/types'
import { electronExecutable, waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// The composer's model button and its native menu, against a stand-in ACP agent: a small
// Node script that offers a model and an effort setting (under its own ids, found by
// category) and records every request, so no agent login or usage is needed.

const AGENT: AgentId = `${CUSTOM_AGENT_PREFIX}Models`

/** What Playwright passes to `app.evaluate` callbacks. */
type ElectronModule = typeof import('electron/main')

/**
 * Speaks ACP (ndjson JSON-RPC) on stdio. The model list is grouped by provider; effort is
 * flat, and refuses "max". A `mode` setting stands in for the categories Gui ignores.
 */
const AGENT_SCRIPT = String.raw`
const { appendFileSync } = require('node:fs')
const log = process.argv[2]
const state = { llm: 'swift', depth: 'medium' }
const configOptions = () => [
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'ask',
    options: [{ value: 'ask', name: 'Ask' }] },
  { id: 'llm', name: 'Model', category: 'model', type: 'select', currentValue: state.llm,
    options: [
      { group: 'fast', name: 'Fast', options: [{ value: 'swift', name: 'Swift' }] },
      { group: 'smart', name: 'Smart', options: [{ value: 'sage', name: 'Acme/Sage' }] },
    ] },
  { id: 'depth', name: 'Thinking', category: 'thought_level', type: 'select',
    currentValue: state.depth,
    options: ['Low', 'Medium', 'High', 'Max'].map((name) => ({ value: name.toLowerCase(), name })) },
]
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const handle = ({ id, method, params }) => {
  if (id === undefined) return
  appendFileSync(log, JSON.stringify({ pid: process.pid, method, params }) + '\n')
  if (method === 'initialize') {
    return write({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
  }
  if (method === 'session/new') {
    return write({ id, result: { sessionId: 'session-' + process.pid, configOptions: configOptions() } })
  }
  if (method === 'session/set_config_option') {
    if (params.value === 'max') return write({ id, error: { code: -32602, message: 'Max is not on this plan' } })
    state[params.configId] = params.value
    return write({ id, result: { configOptions: configOptions() } })
  }
  if (method === 'session/prompt') return write({ id, result: { stopReason: 'end_turn' } })
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
  pid: number
  method: string
  params: Record<string, unknown>
}

/** The requests each chat session's agent received, one entry per process, oldest first. */
type ChatRuns = () => Call[][]

/**
 * Adds the stand-in agent to agents.json (run on Electron's own Node) and waits for Gui to
 * list it. Its health check starts a session too, outside the project.
 */
async function addAgent(session: GuiSession): Promise<ChatRuns> {
  const { base, userData, root } = session.fixture
  const log = join(base, 'agent-calls.ndjson')
  const script = join(base, 'models-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  const agents = {
    Models: {
      command: electronExecutable(),
      args: [script, log],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
  }
  writeFileSync(join(userData, 'agents.json'), JSON.stringify(agents))
  await session.chrome.evaluate(() => window.gui.checkAgents())
  const listed = async () => (await session.state()).agents.some((agent) => agent.id === AGENT)
  await waitFor(listed, 'the agent to be listed')
  return () => {
    if (!existsSync(log)) return []
    const calls = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Call)
    const pids = calls
      .filter((call) => call.method === 'session/new' && call.params.cwd === root)
      .map((call) => call.pid)
    return pids.map((pid) => calls.filter((call) => call.pid === pid))
  }
}

interface MenuStore {
  /** Label of the menu item to choose next, searched through submenus */
  guiMenuChoice?: string | null
  guiMenuStubbed?: boolean
  /** Where each answered menu would have popped up, in window coordinates */
  guiMenuPopups?: { x: number | undefined; y: number | undefined }[]
}

/**
 * Runs in main: answers the next native menu that has `label` (in it or a submenu) by
 * clicking that item, instead of showing it. Like Electron, the click runs before the close
 * callback. The menu is built from the real template; only `popup` is replaced.
 */
function answerMenu({ Menu }: ElectronModule, label: string) {
  const store = globalThis as unknown as MenuStore
  store.guiMenuChoice = label
  store.guiMenuPopups ??= []
  if (store.guiMenuStubbed) return
  store.guiMenuStubbed = true
  const build = Menu.buildFromTemplate.bind(Menu)
  Menu.buildFromTemplate = (template) => {
    const menu = build(template)
    type Item = (typeof menu.items)[number]
    const find = (items: Item[], choice: string): Item | undefined => {
      for (const item of items) {
        if (item.label === choice && item.enabled) return item
        const inner = item.submenu && find(item.submenu.items, choice)
        if (inner) return inner
      }
      return undefined
    }
    const choice = store.guiMenuChoice
    if (!choice || !find(menu.items, choice)) return menu
    menu.popup = (options) => {
      store.guiMenuPopups?.push({ x: options?.x, y: options?.y })
      store.guiMenuChoice = null
      find(menu.items, choice)?.click()
      options?.callback?.()
    }
    return menu
  }
}

/** Runs in main: the chat view's position in the window. */
function chatViewOrigin({ BrowserWindow, WebContentsView }: ElectronModule) {
  const win = BrowserWindow.getAllWindows()[0]
  const view = win?.contentView.children.find(
    (child): child is InstanceType<typeof WebContentsView> =>
      child instanceof WebContentsView && child.webContents.getURL().endsWith('/chat.html'),
  )
  const bounds = view?.getBounds()
  return bounds ? { x: bounds.x, y: bounds.y } : null
}

function chooseFromMenu(session: GuiSession, label: string) {
  return session.app.evaluate(answerMenu, label)
}

async function models(session: GuiSession): Promise<ModelSettings | null> {
  return (await session.chatSnapshot()).meta.models
}

/** Waits for the chat's model and effort values to be these. */
function modelsAre(session: GuiSession, model: string, effort: string) {
  return waitFor(async () => {
    const current = await models(session)
    return current?.model.value === model && current.effort?.value === effort ? current : null
  }, `model ${model} and effort ${effort}`)
}

const configCalls = (calls: Call[] | undefined) =>
  (calls ?? [])
    .filter((call) => call.method === 'session/set_config_option')
    .map(({ params }) => ({ configId: params.configId, value: params.value }))

const send = (session: GuiSession, text: string) =>
  session.chat.evaluate((message) => window.gui.send(message), text)

test('the composer picks the model and effort, and new sessions start with them', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  const runs = await addAgent(session)
  await waitFor(async () => (await session.state()).project !== null, 'the project to open')
  await session.chrome.evaluate((id) => window.gui.setAgent(id), AGENT)
  await waitFor(async () => (await models(session))?.model.id === 'llm', "the agent's models")

  // Before any chat session: the agent's list from its health check, groups flattened.
  // Settings are found by category, whatever the agent calls them; `mode` isn't one.
  const listed = await modelsAre(session, 'swift', 'medium')
  expect(listed.model.options).toEqual([
    { value: 'swift', name: 'Swift', group: 'Fast' },
    { value: 'sage', name: 'Acme/Sage', group: 'Smart' },
  ])
  expect(listed.effort?.id).toBe('depth')
  expect(listed.effort?.options.map((option) => option.name)).toEqual([
    'Low',
    'Medium',
    'High',
    'Max',
  ])
  const health = (await session.state()).agents.find((agent) => agent.id === AGENT)
  expect(health?.models).toEqual(listed)

  // After a turn the session's own settings show; nothing was chosen, so nothing was set.
  expect(await send(session, 'Hello')).toBe(true)
  const first = await session.waitForTurn(0)
  expect(first.turn.status).toBe('done')
  expect(first.meta.models).toEqual(listed)
  expect(runs()).toHaveLength(1)
  expect(configCalls(runs()[0])).toEqual([])

  // The composer's button opens the menu under itself; between turns the change applies now.
  const button = session.chat.getByRole('button', { name: 'Model: Swift, effort Medium' })
  await expect(button).toBeVisible()
  await chooseFromMenu(session, 'Acme/Sage')
  await button.click()
  await modelsAre(session, 'sage', 'medium')
  await waitFor(() => configCalls(runs()[0]).length === 1, 'the model change')
  expect(configCalls(runs()[0])).toEqual([{ configId: 'llm', value: 'sage' }])
  // "Provider/Model" names show the model; the menu has the full name.
  await expect(
    session.chat.getByRole('button', { name: 'Model: Sage, effort Medium' }),
  ).toBeVisible()
  await session.shot('model-button')
  const box = await session.chat.getByRole('button', { name: /^Model: / }).boundingBox()
  const origin = await session.app.evaluate(chatViewOrigin)
  const popups = await session.app.evaluate(
    () => (globalThis as unknown as MenuStore).guiMenuPopups ?? [],
  )
  expect(box && origin).toBeTruthy()
  expect(Math.abs((popups[0]?.x ?? 0) - ((origin?.x ?? 0) + (box?.x ?? 0)))).toBeLessThanOrEqual(1)
  expect(
    Math.abs((popups[0]?.y ?? 0) - ((origin?.y ?? 0) + (box?.y ?? 0) + (box?.height ?? 0))),
  ).toBeLessThanOrEqual(1)

  // The effort levels are in a submenu.
  await chooseFromMenu(session, 'High')
  await session.chat.evaluate(() => window.gui.showModelMenu(0, 0))
  await modelsAre(session, 'sage', 'high')
  await waitFor(() => configCalls(runs()[0]).length === 2, 'the effort change')
  expect(configCalls(runs()[0])[1]).toEqual({ configId: 'depth', value: 'high' })

  // Remembered per agent, under the agent's own ids.
  const prefsFile = join(session.fixture.userData, 'prefs.json')
  const prefs = JSON.parse(readFileSync(prefsFile, 'utf8')) as {
    agentSettings?: Record<string, unknown>
  }
  expect(prefs.agentSettings?.[AGENT]).toEqual({ llm: 'sage', depth: 'high' })

  // A new chat starts a new session at the agent's defaults; the choices go in before the
  // first prompt, the model before the effort.
  await session.chat.evaluate(() => window.gui.newSession())
  await waitFor(async () => (await session.chatSnapshot()).turns.length === 0, 'the new chat')
  await modelsAre(session, 'sage', 'high')
  expect(await send(session, 'Hello again')).toBe(true)
  const second = await session.waitForTurn(0)
  expect(second.turn.status).toBe('done')
  expect(runs()).toHaveLength(2)
  const methods = (runs()[1] ?? []).map((call) => call.method)
  expect(methods.slice(methods.indexOf('session/new'))).toEqual([
    'session/new',
    'session/set_config_option',
    'session/set_config_option',
    'session/prompt',
  ])
  expect(configCalls(runs()[1])).toEqual([
    { configId: 'llm', value: 'sage' },
    { configId: 'depth', value: 'high' },
  ])
  expect(second.meta.models?.model.value).toBe('sage')
  expect(second.meta.models?.effort?.value).toBe('high')

  // A refused choice doesn't fail the turn: it says so quietly and runs on the agent's own.
  await chooseFromMenu(session, 'Max')
  await session.chat.evaluate(() => window.gui.showModelMenu(0, 0))
  await modelsAre(session, 'sage', 'max')
  expect(await send(session, 'Think harder')).toBe(true)
  const third = await session.waitForTurn(1)
  expect(third.turn.status).toBe('done')
  expect(third.turn.items).toContainEqual(
    expect.objectContaining({
      kind: 'notice',
      tone: 'info',
      text: "Couldn't switch the effort to Max, so this turn uses High.",
    }),
  )
  expect(third.meta.models?.effort?.value).toBe('high')
  expect((runs()[1] ?? []).filter((call) => call.method === 'session/prompt')).toHaveLength(2)
})
