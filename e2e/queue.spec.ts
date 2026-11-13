import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AgentId, CUSTOM_AGENT_PREFIX, type QueuedMessage } from '../src/shared/types'
import { electronExecutable, sleep, waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// Messages sent while the agent works wait in a queue and run in order afterwards; Stop
// pauses the queue. A tiny ACP agent stands in for a real one, so no login or usage is
// needed: each prompt takes PROMPT_MS, honors session/cancel, and is recorded to a file.

const QUEUE_AGENT: AgentId = `${CUSTOM_AGENT_PREFIX}Queue`
const PROMPT_MS = 1500
/** How long the steering agent takes to stop once asked */
const CANCEL_MS = 1000

/**
 * ndjson JSON-RPC over stdio: just enough ACP for Gui to start a session and prompt it. Run
 * with `steer`, it also takes messages into a running turn (`_session/steering`), records
 * them as `STEER <text>`, and goes on for PROMPT_MS more; it answers Stop only after
 * CANCEL_MS, as an agent winding down does; and a prompt with ASK-FIRST asks permission
 * (flagged, so Auto mode asks too) before it goes on, recording the answer as `ANSWER <id>`.
 */
const AGENT_SCRIPT = `
const fs = require('node:fs')
const readline = require('node:readline')
const log = process.argv[2]
const steering = process.argv[3] === 'steer'
const ALLOW = { optionId: 'allow', name: 'Allow', kind: 'allow_once' }
const REJECT = { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
const textOf = (prompt) => prompt.filter((block) => block.type === 'text').map((block) => block.text).join('\\n')
const running = new Map()
const finishLater = (sessionId, id) => setTimeout(() => {
  running.delete(sessionId)
  write({ id, result: { stopReason: 'end_turn' } })
}, ${PROMPT_MS})
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  const { id, method, params } = message
  if (method === undefined && typeof id === 'string' && id.startsWith('ask-')) {
    const sessionId = id.slice(4)
    const turn = running.get(sessionId)
    fs.appendFileSync(log, JSON.stringify('ANSWER ' + (message.result?.outcome?.optionId ?? 'none')) + '\\n')
    if (turn) turn.timer = finishLater(sessionId, turn.id)
    return
  }
  if (method === 'initialize') {
    const meta = steering ? { _meta: { steering: { supported: true } } } : {}
    write({ id, result: { protocolVersion: params.protocolVersion, agentCapabilities: {}, authMethods: [], ...meta } })
  } else if (method === 'session/new') {
    write({ id, result: { sessionId: 'queue-' + process.pid } })
  } else if (method === 'session/prompt') {
    const text = textOf(params.prompt)
    fs.appendFileSync(log, JSON.stringify(text) + '\\n')
    if (steering && text.includes('ASK-FIRST')) {
      const toolCall = { toolCallId: 'ask-1', title: 'rm -rf build', kind: 'execute', status: 'pending' }
      write({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call', ...toolCall } } })
      write({ id: 'ask-' + params.sessionId, method: 'session/request_permission', params: { sessionId: params.sessionId, toolCall, options: [REJECT, ALLOW] } })
      running.set(params.sessionId, { id, timer: null })
    } else running.set(params.sessionId, { id, timer: finishLater(params.sessionId, id) })
  } else if (method === '_session/steering' && steering) {
    const turn = running.get(params.sessionId)
    if (!turn) {
      write({ id, result: { outcome: 'promptRequired', reason: 'noRunningTurn' } })
      return
    }
    fs.appendFileSync(log, JSON.stringify('STEER ' + textOf(params.prompt)) + '\\n')
    clearTimeout(turn.timer)
    turn.timer = finishLater(params.sessionId, turn.id)
    write({ id, result: { outcome: 'injected' } })
  } else if (method === 'session/cancel') {
    const turn = running.get(params.sessionId)
    if (!turn) return
    clearTimeout(turn.timer)
    const stopped = () => {
      running.delete(params.sessionId)
      write({ id: turn.id, result: { stopReason: 'cancelled' } })
    }
    if (steering) setTimeout(stopped, ${CANCEL_MS})
    else stopped()
  } else if (id !== undefined && method !== undefined) {
    write({ id, error: { code: -32601, message: 'Method not found: ' + method } })
  }
})
`

/**
 * Adds the queue agent to agents.json, selects it, and returns the prompts it has received.
 * `steering`: it takes messages into a running turn.
 */
async function useQueueAgent(session: GuiSession, steering = false): Promise<() => string[]> {
  const { base, userData } = session.fixture
  const log = join(base, 'queue-prompts.ndjson')
  const script = join(base, 'queue-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  // Runs on Electron's own Node, as Gui runs its bundled adapters.
  const agents = {
    Queue: {
      command: electronExecutable(),
      args: steering ? [script, log, 'steer'] : [script, log],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
  }
  writeFileSync(join(userData, 'agents.json'), JSON.stringify(agents))
  await session.chrome.evaluate(() => window.gui.checkAgents())
  const listed = async () => (await session.state()).agents.some((a) => a.id === QUEUE_AGENT)
  await waitFor(listed, 'the queue agent to be listed')
  await session.chrome.evaluate((id) => window.gui.setAgent(id), QUEUE_AGENT)
  const selected = async () => (await session.chatSnapshot()).meta.agentId === QUEUE_AGENT
  await waitFor(selected, 'the queue agent to be selected')
  return () => {
    if (!existsSync(log)) return []
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean)
    return lines.map((line) => JSON.parse(line) as string)
  }
}

const send = (session: GuiSession, text: string) =>
  session.chat.evaluate((message) => window.gui.send(message), text)

const queued = async (session: GuiSession) => (await session.chatSnapshot()).meta.queue

const prompts = (queue: QueuedMessage[]) => queue.map((item) => item.prompt)

/** Waits until `count` turns exist and none is running. */
async function waitForIdle(session: GuiSession, count: number, timeout = 60_000) {
  const idle = async () => {
    const snapshot = await session.chatSnapshot()
    const settled = snapshot.turns.length === count
    return settled && snapshot.turns.every((turn) => turn.status !== 'running') ? snapshot : null
  }
  return waitFor(idle, `${count} turns to finish`, { timeout, interval: 250 })
}

/** Which of `markers` each recorded prompt carries, in the order the agent received them. */
const received = (recorded: string[], markers: string[]) =>
  recorded.map((text) => markers.find((marker) => text.includes(marker)) ?? '?')

test('messages sent while the agent works run in order; Stop pauses the queue', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  const open = async () => (await session.state()).project !== null
  await waitFor(open, 'the project to open')
  const recorded = await useQueueAgent(session)
  const markers = [
    'QUEUE-A',
    'QUEUE-B',
    'QUEUE-C',
    'QUEUE-E',
    'QUEUE-D',
    'QUEUE-F',
    'QUEUE-G',
    'QUEUE-H',
    'QUEUE-I',
    'QUEUE-J',
    'QUEUE-K',
    'QUEUE-L',
    'QUEUE-M',
    'QUEUE-N',
    'QUEUE-O',
    'QUEUE-P',
    'QUEUE-Q',
    'QUEUE-R',
  ]

  // A starts; B and C, sent while it runs, are accepted and wait in the queue.
  expect(await send(session, 'QUEUE-A first')).toBe(true)
  expect(await send(session, 'QUEUE-B second')).toBe(true)
  expect(await send(session, 'QUEUE-C third')).toBe(true)
  expect(prompts(await queued(session))).toEqual(['QUEUE-B second', 'QUEUE-C third'])

  // They run one after another, in the order sent, and the queue empties.
  const afterAbc = await waitForIdle(session, 3)
  expect(afterAbc.turns.map((turn) => turn.prompt)).toEqual([
    'QUEUE-A first',
    'QUEUE-B second',
    'QUEUE-C third',
  ])
  expect(afterAbc.turns.map((turn) => turn.status)).toEqual(['done', 'done', 'done'])
  expect(received(recorded(), markers)).toEqual(['QUEUE-A', 'QUEUE-B', 'QUEUE-C'])
  expect(afterAbc.meta.queue).toEqual([])
  expect(afterAbc.meta.queuePaused).toBe(false)

  // Stop while E runs: D, queued behind it, stays and the queue pauses.
  expect(await send(session, 'QUEUE-E fourth')).toBe(true)
  expect(await send(session, 'QUEUE-D queued then stopped')).toBe(true)
  const prompted = async () => recorded().length === 4
  await waitFor(prompted, 'the agent to receive E')
  await session.chat.evaluate(() => window.gui.cancel())
  const stopped = await waitForIdle(session, 4)
  expect(stopped.turns[3]?.status).toBe('cancelled')
  expect(stopped.meta.queuePaused).toBe(true)
  expect(prompts(stopped.meta.queue)).toEqual(['QUEUE-D queued then stopped'])
  // Paused means paused: D doesn't start on its own.
  await sleep(PROMPT_MS + 500)
  expect(recorded()).toHaveLength(4)
  expect((await session.chatSnapshot()).turns).toHaveLength(4)

  // "Send next" runs it.
  await session.chat.evaluate(() => window.gui.sendQueuedNow())
  const resumed = await waitForIdle(session, 5)
  expect(resumed.turns[4]?.prompt).toBe('QUEUE-D queued then stopped')
  expect(resumed.turns[4]?.status).toBe('done')
  expect(resumed.meta.queue).toEqual([])
  expect(resumed.meta.queuePaused).toBe(false)
  expect(received(recorded(), markers).at(-1)).toBe('QUEUE-D')

  // A removed message never runs.
  expect(await send(session, 'QUEUE-F fifth')).toBe(true)
  expect(await send(session, 'QUEUE-G removed')).toBe(true)
  expect(await send(session, 'QUEUE-H sixth')).toBe(true)
  const queue = await queued(session)
  expect(prompts(queue)).toEqual(['QUEUE-G removed', 'QUEUE-H sixth'])
  const removed = queue[0]?.id ?? ''
  await session.chat.evaluate((id) => window.gui.removeQueued(id), removed)
  const dropped = async () => {
    const now = prompts(await queued(session))
    return now.length === 1 && now[0] === 'QUEUE-H sixth'
  }
  await waitFor(dropped, 'the removed message to leave the queue')
  const final = await waitForIdle(session, 7)
  expect(final.turns.slice(5).map((turn) => turn.prompt)).toEqual([
    'QUEUE-F fifth',
    'QUEUE-H sixth',
  ])
  expect(received(recorded(), markers).slice(5)).toEqual(['QUEUE-F', 'QUEUE-H'])
  expect(final.meta.queue).toEqual([])

  // A queued message can be edited and moved while it waits; the agent gets the new
  // text, in the new order.
  expect(await send(session, 'QUEUE-I seventh')).toBe(true)
  expect(await send(session, 'QUEUE-J eighth draft')).toBe(true)
  expect(await send(session, 'QUEUE-K ninth')).toBe(true)
  const editing = await queued(session)
  expect(prompts(editing)).toEqual(['QUEUE-J eighth draft', 'QUEUE-K ninth'])
  await session.chat.evaluate(
    (id) => window.gui.editQueued(id, 'QUEUE-J eighth, edited'),
    editing[0]?.id ?? '',
  )
  await session.chat.evaluate((id) => window.gui.moveQueued(id, 0), editing[1]?.id ?? '')
  const rearranged = async () => {
    const snapshot = await session.chatSnapshot()
    const now = prompts(snapshot.meta.queue)
    return (
      (now[0] === 'QUEUE-K ninth' && now[1] === 'QUEUE-J eighth, edited') ||
      snapshot.turns[8]?.prompt === 'QUEUE-K ninth'
    )
  }
  await waitFor(rearranged, 'the edit and move to reach the queue')
  const afterEdit = await waitForIdle(session, 10)
  expect(afterEdit.turns.slice(7).map((turn) => turn.prompt)).toEqual([
    'QUEUE-I seventh',
    'QUEUE-K ninth',
    'QUEUE-J eighth, edited',
  ])
  expect(received(recorded(), markers).slice(7)).toEqual(['QUEUE-I', 'QUEUE-K', 'QUEUE-J'])

  // Stop pauses three held messages; sending the middle one from its row runs just it,
  // and the others stay held.
  expect(await send(session, 'QUEUE-L tenth')).toBe(true)
  expect(await send(session, 'QUEUE-M held one')).toBe(true)
  expect(await send(session, 'QUEUE-N held two')).toBe(true)
  expect(await send(session, 'QUEUE-O held three')).toBe(true)
  const lPrompted = async () => recorded().length === 11
  await waitFor(lPrompted, 'the agent to receive L')
  await session.chat.evaluate(() => window.gui.cancel())
  const held = await waitForIdle(session, 11)
  expect(held.meta.queuePaused).toBe(true)
  expect(prompts(held.meta.queue)).toEqual([
    'QUEUE-M held one',
    'QUEUE-N held two',
    'QUEUE-O held three',
  ])
  const list = session.chat.getByRole('list', { name: 'Queued messages' })
  // Dragging uses the same order as the accessible move buttons.
  // Dispatch HTML drag events: native drag input across Electron views is unreliable.
  const drag = async (from: number, to: number) => {
    const dataTransfer = await session.chat.evaluateHandle(() => new DataTransfer())
    const source = list.getByRole('listitem').nth(from)
    const target = list.getByRole('listitem').nth(to)
    await source.dispatchEvent('dragstart', { dataTransfer })
    await target.dispatchEvent('dragover', { dataTransfer })
    await target.dispatchEvent('drop', { dataTransfer })
    await source.dispatchEvent('dragend', { dataTransfer })
    await dataTransfer.dispose()
  }
  await drag(2, 0)
  await waitFor(
    async () =>
      prompts(await queued(session)).join('|') ===
      'QUEUE-O held three|QUEUE-M held one|QUEUE-N held two',
    'the dragged message to move first',
  )
  await expect(list.getByRole('listitem').nth(0).locator('p')).toHaveText('QUEUE-O held three')
  await drag(0, 2)
  await waitFor(
    async () =>
      prompts(await queued(session)).join('|') ===
      'QUEUE-M held one|QUEUE-N held two|QUEUE-O held three',
    'the dragged message to move last',
  )
  const middleRow = list.getByRole('listitem').nth(1)
  await middleRow.hover()
  await middleRow.getByRole('button', { name: 'Send queued message now: QUEUE-N held two' }).click()
  const afterMiddle = await waitForIdle(session, 12)
  expect(afterMiddle.turns[11]?.prompt).toBe('QUEUE-N held two')
  expect(afterMiddle.turns[11]?.status).toBe('done')
  expect(prompts(afterMiddle.meta.queue)).toEqual(['QUEUE-M held one', 'QUEUE-O held three'])
  expect(afterMiddle.meta.queuePaused).toBe(true)
  await sleep(500)
  expect(recorded()).toHaveLength(12)

  // The row buttons rearrange and edit what's held; "Send next" then runs the rest in
  // their new order, with the new text.
  const firstRow = list.getByRole('listitem').nth(0)
  await firstRow.hover()
  await firstRow.getByRole('button', { name: 'Move queued message down: QUEUE-M held one' }).click()
  const swapped = async () => {
    const now = prompts(await queued(session))
    return now[0] === 'QUEUE-O held three' && now[1] === 'QUEUE-M held one'
  }
  await waitFor(swapped, 'the swap to reach the queue')
  const editRow = list.getByRole('listitem').nth(0)
  await editRow.hover()
  await editRow.getByRole('button', { name: 'Edit queued message: QUEUE-O held three' }).click()
  await editRow
    .getByRole('textbox', { name: 'Edit queued message: QUEUE-O held three' })
    .fill('QUEUE-O held three, edited')
  await editRow.getByRole('button', { name: 'Save' }).click()
  const editedHeld = async () => prompts(await queued(session))[0] === 'QUEUE-O held three, edited'
  await waitFor(editedHeld, 'the held edit to reach the queue')
  await session.chat.evaluate(() => window.gui.sendQueuedNow())
  const afterHeld = await waitForIdle(session, 14)
  expect(afterHeld.turns.slice(12).map((turn) => turn.prompt)).toEqual([
    'QUEUE-O held three, edited',
    'QUEUE-M held one',
  ])
  expect(afterHeld.meta.queue).toEqual([])
  expect(afterHeld.meta.queuePaused).toBe(false)

  // "Clear all" drops everything waiting; none of it runs.
  expect(await send(session, 'QUEUE-P eleventh')).toBe(true)
  expect(await send(session, 'QUEUE-Q cleared one')).toBe(true)
  expect(await send(session, 'QUEUE-R cleared two')).toBe(true)
  expect(prompts(await queued(session))).toEqual(['QUEUE-Q cleared one', 'QUEUE-R cleared two'])
  await session.chat.getByRole('button', { name: 'Clear all' }).click()
  const cleared = async () => (await queued(session)).length === 0
  await waitFor(cleared, 'the queue to clear')
  const afterClear = await waitForIdle(session, 15)
  expect(afterClear.turns[14]?.prompt).toBe('QUEUE-P eleventh')
  expect(received(recorded(), markers)).toHaveLength(15)
  expect(received(recorded(), markers).at(-1)).toBe('QUEUE-P')
})

test('removing queued messages keeps focus in the queue and composer', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  await waitFor(async () => (await session.state()).project !== null, 'the project to open')
  await useQueueAgent(session)
  await send(session, 'Focus running')
  await send(session, 'Focus first')
  await send(session, 'Focus second')
  await session.chat.evaluate(() => window.gui.cancel())
  await expect.poll(async () => (await queued(session)).length).toBe(2)
  const list = session.chat.getByRole('list', { name: 'Queued messages' })
  await list.getByRole('button', { name: 'Remove queued message: Focus first' }).click()
  await expect(
    list.getByRole('button', { name: 'Edit queued message: Focus second' }),
  ).toBeFocused()
  await list.getByRole('button', { name: 'Remove queued message: Focus second' }).click()
  await expect(session.chat.locator('[data-composer]')).toBeFocused()
})

