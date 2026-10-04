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
 * Speaks ACP on stdio, with a model setting. A prompt with WORK keeps working until Stop;
 * BRIEF works for a moment and ends; ASK asks to run a command; anything else takes a step and
 * answers.
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

const models = (currentValue) => [{ id: 'model', name: 'Model', type: 'select', category: 'model',
  currentValue, options: [{ value: 'swift', name: 'Swift' }, { value: 'sage', name: 'Sage' }] }]

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
  if (method === 'session/new') {
    return write({ id, result: { sessionId: 'session-1', configOptions: models('swift') } })
  }
  if (method === 'session/set_config_option') {
    return write({ id, result: { configOptions: models(params.value) } })
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

interface ScaleStore {
  guiScales?: { t: number; scale: number; opacity: number; state: string }[]
}

/** Runs in the chat page: records the picker's scale and opacity every frame for 1.5 s. */
function recordPicker() {
  const store = globalThis as unknown as ScaleStore
  const frames: NonNullable<ScaleStore['guiScales']> = []
  store.guiScales = frames
  const start = performance.now()
  const record = () => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    if (dialog) {
      const style = getComputedStyle(dialog)
      const [first = '1'] = style.scale === 'none' ? [] : style.scale.split(' ')
      const scale = first.endsWith('%') ? Number.parseFloat(first) / 100 : Number(first)
      frames.push({
        t: Math.round(performance.now() - start),
        scale,
        opacity: Number(style.opacity),
        state: dialog.dataset.state ?? '',
      })
    }
    if (performance.now() - start < 1500) requestAnimationFrame(record)
  }
  requestAnimationFrame(record)
}

test('the model picker opens out of its button and closes back into it; a press shows at once', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  await useStandIn(session)
  const { chat } = session
  await waitFor(async () => (await session.chatSnapshot()).meta.models, "the agent's models")
  const button = chat.getByRole('button', { name: 'Model: Swift' })

  // Held down, a button dims at once; let go, it eases back.
  const box = await button.boundingBox()
  if (!box) throw new Error('The model button has no layout box')
  const opacity = () => button.evaluate((el) => Number(getComputedStyle(el).opacity))
  await chat.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await chat.mouse.down()
  expect(await opacity()).toBeCloseTo(0.7, 2)
  await chat.mouse.move(box.x - 40, box.y - 40)
  await chat.mouse.up()
  await expect.poll(opacity).toBe(1)

  // Opens upward out of the button's middle, growing from 97% as it fades in.
  await chat.evaluate(recordPicker)
  await button.click()
  const picker = chat.getByRole('dialog', { name: 'Choose a model' })
  await expect(picker).toBeVisible()
  // Measured once it's at full size: the origin is in its own, unscaled box.
  await sleep(600)
  const placed = await picker.evaluate((el) => {
    const trigger = document.querySelector('[aria-haspopup="dialog"]')?.getBoundingClientRect()
    const box = el.getBoundingClientRect()
    const middle = trigger ? trigger.left + trigger.width / 2 - box.left : -1
    return { origin: el.style.transformOrigin, middle }
  })
  expect(placed.origin).toMatch(/^\d+px 100%$/)
  expect(Math.abs(Number.parseFloat(placed.origin) - placed.middle)).toBeLessThan(1.5)

  // Esc: it closes back the way it came, still there for a moment, then gone.
  await chat.keyboard.press('Escape')
  await expect(picker).toHaveAttribute('data-state', 'closed')
  await expect(picker).toHaveCount(0)
  await expect(button).toBeFocused()
  await sleep(1000)
  const frames = await chat.evaluate(() => (globalThis as unknown as ScaleStore).guiScales ?? [])
  const opening = frames.filter((f) => f.state === 'open')
  expect(opening[0]?.scale).toBeLessThan(1)
  expect(opening.some((f) => f.opacity > 0 && f.opacity < 1)).toBe(true)
  expect(opening.at(-1)?.scale).toBe(1)
  const closing = frames.filter((f) => f.state === 'closed')
  expect(closing.some((f) => f.opacity < 1 && f.scale < 1)).toBe(true)
})
