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

/** ndjson JSON-RPC over stdio: just enough ACP for Gui to start a session and prompt it. */
const AGENT_SCRIPT = `
const fs = require('node:fs')
const readline = require('node:readline')
const log = process.argv[2]
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n')
const running = new Map()
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  const { id, method, params } = message
  if (method === 'initialize') {
    write({ id, result: { protocolVersion: params.protocolVersion, agentCapabilities: {}, authMethods: [] } })
  } else if (method === 'session/new') {
    write({ id, result: { sessionId: 'queue-' + process.pid } })
  } else if (method === 'session/prompt') {
    const text = params.prompt.filter((block) => block.type === 'text').map((block) => block.text).join('\\n')
    fs.appendFileSync(log, JSON.stringify(text) + '\\n')
    const timer = setTimeout(() => {
      running.delete(params.sessionId)
      write({ id, result: { stopReason: 'end_turn' } })
    }, ${PROMPT_MS})
    running.set(params.sessionId, { id, timer })
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

/** Adds the queue agent to agents.json, selects it, and returns the prompts it has received. */
async function useQueueAgent(session: GuiSession): Promise<() => string[]> {
  const { base, userData } = session.fixture
  const log = join(base, 'queue-prompts.ndjson')
  const script = join(base, 'queue-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  // Runs on Electron's own Node, as Gui runs its bundled adapters.
  const agents = {
    Queue: {
      command: electronExecutable(),
      args: [script, log],
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
})
