import assert from 'node:assert/strict'
import { type ChatTurnUpdate, TurnPublisher } from '../../src/shared/chat-transport'
import type { ChatMeta, ChatSnapshot, Turn } from '../../src/shared/types'

const listeners = new Map<string, (value: never) => void>()
const requests: { resolve: (snapshot: ChatSnapshot) => void; reject: (error: Error) => void }[] = []
const gui = new Proxy(
  {},
  {
    get(_target, name: string) {
      if (name === 'getChat')
        return () =>
          new Promise<ChatSnapshot>((resolve, reject) => requests.push({ resolve, reject }))
      if (name.startsWith('on'))
        return (listener: (value: never) => void) => {
          listeners.set(name, listener)
          return () => listeners.delete(name)
        }
      return () => Promise.resolve()
    },
  },
)
const media = { matches: true }
Object.assign(globalThis, {
  window: { gui },
  HTMLElement: class {},
  document: { visibilityState: 'hidden', querySelector: () => null, addEventListener: () => {} },
  matchMedia: () => media,
})
const { connectChat, useChat } = await import('../../src/renderer/src/chat/store')
const meta = { queue: [], docked: true } as unknown as ChatMeta
const turn: Turn = {
  id: 'turn',
  index: 0,
  prompt: 'Build',
  context: [],
  items: [],
  status: 'running',
  error: null,
  startedAt: 1,
  endedAt: null,
  changes: null,
  reverted: false,
}
const publisher = new TurnPublisher()
function emit(name: string, value: ChatTurnUpdate | ChatSnapshot | ChatMeta) {
  const listener = listeners.get(name)
  assert.ok(listener)
  listener(value as never)
}
function update() {
  const message = publisher.update(turn)
  emit('onChatTurn', structuredClone(message))
  return message
}
const disconnect = connectChat()
// Updates arriving before the initial snapshot resolves must survive its application.
const initial = publisher.update(turn)
requests
  .shift()
  ?.resolve({ meta, turns: [structuredClone(turn)], revisions: publisher.revisions() })
