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
 * to run a command; LONG writes a long answer, starts a step, and then waits for Stop. FAIL
 * fails the first time with the provider's raw overloaded error, and answers the next. EDIT
 * asks to edit package.json, with the change it would make. PLAN finishes a two-item plan.
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
let failed = false

const prompt = async ({ sessionId, prompt }) => {
  const text = prompt.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  const tool = (toolCallId, title, kind, extra = {}) =>
    notify(sessionId, { sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'in_progress', ...extra })
  const done = (toolCallId, extra = {}) =>
    notify(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', ...extra })
  const say = (words) =>
    notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: words } })
  if (text.includes('FAIL') && !failed) {
    failed = true
    throw { code: -32603, message: 'Internal error', data: { details: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_e2e"}' } }
  }
  if (text.includes('FAIL')) say('Recovered.')
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
  } else if (text.includes('PLAN')) {
    const plan = (status) => notify(sessionId, { sessionUpdate: 'plan', entries: [
      { content: 'Find the button', status: 'completed', priority: 'medium' },
      { content: 'Make it blue', status, priority: 'medium' },
    ] })
    plan('in_progress')
    await sleep(300)
    plan('completed')
    say('Planned.')
  } else if (text.includes('EDIT')) {
    const path = cwd + '/package.json'
    const toolCall = { toolCallId: 'edit-1', title: 'Edit package.json', kind: 'edit', status: 'pending',
      locations: [{ path }],
      content: [{ type: 'diff', path, oldText: '{\n  "name": "app",\n  "version": "1.0.0"\n}',
        newText: '{\n  "name": "app",\n  "version": "1.1.0",\n  "description": "<img src=x onerror=alert(1)>"\n}' }] }
    notify(sessionId, { sessionUpdate: 'tool_call', ...toolCall })
    const options = [
      { optionId: 'once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ]
    await ask('session/request_permission', { sessionId, toolCall, options })
    done('edit-1')
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
    prompt(params).then((result) => write({ id, result }), (error) => write({ id, error }))
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

  // The card asks a question, shows the command, and offers Don't allow, then Allow: last,
  // and primary. The agent's "Always allow" isn't offered (Auto mode does that job).
  const composer = chat.locator('[data-composer]')
  await chat.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  expect(await send(chat, 'ASK Run the build.')).toBe(true)
  const card = chat.getByRole('region', { name: 'Run a command?' })
  await expect(card).toBeVisible()
  // The card doesn't pull the keyboard in from wherever the user types (⌘↩ answers it from
  // anywhere); the chat's status line reads it out instead.
  await expect(chat.getByRole('status').filter({ hasText: 'Permission needed' })).toHaveText(
    'Permission needed: npm run build',
  )
  await sleep(300)
  await expect(composer).not.toBeFocused()
  await expect(card.getByText('npm run build', { exact: true })).toBeVisible()
  const buttons = card.getByRole('button')
  // Each named as it says; the card waiting longest shows the keys that answer it.
  await expect(buttons).toHaveText(['Don’t allow⌘⌫', 'Allow⌘↩'])
  for (const [i, name] of ['Don’t allow', 'Allow'].entries()) {
    await expect(buttons.nth(i)).toHaveAccessibleName(name)
  }
  await expect(buttons.last()).toHaveClass(/\bbg-accent\b/)
  // Answered from the keyboard, the keyboard moves on to the message box as the card goes.
  await buttons.last().focus()
  await chat.keyboard.press('Enter')
  await expect(composer).toBeFocused()

  // Answered, the answer goes on the step's own row: no second line for it.
  const { turn: asked } = await session.waitForTurn(1)
  const permission = asked.items.find((item) => item.kind === 'permission')
  expect(permission?.kind === 'permission' && permission.resolved).toBe('once')
  await expect(card).toHaveCount(0)
  const article = chat.getByRole('article').nth(1)
  await expect(article.getByText('Allowed', { exact: true })).toHaveCount(0)
  await article.getByRole('button', { name: /^1 step/ }).click()
  await expect(article.getByRole('list', { name: 'Steps' }).getByRole('listitem')).toHaveText([
    /^Run a command\s*npm run build\s*Allowed/,
  ])

  // A known failure reads in plain words, the agent's raw error in its details, and Retry
  // sends the same message again.
  expect(await send(chat, 'FAIL Try the build again.')).toBe(true)
  const { turn: failedTurn } = await session.waitForTurn(2)
  expect(failedTurn.status).toBe('error')
  const failure = chat.getByRole('article').nth(2)
  await expect(
    failure.getByText('The agent’s servers are busy. Try again in a minute.'),
  ).toBeVisible()
  await expect(failure.getByText(/overloaded_error/)).toHaveCount(0)
  await failure.getByRole('button', { name: 'Details' }).click()
  await expect(failure.getByText(/API Error: 529 .*overloaded_error/)).toBeVisible()
  await session.shot('turn-error-retry')
  const retry = failure.getByRole('button', { name: 'Retry' })
  await retry.focus()
  await chat.keyboard.press('Enter')
  const { turn: retried } = await session.waitForTurn(3)
  expect(retried.status).toBe('done')
  expect(retried.prompt).toBe(failedTurn.prompt)
  await expect(chat.getByText('Recovered.')).toBeVisible()
  await expect(composer).toBeFocused()
  await expect(chat.getByRole('button', { name: 'Retry' })).toHaveCount(0)

  // Asked to edit a file, the card shows the lines it would change, as text, never markup.
  expect(await send(chat, 'EDIT Bump the version.')).toBe(true)
  const edit = chat.getByRole('region', { name: 'Edit package.json?' })
  await expect(edit).toBeVisible()
  await expect(edit.getByRole('region', { name: 'Changes' }).getByRole('listitem')).toHaveText([
    /Removed\s*"version": "1\.0\.0"$/,
    /Added\s*"version": "1\.1\.0",$/,
    /Added\s*"description": "<img src=x onerror=alert\(1\)>"$/,
  ])
  await expect(edit.locator('img')).toHaveCount(0)
  await session.shot('permission-diff')
  await edit.getByRole('button', { name: 'Don’t allow' }).click()
  expect((await session.waitForTurn(4)).turn.status).toBe('done')

  // A plan with every item done folds to one line, which opens to the list.
  expect(await send(chat, 'PLAN Make the button blue.')).toBe(true)
  expect((await session.waitForTurn(5)).turn.status).toBe('done')
  const planned = chat.getByRole('article').nth(5)
  await expect(planned.getByRole('list', { name: 'Plan' })).toHaveCount(0)
  await planned.getByRole('button', { name: 'Plan · 2 of 2 done' }).click()
  await expect(planned.getByRole('list', { name: 'Plan' }).getByRole('listitem')).toHaveText([
    'Find the button',
    'Make it blue',
  ])
})

test('the transcript stays at its newest line as the queue appears; a re-logged error counts once', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  await session.waitForPreview()
  await useStandIn(session)
  const { chat } = session

  // One uncaught error in the preview. Vite may re-log it on the dev server too (it does
  // locally, not on CI); either way it counts once (problems.spec pairs the two exactly).
  const preview = await session.previewPage()
  await preview.evaluate(() => {
    setTimeout(() => {
      throw new TypeError('Gui e2e cannot read the list')
    })
  })
  const reported = async () => (await session.chatSnapshot()).meta.problems.length > 0
  await waitFor(reported, 'the error to reach the chat')
  // Time for a re-log, if Vite sends one, to arrive and pass the change throttle.
  await sleep(2000)
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

  // Stop from the keyboard leaves the keyboard in the message box, not on the page.
  await chat.getByRole('button', { name: 'Stop', exact: true }).focus()
  await chat.keyboard.press('Enter')
  const { turn } = await session.waitForTurn(0)
  expect(turn.status).toBe('cancelled')
  await expect(chat.locator('[data-composer]')).toBeFocused()
})
