import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator } from '@playwright/test'
import { type AgentId, CUSTOM_AGENT_PREFIX, type ModelSettings } from '../src/shared/types'
import { electronExecutable, waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// The composer's model button and its picker, against a stand-in ACP agent: a small Node
// script that offers a model and an effort setting (under its own ids, found by category)
// and records every request, so no agent login or usage is needed.

const AGENT: AgentId = `${CUSTOM_AGENT_PREFIX}Models`

/**
 * Speaks ACP (ndjson JSON-RPC) on stdio. The model list is long and grouped by provider,
 * like OpenCode's ("short": three models, ungrouped); effort is flat, and refuses "max".
 * A `mode` setting stands in for the categories Gui ignores.
 */
const AGENT_SCRIPT = String.raw`
const { appendFileSync } = require('node:fs')
const [log, size] = process.argv.slice(2)
const state = { llm: 'swift', depth: 'medium' }
const PROVIDERS = {
  Anthropic: ['Claude Opus 4.1', 'Claude Opus 4', 'Claude Sonnet 4.5', 'Claude Sonnet 4',
    'Claude Haiku 4.5', 'Claude 3.7 Sonnet', 'Claude 3.5 Haiku'],
  OpenAI: ['GPT-5', 'GPT-5 Mini', 'GPT-5 Nano', 'GPT-4.1', 'GPT-4.1 Mini', 'GPT-4o', 'o3', 'o4-mini'],
  Google: ['Gemini 2.5 Pro', 'Gemini 2.5 Flash', 'Gemini 2.5 Flash Lite', 'Gemini 2.0 Flash',
    'Gemma 3 27B', 'Gemma 3 12B'],
  Mistral: ['Mistral Large', 'Mistral Medium 3', 'Codestral', 'Devstral Medium', 'Devstral Small'],
  xAI: ['Grok 4', 'Grok 3', 'Grok 3 Mini', 'Grok Code Fast 1'],
  DeepSeek: ['DeepSeek V3.1', 'DeepSeek R1', 'DeepSeek V3'],
  Qwen: ['Qwen3 Coder', 'Qwen3 Max', 'Qwen3 235B', 'Qwen3 32B'],
  'Moonshot AI': ['Kimi K2', 'Kimi K2 Turbo'],
}
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9.]+/g, '-')
const models = () => size === 'short'
  ? ['Swift', 'Sage', 'Atlas'].map((name) => ({ value: slug(name), name }))
  : [
      { group: 'fast', name: 'Fast', options: [{ value: 'swift', name: 'Swift' }] },
      { group: 'smart', name: 'Smart', options: [{ value: 'sage', name: 'Acme/Sage' }] },
      ...Object.entries(PROVIDERS).map(([provider, names]) => ({
        group: slug(provider),
        name: provider,
        options: names.map((name) => ({ value: slug(provider) + '/' + slug(name), name: provider + '/' + name })),
      })),
    ]
const configOptions = () => [
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'ask',
    options: [{ value: 'ask', name: 'Ask' }] },
  { id: 'llm', name: 'Model', category: 'model', type: 'select', currentValue: state.llm,
    options: models() },
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
 * Adds the stand-in agent to agents.json (run on Electron's own Node), opens the project
 * with it as the chat's agent, and waits for its models. Its health check starts a
 * session too, outside the project.
 */
async function addAgent(session: GuiSession, size: 'long' | 'short' = 'long'): Promise<ChatRuns> {
  const { base, userData, root } = session.fixture
  const log = join(base, 'agent-calls.ndjson')
  const script = join(base, 'models-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  const agents = {
    Models: {
      command: electronExecutable(),
      args: [script, log, size],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
  }
  writeFileSync(join(userData, 'agents.json'), JSON.stringify(agents))
  await session.chrome.evaluate(() => window.gui.checkAgents())
  const listed = async () => (await session.state()).agents.some((agent) => agent.id === AGENT)
  await waitFor(listed, 'the agent to be listed')
  await waitFor(async () => (await session.state()).project !== null, 'the project to open')
  await session.chrome.evaluate((id) => window.gui.setAgent(id), AGENT)
  await waitFor(async () => (await models(session))?.model.id === 'llm', "the agent's models")
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

/** The picker's parts, by role. */
function pickerOf(session: GuiSession) {
  const dialog = session.chat.getByRole('dialog', { name: 'Choose a model' })
  return {
    dialog,
    search: dialog.getByRole('combobox', { name: 'Search models' }),
    list: dialog.getByRole('listbox', { name: 'Models' }),
    options: dialog.getByRole('option'),
    effort: dialog.getByRole('group', { name: 'Effort' }),
  }
}

/** The highlighted option, as the combobox (or list) points at it. */
async function expectActive(owner: Locator, option: Locator) {
  const id = await option.getAttribute('id')
  expect(id).toBeTruthy()
  await expect(owner).toHaveAttribute('aria-activedescendant', id ?? '')
}

/**
 * Just above the button and inside the chat panel, against the button's right edge unless
 * that would cross the panel's left edge.
 */
async function expectPlaced(session: GuiSession, dialog: Locator, button: Locator) {
  const panel = await session.chat.locator('[data-chat-panel]').boundingBox()
  const box = await dialog.boundingBox()
  const anchor = await button.boundingBox()
  if (!panel || !box || !anchor) throw new Error('The picker, its button or the panel has no box')
  expect(box.x).toBeGreaterThanOrEqual(panel.x)
  expect(box.y).toBeGreaterThanOrEqual(panel.y)
  expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width)
  expect(box.y + box.height).toBeLessThanOrEqual(anchor.y)
  expect(anchor.y - (box.y + box.height)).toBeLessThanOrEqual(8)
  const right = anchor.x + anchor.width
  if (right - box.width >= panel.x + 8) expect(Math.abs(box.x + box.width - right)).toBeLessThan(1)
  else expect(Math.abs(box.x - (panel.x + 8))).toBeLessThan(1)
  return { panel, box }
}

test('the model picker searches the models, sets the model and effort, and new sessions start with them', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  const runs = await addAgent(session)
  const { chat } = session

  // Before any chat session: the agent's list from its health check, groups flattened.
  // Settings are found by category, whatever the agent calls them; `mode` isn't one.
  const listed = await modelsAre(session, 'swift', 'medium')
  expect(listed.model.options).toHaveLength(41)
  expect(listed.model.options.slice(0, 3)).toEqual([
    { value: 'swift', name: 'Swift', group: 'Fast' },
    { value: 'sage', name: 'Acme/Sage', group: 'Smart' },
    { value: 'anthropic/claude-opus-4.1', name: 'Anthropic/Claude Opus 4.1', group: 'Anthropic' },
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

  // The button opens the picker over the chat, next to itself: search field focused, the
  // models under their provider, the current one marked.
  const button = chat.getByRole('button', { name: 'Model: Swift, effort Medium' })
  await expect(button).toHaveAttribute('aria-haspopup', 'dialog')
  await expect(button).toHaveAttribute('aria-expanded', 'false')
  await button.click()
  const { dialog, search, list, options, effort } = pickerOf(session)
  await expect(dialog).toBeVisible()
  await expect(button).toHaveAttribute('aria-expanded', 'true')
  await expect(search).toBeFocused()
  await expect(search).toHaveAttribute('aria-controls', (await list.getAttribute('id')) ?? '')
  await expect(options).toHaveCount(41)
  await expect(list.getByRole('option', { selected: true })).toHaveText('Swift')
  await expectActive(search, list.getByRole('option', { name: 'Swift' }))
  // "Anthropic/Claude Opus 4" reads as "Claude Opus 4" under its provider's header.
  const anthropic = list.getByRole('group', { name: 'Anthropic' })
  await expect(anthropic.getByRole('option')).toHaveCount(7)
  await expect(anthropic.getByRole('option').first()).toHaveText('Claude Opus 4.1')
  await expectPlaced(session, dialog, button)

  // Every typed word matches somewhere in the name, value or provider, in any case.
  await chat.keyboard.type('SON 4')
  await expect(options).toHaveText(['Claude Sonnet 4.5', 'Claude Sonnet 4'])
  await search.fill('qwen coder')
  await expect(options).toHaveText(['Qwen3 Coder'])
  await search.fill('nothing like this')
  await expect(options).toHaveCount(0)
  await expect(dialog.getByText('No models match')).toBeVisible()
  await session.shot('model-picker-empty')

  // ↑/↓ move the highlight from the first match and stop at the ends; so does hovering.
  await search.fill('gpt 5')
  await expect(options).toHaveText(['GPT-5', 'GPT-5 Mini', 'GPT-5 Nano'])
  await expectActive(search, options.nth(0))
  await search.press('ArrowDown')
  await search.press('ArrowDown')
  await search.press('ArrowDown')
  await expectActive(search, options.nth(2))
  await search.press('ArrowUp')
  await expectActive(search, options.nth(1))
  await options.nth(0).hover()
  await expectActive(search, options.nth(0))
  await session.shot('model-picker-search')

  // Enter picks the highlighted model: it applies now (between turns), the picker closes
  // and focus goes back to the button.
  await search.fill('acme sage')
  await expect(options).toHaveText(['Acme/Sage'])
  await search.press('Enter')
  await expect(dialog).toBeHidden()
  await modelsAre(session, 'sage', 'medium')
  await waitFor(() => configCalls(runs()[0]).length === 1, 'the model change')
  expect(configCalls(runs()[0])).toEqual([{ configId: 'llm', value: 'sage' }])
  // "Provider/Model" names show the model; the picker has the full name.
  const sage = chat.getByRole('button', { name: 'Model: Sage, effort Medium' })
  await expect(sage).toBeFocused()
  await session.shot('model-button')

  // Effort is a segmented control in the picker; it applies now and the picker stays.
  await sage.click()
  await expect(effort.getByRole('button', { name: 'Medium' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await effort.getByRole('button', { name: 'High' }).click()
  await modelsAre(session, 'sage', 'high')
  await waitFor(() => configCalls(runs()[0]).length === 2, 'the effort change')
  expect(configCalls(runs()[0])[1]).toEqual({ configId: 'depth', value: 'high' })
  await expect(dialog).toBeVisible()
  await expect(effort.getByRole('button', { name: 'High' })).toHaveAttribute('aria-pressed', 'true')

  // Typing while an effort level has focus goes to the search field; Esc closes the picker
  // and returns focus to the button.
  await expect(effort.getByRole('button', { name: 'High' })).toBeFocused()
  await chat.keyboard.type('gem')
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('gem')
  await chat.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  const sageHigh = chat.getByRole('button', { name: 'Model: Sage, effort High' })
  await expect(sageHigh).toBeFocused()
  await expect(sageHigh).toHaveAttribute('aria-expanded', 'false')

  // From the keyboard it opens fresh; a click elsewhere in the chat closes it, picking nothing.
  await chat.keyboard.press('Enter')
  await expect(search).toBeFocused()
  await expect(search).toHaveValue('')
  const message = chat.getByRole('textbox', { name: /^Message / })
  await message.click({ position: { x: 12, y: 12 } })
  await expect(dialog).toBeHidden()
  await expect(message).toBeFocused()
  expect(configCalls(runs()[0])).toHaveLength(2)

  // At the panel's smallest it still fits inside the panel and scrolls its list.
  const panel = chat.locator('[data-chat-panel]')
  await chat.evaluate(() => {
    window.gui.resizeChat('bottom-left', 10_000, -10_000)
    window.gui.endResizeChat()
  })
  await waitFor(async () => {
    const box = await panel.boundingBox()
    return box && box.width <= 320 && box.height <= 360
  }, 'the smallest panel')
  await sageHigh.click()
  const small = await expectPlaced(session, dialog, sageHigh)
  expect(small.box.height).toBeGreaterThan(200)
  const listBox = await list.boundingBox()
  expect(listBox?.height).toBeGreaterThan(100)
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  await chat.keyboard.type('grok')
  await expect(options).toHaveCount(4)
  await session.shot('model-picker-small')
  await chat.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // Remembered per agent, under the agent's own ids.
  const prefsFile = join(session.fixture.userData, 'prefs.json')
  const prefs = JSON.parse(readFileSync(prefsFile, 'utf8')) as {
    agentSettings?: Record<string, unknown>
  }
  expect(prefs.agentSettings?.[AGENT]).toEqual({ llm: 'sage', depth: 'high' })

  // A new chat starts a new session at the agent's defaults; the choices go in before the
  // first prompt, the model before the effort.
  await chat.evaluate(() => window.gui.newSession())
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
  await sageHigh.click()
  await effort.getByRole('button', { name: 'Max' }).click()
  await modelsAre(session, 'sage', 'max')
  await chat.keyboard.press('Escape')
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

  // Main takes only a choice the agent offers; a click on a row picks it.
  await chat.evaluate(() => window.gui.setAgentSetting('llm', 'not-a-model'))
  await chat.evaluate(() => window.gui.setAgentSetting('mode', 'ask'))
  await sageHigh.click()
  await options.filter({ hasText: 'GPT-5 Nano' }).click()
  await expect(dialog).toBeHidden()
  await modelsAre(session, 'openai/gpt-5-nano', 'high')
  const nano = { configId: 'llm', value: 'openai/gpt-5-nano' }
  await waitFor(() => configCalls(runs()[1]).at(-1)?.value === nano.value, 'the model change')
  const calls = configCalls(runs()[1])
  expect(calls.at(-1)).toEqual(nano)
  expect(calls.filter((call) => call.value === 'not-a-model' || call.configId === 'mode')).toEqual(
    [],
  )
})

test('a short model list has no search field and is driven from the list', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  await addAgent(session, 'short')
  await modelsAre(session, 'swift', 'medium')

  const button = session.chat.getByRole('button', { name: 'Model: Swift, effort Medium' })
  await button.click()
  const { dialog, search, list, options } = pickerOf(session)
  await expect(dialog).toBeVisible()
  await expect(search).toHaveCount(0)
  await expect(list).toBeFocused()
  await expect(options).toHaveText(['Swift', 'Sage', 'Atlas'])
  await expect(list.getByRole('group')).toHaveCount(0)
  await expectPlaced(session, dialog, button)
  await session.shot('model-picker-short')

  await session.chat.keyboard.press('ArrowDown')
  await expectActive(list, options.nth(1))
  await session.chat.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await modelsAre(session, 'sage', 'medium')
  await expect(
    session.chat.getByRole('button', { name: 'Model: Sage, effort Medium' }),
  ).toBeFocused()
})