turn.items.push({ id: 'text', kind: 'text', text: 'hello' })
const added = update()
emit('onChatMeta', { ...meta, error: 'Newer metadata' })
await Promise.resolve()
assert.equal(useChat.getState().meta?.error, 'Newer metadata')
assert.deepEqual(useChat.getState().turnsById.turn, turn)
const ids = useChat.getState().turnIds
// Duplicates and old events must not replay append operations.
emit('onChatTurn', added)
emit('onChatTurn', initial)
assert.deepEqual(useChat.getState().turnsById.turn, turn)
assert.equal(useChat.getState().turnIds, ids)
// A dropped update requests recovery; a later update queues behind its snapshot.
turn.items[0] = { id: 'text', kind: 'text', text: 'hello dropped' }
publisher.update(turn)
turn.items[0] = { id: 'text', kind: 'text', text: 'hello dropped recover' }
update()
assert.equal(requests.length, 1)
const recovery = requests.shift()
assert.ok(recovery)
const snapshot = { meta, turns: [structuredClone(turn)], revisions: publisher.revisions() }
turn.items[0] = { id: 'text', kind: 'text', text: 'hello dropped recover late' }
update()
recovery.resolve(snapshot)
await Promise.resolve()
assert.deepEqual(useChat.getState().turnsById.turn, turn)
// A reset supersedes an inflight recovery response, including the old transcript.
publisher.update(turn)
update()
const staleRecovery = requests.shift()
assert.ok(staleRecovery)
emit('onChatReset', { meta, turns: [], revisions: {} })
staleRecovery.resolve(snapshot)
await Promise.resolve()
assert.deepEqual(useChat.getState().turnIds, [])
publisher.clear()
update()
assert.deepEqual(useChat.getState().turnsById.turn, turn)
// Undo/finish can update older rows without replacing the ID list or another row.
turn.status = 'done'
turn.reverted = true
turn.endedAt = 2
turn.changes = [{ path: 'app.ts', status: 'modified', additions: 1, deletions: 0 }]
update()
assert.deepEqual(useChat.getState().turnsById.turn, turn)
// Two resets queued behind a view transition: only the newest snapshot may drain updates.
const { transition } = await import('../../src/renderer/src/chat/transitions')
let applyTransition: (() => void) | undefined
media.matches = false
Object.assign(document, {
  visibilityState: 'visible',
  querySelector: () => ({}),
  startViewTransition: (apply: () => void) => {
    applyTransition = apply
    return { finished: Promise.resolve(), skipTransition: () => {} }
  },
})
transition(() => {}, [{ name: 'test', from: () => null, to: () => null, enters: true }])
emit('onChatReset', { meta, turns: [], revisions: {} })
publisher.clear()
const resetInitial = publisher.update(turn)
emit('onChatReset', { meta, turns: [structuredClone(turn)], revisions: publisher.revisions() })
turn.error = 'After second reset'
update()
emit('onChatMeta', { ...meta, error: 'Metadata after second reset' })
assert.ok(applyTransition)
applyTransition()
assert.deepEqual(useChat.getState().turnsById.turn, turn)
assert.equal(useChat.getState().meta?.error, 'Metadata after second reset')
emit('onChatTurn', resetInitial)
assert.deepEqual(useChat.getState().turnsById.turn, turn)
// A transient failure recovers the final buffered event even when no new events arrive.
media.matches = true
publisher.update(turn)
update()
const failed = requests.shift()
assert.ok(failed)
turn.error = 'Final state with no future updates'
update()
emit('onChatMeta', { ...meta, error: 'Final buffered metadata' })
failed.reject(new Error('Temporary failure'))
await new Promise((resolve) => setTimeout(resolve, 280))
const retried = requests.shift()
assert.ok(retried)
retried.resolve({ meta, turns: [structuredClone(turn)], revisions: publisher.revisions() })
await Promise.resolve()
assert.deepEqual(useChat.getState().turnsById.turn, turn)
assert.equal(useChat.getState().meta?.error, 'Final buffered metadata')
// Queued messages edited or rearranged land in place; one sent from the middle of the
// queue leaves it as its turn arrives, and the rest keep waiting.
const waiting = (id: string, prompt: string) => ({ id, prompt, context: [], attachments: [] })
const firstWaiting = waiting('q1', 'First waiting')
const secondWaiting = waiting('q2', 'Second waiting')
const thirdWaiting = waiting('q3', 'Third waiting')
const withQueue = (queue: ChatMeta['queue']) => ({ ...meta, queue, error: null })
const queueIds = () => useChat.getState().meta?.queue.map((item) => item.id)
emit('onChatMeta', withQueue([firstWaiting, secondWaiting, thirdWaiting]))
assert.deepEqual(queueIds(), ['q1', 'q2', 'q3'])
const secondEdited = waiting('q2', 'Second, edited')
emit('onChatMeta', withQueue([firstWaiting, secondEdited, thirdWaiting]))
assert.equal(useChat.getState().meta?.queue[1]?.prompt, 'Second, edited')
emit('onChatMeta', withQueue([firstWaiting, thirdWaiting, secondEdited]))
assert.deepEqual(queueIds(), ['q1', 'q3', 'q2'])
emit('onChatMeta', withQueue([firstWaiting, secondEdited]))
const middle: Turn = {
  id: 'middle',
  index: 1,
  prompt: 'Third waiting',
  context: [],
  items: [],
  status: 'running',
  error: null,
  startedAt: 3,
  endedAt: null,
  changes: null,
  reverted: false,
}
emit('onChatTurn', structuredClone(publisher.update(middle)))
assert.deepEqual(queueIds(), ['q1', 'q2'])
assert.deepEqual(useChat.getState().turnsById.middle, middle)
// Permanent failures stop after three attempts, and reset/disconnect cancel pending retries.
publisher.update(turn)
update()
const permanent = requests.shift()
assert.ok(permanent)
permanent.reject(new Error('Permanent failure'))
await new Promise((resolve) => setTimeout(resolve, 280))
const second = requests.shift()
assert.ok(second)
second.reject(new Error('Permanent failure'))
await new Promise((resolve) => setTimeout(resolve, 780))
const third = requests.shift()
assert.ok(third)
third.reject(new Error('Permanent failure'))
await new Promise((resolve) => setTimeout(resolve, 280))
assert.equal(requests.length, 0)
assert.match(useChat.getState().notice ?? '', /after three attempts/)
update()
const resetRetry = requests.shift()
assert.ok(resetRetry)
resetRetry.reject(new Error('Temporary failure'))
await Promise.resolve()
await Promise.resolve()
emit('onChatReset', { meta, turns: [structuredClone(turn)], revisions: publisher.revisions() })
await new Promise((resolve) => setTimeout(resolve, 280))
assert.equal(requests.length, 0)
publisher.update(turn)
update()
const disconnectRetry = requests.shift()
assert.ok(disconnectRetry)
disconnectRetry.reject(new Error('Temporary failure'))
await Promise.resolve()
await Promise.resolve()
disconnect()
await new Promise((resolve) => setTimeout(resolve, 280))
assert.equal(requests.length, 0)
console.log(
  'Chat store checks passed: initial race, duplicates, recovery, deferred reset, final-event retries, queue edit/reorder/send-from-middle, bounded failures and retry cancellation.',
)
