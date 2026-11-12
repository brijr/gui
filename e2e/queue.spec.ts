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

/**
 * ndjson JSON-RPC over stdio: just enough ACP for Gui to start a session and prompt it. Run
 * with `steer`, it also takes messages into a running turn (`_session/steering`), records
 * them as `STEER <text>`, and goes on for PROMPT_MS more.
 */
const AGENT_SCRIPT = `
const fs = require('node:fs')
const readline = require('node:readline')
const log = process.argv[2]
const steering = process.argv[3] === 'steer'
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
  if (method === 'initialize') {
    const meta = steering ? { _meta: { steering: { supported: true } } } : {}
    write({ id, result: { protocolVersion: params.protocolVersion, agentCapabilities: {}, authMethods: [], ...meta } })
  } else if (method === 'session/new') {
    write({ id, result: { sessionId: 'queue-' + process.pid } })
  } else if (method === 'session/prompt') {
    fs.appendFileSync(log, JSON.stringify(textOf(params.prompt)) + '\\n')
    running.set(params.sessionId, { id, timer: finishLater(params.sessionId, id) })
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
    running.delete(params.sessionId)
    write({ id: turn.id, result: { stopReason: 'cancelled' } })
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

test('Enter steers the reply under way; ⌘↩ queues, and Send now steers from the queue', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  await waitFor(async () => (await session.state()).project !== null, 'the project to open')
  const recorded = await useQueueAgent(session, true)
  const steered = (snapshot: Awaited<ReturnType<GuiSession['chatSnapshot']>>) =>
    snapshot.turns[0]?.items.flatMap((item) => (item.kind === 'steer' ? [item.prompt] : [])) ?? []

  expect(await send(session, 'STEER-A first')).toBe(true)
  await waitFor(async () => recorded().length === 1, 'the agent to receive A')
  await waitFor(
    async () => (await session.chatSnapshot()).meta.canSteer,
    'the reply to take steers',
  )

  // Enter steers: the message joins the running turn, not the queue.
  const box = session.chat.locator('[data-composer]')
  await box.fill('STEER-B from Enter')
  await expect(session.chat.getByRole('button', { name: 'Steer message' })).toBeVisible()
  await box.press('Enter')
  await waitFor(async () => steered(await session.chatSnapshot()).length === 1, 'B to steer')
  await expect(box).toHaveValue('')

  // ⌘↩ does the other: it queues.
  await box.fill('STEER-C queued with cmd')
  await box.press('Meta+Enter')
  await waitFor(
    async () => prompts(await queued(session)).join('|') === 'STEER-C queued with cmd',
    'C to be queued',
  )

  // Send now on its row puts it into the reply too.
  const row = session.chat.getByRole('list', { name: 'Queued messages' }).getByRole('listitem')
  await row.hover()
  await row
    .getByRole('button', { name: 'Send queued message now: STEER-C queued with cmd' })
    .click()
  await waitFor(async () => steered(await session.chatSnapshot()).length === 2, 'C to steer')
  await expect(session.chat.locator('[data-steer-message]')).toHaveText([
    'STEER-B from Enter',
    'STEER-C queued with cmd',
  ])

  // One turn did it all: no new turn, nothing left waiting.
  const done = await waitForIdle(session, 1)
  expect(done.turns[0]?.status).toBe('done')
  expect(steered(done)).toEqual(['STEER-B from Enter', 'STEER-C queued with cmd'])
  expect(done.meta.queue).toEqual([])
  expect(done.meta.canSteer).toBe(false)
  const sent = recorded()
  expect(sent).toHaveLength(3)
  expect(sent[1]).toMatch(/^STEER .*STEER-B from Enter/s)
  expect(sent[2]).toMatch(/^STEER .*STEER-C queued with cmd/s)
})

test('an agent that takes no message mid-reply queues them, with no Send now while it works', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  await waitFor(async () => (await session.state()).project !== null, 'the project to open')
  const recorded = await useQueueAgent(session)

  expect(await send(session, 'PLAIN-A first')).toBe(true)
  await waitFor(async () => recorded().length === 1, 'the agent to receive A')
  expect((await session.chatSnapshot()).meta.canSteer).toBe(false)

  // Enter queues; so does a steer the reply can't take. Nothing stops the turn.
  const box = session.chat.locator('[data-composer]')
  await box.fill('PLAIN-B from Enter')
  await expect(session.chat.getByRole('button', { name: 'Queue message' })).toBeVisible()
  await box.press('Enter')
  expect(
    await session.chat.evaluate(() =>
      window.gui.send('PLAIN-C asked to steer', [], [], null, true),
    ),
  ).toBe(true)
  await waitFor(
    async () =>
      prompts(await queued(session)).join('|') === 'PLAIN-B from Enter|PLAIN-C asked to steer',
    'B and C to be queued',
  )
  const row = session.chat.getByRole('list', { name: 'Queued messages' }).getByRole('listitem')
  await row.first().hover()
  await expect(row.first().getByRole('button', { name: /^Send queued message now/ })).toHaveCount(0)

  const after = await waitForIdle(session, 3)
  expect(after.turns.map((turn) => [turn.prompt, turn.status])).toEqual([
    ['PLAIN-A first', 'done'],
    ['PLAIN-B from Enter', 'done'],
    ['PLAIN-C asked to steer', 'done'],
  ])
  expect(after.meta.queue).toEqual([])
})