/** The messages steered into `turn`'s reply, in order. */
const steeredInto = (snapshot: Awaited<ReturnType<GuiSession['chatSnapshot']>>, turn = 0) =>
  snapshot.turns[turn]?.items.flatMap((item) => (item.kind === 'steer' ? [item.prompt] : [])) ?? []

/** Starts `text` on the steering agent and waits until its reply takes messages. */
async function startSteerable(session: GuiSession, recorded: () => string[], text: string) {
  const before = recorded().length
  expect(await send(session, text)).toBe(true)
  await waitFor(async () => recorded().length === before + 1, `the agent to receive ${text}`)
  await waitFor(
    async () => (await session.chatSnapshot()).meta.canSteer,
    'the reply to take steers',
  )
}

test('Enter queues by default and ⌘↩ steers; Send now steers from the queue; ⌘↩ allows a waiting card', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  await waitFor(async () => (await session.state()).project !== null, 'the project to open')
  const recorded = await useQueueAgent(session, true)
  expect((await session.chatSnapshot()).meta.whileWorking).toBe('queue')

  await startSteerable(session, recorded, 'STEER-A first')
  const box = session.chat.locator('[data-composer]')
  await expect(box).toHaveAttribute('placeholder', 'Queue a message…')
  await box.fill('STEER-B from Enter')
  const button = session.chat.getByRole('button', { name: 'Queue message' })
  await expect(button).toHaveAttribute('title', 'Queue · ⌘↩ to send now')

  // Enter queues.
  await box.press('Enter')
  await waitFor(
    async () => prompts(await queued(session)).join('|') === 'STEER-B from Enter',
    'B to be queued',
  )
  await expect(box).toHaveValue('')

  // ⌘↩ sends into the reply under way instead.
  await box.fill('STEER-C with cmd')
  await box.press('Meta+Enter')
  await waitFor(
    async () => steeredInto(await session.chatSnapshot()).join('|') === 'STEER-C with cmd',
    'C to steer',
  )
  await expect(box).toHaveValue('')
  expect(prompts(await queued(session))).toEqual(['STEER-B from Enter'])

  // Send now on a queued row puts it into the reply too.
  const row = session.chat.getByRole('list', { name: 'Queued messages' }).getByRole('listitem')
  await row.hover()
  await row.getByRole('button', { name: 'Send queued message now: STEER-B from Enter' }).click()
  await waitFor(
    async () => steeredInto(await session.chatSnapshot()).length === 2,
    'B to steer from the queue',
  )
  await expect(session.chat.locator('[data-steer-message]')).toHaveText([
    'STEER-C with cmd',
    'STEER-B from Enter',
  ])

  // One turn did it all: no new turn, nothing left waiting.
  const done = await waitForIdle(session, 1)
  expect(done.turns[0]?.status).toBe('done')
  expect(done.meta.queue).toEqual([])
  expect(done.meta.canSteer).toBe(false)
  const sent = recorded()
  expect(sent).toHaveLength(3)
  expect(sent[1]).toMatch(/^STEER .*STEER-C with cmd/s)
  expect(sent[2]).toMatch(/^STEER .*STEER-B from Enter/s)

  // While a permission card waits, ⌘↩ is Allow: the draft stays in the box.
  const allowItem = () =>
    session.app.evaluate(
      ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('allow')?.enabled ?? null,
    )
  expect(await allowItem()).toBe(false)
  expect(await send(session, 'ASK-FIRST then go on')).toBe(true)
  await waitFor(
    async () =>
      (await session.chatSnapshot()).turns[1]?.items.some(
        (item) => item.kind === 'permission' && item.resolved === null,
      ) ?? false,
    'the permission card',
  )
  await expect.poll(allowItem).toBe(true)
  await box.fill('STEER-D held while asked')
  await box.press('Meta+Enter')
  await waitFor(async () => recorded().includes('ANSWER allow'), 'the card to be allowed')
  await expect(box).toHaveValue('STEER-D held while asked')
  expect(await queued(session)).toEqual([])
  expect(steeredInto(await session.chatSnapshot(), 1)).toEqual([])
  await expect.poll(allowItem).toBe(false)

  // The reply goes on and ends with the draft still there, never sent.
  const after = await waitForIdle(session, 2)
  await expect(box).toHaveValue('STEER-D held while asked')
  expect(after.meta.queue).toEqual([])
  expect(steeredInto(after, 1)).toEqual([])
  expect(recorded().filter((text) => text.includes('STEER-D'))).toEqual([])
})

