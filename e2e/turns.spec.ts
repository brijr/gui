import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { electronExecutable, sleep, waitFor } from './helpers/env'
import { type GuiSession, standInsFile } from './helpers/session'
import { expect, test } from './helpers/test'

// How a turn reads in the chat: steps folded into a summary, adapter bookkeeping left out,
// permission cards as questions with their buttons in macOS order, effort levels under
// Gui's own names, the transcript pinned to its newest line as the composer's stack grows,
// and a browser error Vite re-logs counted once. A stand-in ACP agent (a small Node script)
// takes Muse Code's place through GUI_AGENT_STAND_INS, so it gets Muse's settings, including
// the rule that hides its `reminderChild` rows. No agent login or usage is needed.

/**
 * Speaks ACP (ndjson JSON-RPC) on stdio. Offers a model and an effort setting whose levels
 * are the ids Gui names itself plus one it doesn't ("turbo"). A prompt containing NOISE
 * reads a file and runs a command around a Muse `reminderChild` bookkeeping call; ASK asks
 * to run a command; LONG writes a long answer, starts a step, and then waits for Stop.
 */
const AGENT_SCRIPT = String.raw`
const { appendFileSync } = require('node:fs')
const [log] = process.argv.slice(2)
const state = { mode: 'default', nativeApprovalPolicy: 'onRequest', model: 'swift', effort: 'xhigh' }
const EFFORTS = [['minimal', 'Minimal'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'],
  ['xhigh', 'Xhigh'], ['max', 'Max'], ['turbo', 'Turbo mode']]
const select = (id, name, currentValue, options, extra = {}) =>
  ({ id, name, type: 'select', currentValue, options, ...extra })
const configOptions = () => [
  select('mode', 'Mode', state.mode,
    [{ value: 'default', name: 'On request' }, { value: 'bypassApprovals', name: 'Auto-approve' }],
    { category: 'mode' }),
  select('nativeApprovalPolicy', 'Native approval policy', state.nativeApprovalPolicy,
    ['onRequest', 'promptUnmatched'].map((value) => ({ value, name: value }))),
  select('model', 'Model', state.model,
    [{ value: 'swift', name: 'Swift' }, { value: 'sage', name: 'Sage' }], { category: 'model' }),
  select('effort', 'Effort', state.effort,
    EFFORTS.map(([value, name]) => ({ value, name })), { category: 'thought_level' }),
]
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const notify = (sessionId, update) => write({ method: 'session/update', params: { sessionId, update } })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const pending = new Map()
let lastId = 1000
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = ++lastId
    pending.set(id, resolve)
    write({ id, method, params })
  })
let cwd = ''
let stop = null

const prompt = async ({ sessionId, prompt }) => {
  const text = prompt.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  const tool = (toolCallId, title, kind, extra = {}) =>
    notify(sessionId, { sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'in_progress', ...extra })
  const done = (toolCallId, extra = {}) =>
    notify(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', ...extra })
  const say = (words) =>
    notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: words } })
  if (text.includes('NOISE')) {
    tool('reminder-1', 'reminderChild: inProgress', 'other')
    tool('read-1', 'Read src/App.tsx', 'read', { locations: [{ path: cwd + '/src/App.tsx' }] })
    await sleep(1100)
    done('read-1')
    done('reminder-1', { title: 'reminderChild: completed' })
    tool('lint-1', 'npm run lint', 'execute')
    done('lint-1')
    say('Checked.')
  } else if (text.includes('ASK')) {
    const toolCall = { toolCallId: 'build-1', title: 'npm run build', kind: 'execute', status: 'pending' }
    notify(sessionId, { sessionUpdate: 'tool_call', ...toolCall })
    const options = [
      { optionId: 'always', name: 'Always Allow', kind: 'allow_always' },
      { optionId: 'once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ]
    await ask('session/request_permission', { sessionId, toolCall, options })
    done('build-1')
    say('The build passes.')
  } else if (text.includes('LONG')) {
    const lines = Array.from({ length: 60 }, (_, i) => 'Line ' + (i + 1) + ' of the answer.')
    say(lines.join('\n\n'))
    tool('look-1', 'Read src/main.tsx', 'read', { locations: [{ path: cwd + '/src/main.tsx' }] })
    await new Promise((resolve) => { stop = resolve })
    return { stopReason: 'cancelled' }
  }
  return { stopReason: 'end_turn' }
}

const handle = (message) => {
  const { id, method, params } = message
  if (method === undefined) {
    pending.get(id)?.(message.result)
    pending.delete(id)
    return
  }
  if (method === 'session/cancel') {
    stop?.()
    for (const resolve of pending.values()) resolve({ outcome: { outcome: 'cancelled' } })
    pending.clear()
    return
  }
  if (id === undefined) return
  appendFileSync(log, JSON.stringify({ pid: process.pid, method }) + '\n')
  if (method === 'initialize') {
    return write({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
  }
  if (method === 'session/new') {
    cwd = params.cwd
    return write({ id, result: { sessionId: 'session-1', configOptions: configOptions() } })
  }
  if (method === 'session/set_config_option') {
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

/** Stands the script in for Muse Code and makes it the chat's agent. */
async function useStandIn(session: GuiSession) {
  const { base } = session.fixture
  const script = join(base, 'turns-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  const standIn = {
    command: electronExecutable(),
    args: [script, join(base, 'turns-agent.ndjson')],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
  writeFileSync(standInsFile(session.fixture), JSON.stringify({ muse: standIn }))
  // Checked again so the stand-in replaces what launch found (on CI, no `muse` installed).
  await session.chrome.evaluate(() => window.gui.checkAgents())
  const ready = async () =>
    (await session.state()).agents.some((agent) => agent.id === 'muse' && agent.status === 'ready')
  await waitFor(ready, 'the stand-in to be checked')
  await waitFor(async () => (await session.state()).project !== null, 'the project to open')
  await session.chrome.evaluate(() => window.gui.setAgent('muse'))
  const selected = async () => (await session.chatSnapshot()).meta.agentId === 'muse'
  await waitFor(selected, 'the stand-in to be the chat agent')
}

const send = (chat: Page, text: string) =>
  chat.evaluate((message) => window.gui.send(message), text)

test('a turn reads as steps, permission cards ask in macOS order, effort levels use Gui’s names', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  await useStandIn(session)
  const { chat } = session

  // Known effort ids get Gui's labels, in the model button and the picker; others pass through.
  await waitFor(async () => (await session.chatSnapshot()).meta.models, "the agent's models")
  const model = chat.getByRole('button', { name: 'Model: Swift, effort Extra high' })
  await expect(model).toHaveText('Swift · Extra high')
  await model.click()
  const picker = chat.getByRole('dialog', { name: 'Choose a model' })
  await expect(picker.getByRole('group', { name: 'Effort' }).getByRole('button')).toHaveText([
    'Minimal',
    'Low',
    'Medium',
    'High',
    'Extra high',
    'Max',
    'Turbo mode',
  ])
  await chat.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)

  // Ask, so the command below asks.
  await chat.evaluate(() => window.gui.setAutoApprove(false))
  await waitFor(async () => !(await session.chatSnapshot()).meta.autoApprove, 'Ask mode')

  // Muse's reminder bookkeeping never reaches the turn; the real steps fold into a summary
  // with how long they took, and open to human labels with the raw command beside them.
  expect(await send(chat, 'NOISE Check the button.')).toBe(true)
  const { turn: checked } = await session.waitForTurn(0)
  expect(checked.status).toBe('done')
  const tools = checked.items.flatMap((item) => (item.kind === 'tool' ? [item.title] : []))
  expect(tools).toEqual(['Read src/App.tsx', 'npm run lint'])
  const summary = chat.getByRole('button', { name: /^2 steps\s*·\s*\ds$/ })
  await expect(summary).toBeVisible()
  await summary.click()
  await expect(chat.getByRole('list', { name: 'Steps' }).getByRole('listitem')).toHaveText([
    /^Read App\.tsx\s*src\/App\.tsx/,
    /^Run a command\s*npm run lint/,
  ])
  await expect(chat.getByText(/reminderChild/)).toHaveCount(0)

  // The card asks a question, shows the command, and offers the agent's options right to
  // left from the default: Allow last, and primary.
  expect(await send(chat, 'ASK Run the build.')).toBe(true)
  const card = chat.getByRole('region', { name: 'Run a command?' })
  await expect(card).toBeVisible()
  await expect(card.getByText('npm run build', { exact: true })).toBeVisible()
  const buttons = card.getByRole('button')
  await expect(buttons).toHaveText(["Don't allow", 'Always allow', 'Allow'])
  await expect(buttons.last()).toHaveClass(/\bbg-accent\b/)
  await buttons.last().click()

  // Answered, it's one quiet line: the outcome and what it was about.
  const { turn: asked } = await session.waitForTurn(1)
  const permission = asked.items.find((item) => item.kind === 'permission')
  expect(permission?.kind === 'permission' && permission.resolved).toBe('once')
  await expect(card).toHaveCount(0)
  const outcome = chat.getByRole('article').nth(1).getByText('Allowed', { exact: true })
  await expect(outcome).toBeVisible()
})

test('the transcript stays at its newest line as the queue appears; a re-logged error counts once', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  await session.waitForPreview()
  await useStandIn(session)
  const { chat } = session

  // One uncaught error in the preview, which Vite also re-logs on the dev server.
  const preview = await session.previewPage()
  await preview.evaluate(() => {
    setTimeout(() => {
      throw new TypeError('Gui e2e cannot read the list')
    })
  })
  const relogged = async () =>
    (await session.chrome.evaluate(() => window.gui.getLogs())).includes('[Unhandled error]')
  await waitFor(relogged, 'Vite to re-log the error on the dev server', { timeout: 20_000 })
  // Problems reach the chat after a short throttle.
  await sleep(1000)
  const { meta } = await session.chatSnapshot()
  expect(meta.problems.map((problem) => problem.source)).toEqual(['console'])
  await expect(chat.getByText('1 error in the preview', { exact: true })).toBeVisible()

  // A long answer, then the agent goes quiet: nothing more arrives to scroll the transcript.
  expect(await send(chat, 'LONG Walk me through it.')).toBe(true)
  const transcript = chat.locator('[data-transcript]')
  const atBottom = () =>
    transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 2)
  await waitFor(
    () => transcript.evaluate((el) => el.scrollHeight > el.clientHeight + 200),
    'the answer to overflow the transcript',
  )
  await waitFor(atBottom, 'the transcript to follow the answer')

  // Queued messages take room above the composer; the newest line stays in view.
  expect(await send(chat, 'First queued message')).toBe(true)
  expect(await send(chat, 'Second queued message')).toBe(true)
  const queued = chat.getByRole('list', { name: 'Queued messages' }).getByRole('listitem')
  await expect(queued).toHaveCount(2)
  await expect.poll(atBottom, { timeout: 2000 }).toBe(true)

  await chat.evaluate(() => window.gui.cancel())
  const { turn } = await session.waitForTurn(0)
  expect(turn.status).toBe('cancelled')
})
