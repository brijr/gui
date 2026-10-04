import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { electronExecutable, sleep, waitFor } from './helpers/env'
import { type GuiSession, standInsFile } from './helpers/session'
import { expect, test } from './helpers/test'

// The chat moves between states with view transitions (src/renderer/src/chat/transitions.ts):
// a sent message rises from the composer into the transcript or the queue, a queued message
// moves into the transcript when its turn starts, an answered permission card collapses into
// its line. New rows fade up once, while the user watches. A stand-in ACP agent (a small Node
// script, in Muse Code's place) makes the turns; no agent login or usage is needed.

/**
 * Speaks ACP on stdio. A prompt with WORK keeps working until Stop; BRIEF works for a moment
 * and ends; ASK asks to run a command; anything else takes a step and answers.
 */
const AGENT_SCRIPT = String.raw`
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const notify = (sessionId, update) => write({ method: 'session/update', params: { sessionId, update } })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const pending = new Map()
let lastId = 1000
let stop = null
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = ++lastId
    pending.set(id, resolve)
    write({ id, method, params })
  })

const prompt = async ({ sessionId, prompt }) => {
  const text = prompt.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  const tool = (toolCallId, title, kind) =>
    notify(sessionId, { sessionUpdate: 'tool_call', toolCallId, title, kind, status: 'in_progress' })
  const done = (toolCallId) =>
    notify(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' })
  const say = (words) =>
    notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: words } })
  if (text.includes('WORK')) {
    tool('work-' + Date.now(), 'npm run build', 'execute')
    await new Promise((resolve) => { stop = resolve })
    return { stopReason: 'cancelled' }
  }
  if (text.includes('BRIEF')) {
    await sleep(1500)
    say('Done.')
    return { stopReason: 'end_turn' }
  }
  if (text.includes('ASK')) {
    const toolCall = { toolCallId: 'build-1', title: 'npm run build', kind: 'execute', status: 'pending' }
    notify(sessionId, { sessionUpdate: 'tool_call', ...toolCall })
    const options = [
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      { optionId: 'once', name: 'Allow', kind: 'allow_once' },
    ]
    await ask('session/request_permission', { sessionId, toolCall, options })
    done('build-1')
    say('Built.')
    return { stopReason: 'end_turn' }
  }
  await sleep(400)
  tool('read-' + Date.now(), 'Read src/App.tsx', 'read')
  await sleep(400)
  say('Looked.')
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
    stop = null
    for (const resolve of pending.values()) resolve({ outcome: { outcome: 'cancelled' } })
    pending.clear()
    return
  }
  if (id === undefined) return
  if (method === 'initialize') {
    return write({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
  }
  if (method === 'session/new') return write({ id, result: { sessionId: 'session-1' } })
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

/** Stands the script in for Muse Code and makes it the chat's agent, in Ask mode. */
async function useStandIn(session: GuiSession) {
  const script = join(session.fixture.base, 'motion-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  const standIn = {
    command: electronExecutable(),
    args: [script],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
  writeFileSync(standInsFile(session.fixture), JSON.stringify({ muse: standIn }))
  await session.chrome.evaluate(() => window.gui.checkAgents())
  const ready = async () =>
    (await session.state()).agents.some((agent) => agent.id === 'muse' && agent.status === 'ready')
  await waitFor(ready, 'the stand-in to be checked')
  await waitFor(async () => (await session.state()).project !== null, 'the project to open')
  await session.chrome.evaluate(() => window.gui.setAgent('muse'))
  const selected = async () => (await session.chatSnapshot()).meta.agentId === 'muse'
  await waitFor(selected, 'the stand-in to be the chat agent')
  await session.chat.evaluate(() => window.gui.setAutoApprove(false))
  await waitFor(async () => !(await session.chatSnapshot()).meta.autoApprove, 'Ask mode')
}

/** A view transition the chat started: which elements were named before and after it. */
interface Recorded {
  before: string[]
  after: string[]
  ran: boolean | null
}

interface RecorderStore {
  guiTransitions?: Recorded[]
}

/** Runs in the chat page: records every view transition and what moved in it. */
function recordTransitions() {
  const store = globalThis as unknown as RecorderStore
  const log: Recorded[] = []
  store.guiTransitions = log
  const describe = (el: HTMLElement) => {
    const role = ['composer', 'userMessage', 'queueItem', 'permission'].find(
      (key) => key in el.dataset,
    )
    return `${el.style.viewTransitionName}:${role ?? el.tagName.toLowerCase()}`
  }
  const named = () =>
    [...document.querySelectorAll<HTMLElement>('*')]
      .filter((el) => el.style.viewTransitionName)
      .map(describe)
  const start = document.startViewTransition.bind(document)
  document.startViewTransition = ((update: () => void) => {
    const entry: Recorded = { before: named(), after: [], ran: null }
    log.push(entry)
    const transition = start(() => {
      update()
      entry.after = named()
    })
    transition.ready.then(
      () => {
        entry.ran = true
      },
      () => {
        entry.ran = false
      },
    )
    return transition
  }) as typeof document.startViewTransition
}

const transitions = (chat: Page) =>
  chat.evaluate(() => (globalThis as unknown as RecorderStore).guiTransitions ?? [])

/** Types `text` in the composer and presses Return, as the user sends. */
async function type(chat: Page, text: string) {
  const box = chat.getByRole('textbox', { name: /^Message / })
  await box.fill(text)
  await box.press('Enter')
}

test('a sent message rises from the composer, and a queued one moves into its turn', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  await useStandIn(session)
  const { chat } = session
  await session.waitForPreview()
  await chat.evaluate(recordTransitions)

  // Sent: the composer's text becomes the turn's message.
  await type(chat, 'BRIEF Tighten the heading.')
  await expect(chat.getByText('Tighten the heading.', { exact: false })).toBeVisible()
  await waitFor(async () => (await transitions(chat)).length > 0, 'the send transition')
  const [sent] = await transitions(chat)
  expect(sent?.before).toEqual(['chat-message:composer'])
  expect(sent?.after).toEqual(['chat-message:userMessage'])
  await expect(chat.getByRole('textbox', { name: /^Message / })).toHaveValue('')

  // Sent while it works: into the queue. (Once the first move is over: one that comes while
  // another runs simply applies.)
  await sleep(600)
  await type(chat, 'Then the button.')
  const queued = chat.getByRole('list', { name: 'Queued messages' }).getByRole('listitem')
  await expect(queued).toHaveCount(1)
  await waitFor(async () => (await transitions(chat)).length > 1, 'the queue transition')
  const toQueue = (await transitions(chat))[1]
  expect(toQueue?.before).toEqual([expect.stringMatching(/^queue-.+:composer$/)])
  expect(toQueue?.after).toEqual([expect.stringMatching(/^queue-.+:queueItem$/)])

  // The first turn ends and the queued message starts: it moves out of the queue into it.
  await session.waitForTurn(0, 30_000)
  await waitFor(async () => (await session.chatSnapshot()).turns.length === 2, 'the queued turn')
  await waitFor(async () => (await transitions(chat)).length > 2, 'the move into the transcript')
  const started = (await transitions(chat))[2]
  expect(started?.before).toEqual(['chat-message:queueItem'])
  expect(started?.after).toEqual(['chat-message:userMessage'])
  await expect(queued).toHaveCount(0)
  // Each one ran, rather than being skipped.
  await waitFor(
    async () => (await transitions(chat)).every((entry) => entry.ran !== null),
    'the transitions to start',
  )
  for (const entry of await transitions(chat)) expect(entry.ran).toBe(true)
  await session.waitForTurn(1, 30_000)
})

test('an answered permission card collapses into its line; new rows fade up once', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  await useStandIn(session)
  const { chat } = session
  await session.waitForPreview()

  // A step arriving live fades up; the message that rose doesn't fade as well.
  await type(chat, 'Look at the header.')
  const { turn } = await session.waitForTurn(0, 30_000)
  expect(turn.status).toBe('done')
  const fading = await chat.evaluate(() =>
    [...document.querySelectorAll('.animate-row-in')].map((el) => el.textContent ?? ''),
  )
  // The step (folded by now into its summary) and the answer; not the message, which rose.
  expect(fading.some((text) => /1 step/.test(text))).toBe(true)
  expect(fading.some((text) => text.includes('Looked.'))).toBe(true)
  expect(fading.some((text) => text.includes('Look at the header.'))).toBe(false)

  // Back from the pill, the same rows are already there: nothing fades in again.
  await chat.evaluate(() => window.gui.setMinimized(true))
  await expect(chat.getByRole('button', { name: 'Expand chat' })).toBeVisible()
  await chat.getByRole('button', { name: 'Expand chat' }).click()
  await expect(chat.getByText('Look at the header.')).toBeVisible()
  expect(await chat.locator('.animate-row-in').count()).toBe(0)

  // Answered, the card's box moves into the line that records the answer.
  await chat.evaluate(recordTransitions)
  await type(chat, 'ASK Build it.')
  const reject = chat.getByRole('button', { name: "Don't allow" })
  await expect(reject).toBeVisible()
  await sleep(300)
  await reject.click()
  await expect(chat.getByText('Not allowed')).toBeVisible()
  await waitFor(
    async () =>
      (await transitions(chat)).some((t) => t.before.includes('chat-permission-0:permission')),
    'the card collapsing',
  )
  const collapse = (await transitions(chat)).find((t) =>
    t.before.includes('chat-permission-0:permission'),
  )
  expect(collapse?.after).toEqual(['chat-permission-0:permission'])
  expect(collapse?.ran).toBe(true)
  await session.waitForTurn(1, 30_000)
})

test('with reduced motion nothing moves: rows fade in place', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  await useStandIn(session)
  const { chat } = session
  await session.waitForPreview()
  await chat.emulateMedia({ reducedMotion: 'reduce' })
  await chat.evaluate(recordTransitions)
  await type(chat, 'Look at the footer.')
  await session.waitForTurn(0, 30_000)
  expect(await transitions(chat)).toEqual([])
  const animation = await chat.evaluate(() => {
    const row = document.querySelector('.animate-row-in')
    return row ? getComputedStyle(row).animationName : null
  })
  expect(animation).toBe('row-fade')
})