test('with Steer chosen in Settings, Enter steers and ⌘↩ queues', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  await waitFor(async () => (await session.state()).project !== null, 'the project to open')
  const recorded = await useQueueAgent(session, true)

  await session.chrome.evaluate(() => window.gui.openSettings('agents'))
  const settings = async () =>
    session.app
      .context()
      .pages()
      .find((page) => page.url().endsWith('/settings.html'))
  await waitFor(async () => (await settings()) !== undefined, 'the settings window')
  const page = await settings()
  if (!page) throw new Error('Missing settings window')
  const choice = page.getByRole('group', { name: 'Sending while the agent works' })
  // Queue first, and chosen.
  await expect(choice.getByRole('button')).toHaveText(['Queue', 'Steer'])
  await expect(choice.getByRole('button', { name: 'Queue' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await choice.getByRole('button', { name: 'Steer' }).click()
  await waitFor(
    async () => (await session.chatSnapshot()).meta.whileWorking === 'steer',
    'the chat to follow the setting',
  )
  await page.close()

  await startSteerable(session, recorded, 'SWAP-A first')
  const box = session.chat.locator('[data-composer]')
  await expect(box).toHaveAttribute('placeholder', 'Steer the agent…')
  await box.fill('SWAP-B from Enter')
  await expect(session.chat.getByRole('button', { name: 'Steer message' })).toHaveAttribute(
    'title',
    'Steer · ⌘↩ to queue',
  )
  await box.press('Enter')
  await waitFor(
    async () => steeredInto(await session.chatSnapshot()).join('|') === 'SWAP-B from Enter',
    'B to steer',
  )
  await box.fill('SWAP-C with cmd')
  await box.press('Meta+Enter')
  await waitFor(
    async () => prompts(await queued(session)).join('|') === 'SWAP-C with cmd',
    'C to be queued',
  )
  const done = await waitForIdle(session, 2)
  expect(done.turns.map((turn) => turn.prompt)).toEqual(['SWAP-A first', 'SWAP-C with cmd'])
  expect(steeredInto(done)).toEqual(['SWAP-B from Enter'])
})

test('an agent that takes no message mid-reply always queues, and keeps Send next', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  await waitFor(async () => (await session.state()).project !== null, 'the project to open')
  const recorded = await useQueueAgent(session)

  expect(await send(session, 'PLAIN-A first')).toBe(true)
  await waitFor(async () => recorded().length === 1, 'the agent to receive A')
  expect((await session.chatSnapshot()).meta.canSteer).toBe(false)

  // Enter queues, and so does ⌘↩: there's no reply to steer.
  const box = session.chat.locator('[data-composer]')
  await expect(box).toHaveAttribute('placeholder', 'Queue a message…')
  await box.fill('PLAIN-B from Enter')
  const button = session.chat.getByRole('button', { name: 'Queue message' })
  await expect(button).toHaveAttribute('title', 'Queue message (↩)')
  await box.press('Enter')
  await box.fill('PLAIN-C with cmd')
  await box.press('Meta+Enter')
  await waitFor(
    async () => prompts(await queued(session)).join('|') === 'PLAIN-B from Enter|PLAIN-C with cmd',
    'B and C to be queued',
  )

  // Send next moves C to the front; nothing goes into the reply.
  const list = session.chat.getByRole('list', { name: 'Queued messages' })
  const second = list.getByRole('listitem').nth(1)
  await second.hover()
  await expect(second.getByRole('button', { name: /^Send queued message now/ })).toHaveCount(0)
  await second.getByRole('button', { name: 'Send queued message next: PLAIN-C with cmd' }).click()
  await waitFor(
    async () => prompts(await queued(session)).join('|') === 'PLAIN-C with cmd|PLAIN-B from Enter',
    'C to move first',
  )

  const after = await waitForIdle(session, 3)
  expect(after.turns.map((turn) => [turn.prompt, turn.status])).toEqual([
    ['PLAIN-A first', 'done'],
    ['PLAIN-C with cmd', 'done'],
    ['PLAIN-B from Enter', 'done'],
  ])
  expect(after.turns.flatMap((turn) => turn.items).some((item) => item.kind === 'steer')).toBe(
    false,
  )
  expect(after.meta.queue).toEqual([])
})

test('after Stop, a message sent to steer is queued, never steered into the stopping reply', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  await waitFor(async () => (await session.state()).project !== null, 'the project to open')
  const recorded = await useQueueAgent(session, true)

  await startSteerable(session, recorded, 'STOP-A first')
  await session.chat.getByRole('button', { name: 'Stop' }).click()
  // The agent takes CANCEL_MS to stop: the reply is still under way, but takes nothing more.
  await waitFor(async () => !(await session.chatSnapshot()).meta.canSteer, 'Stop to end steering')
  const box = session.chat.locator('[data-composer]')
  await box.fill('STOP-B after stop')
  await box.press('Meta+Enter')
  await waitFor(
    async () => prompts(await queued(session)).join('|') === 'STOP-B after stop',
    'B to be queued',
  )
  // Straight to main as well: asked to steer, it's queued.
  expect(
    await session.chat.evaluate(() => window.gui.send('STOP-C asked to steer', [], [], null, true)),
  ).toBe(true)
  const stopped = await waitForIdle(session, 1)
  expect(stopped.turns[0]?.status).toBe('cancelled')
  expect(steeredInto(stopped)).toEqual([])
  expect(prompts(stopped.meta.queue)).toEqual(['STOP-B after stop', 'STOP-C asked to steer'])
  expect(stopped.meta.queuePaused).toBe(true)
  expect(recorded().filter((text) => text.startsWith('STEER '))).toEqual([])
})
