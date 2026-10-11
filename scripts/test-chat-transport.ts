import assert from 'node:assert/strict'
import { applyTurnUpdate, TurnPublisher } from '../src/shared/chat-transport'
import type { Turn } from '../src/shared/types'

function fixture(): Turn {
  return {
    id: 'turn',
    index: 0,
    prompt: 'Build it',
    context: [],
    items: [],
    status: 'running',
    error: null,
    startedAt: 1,
    endedAt: null,
    changes: null,
    reverted: false,
  }
}

const publisher = new TurnPublisher()
const turn = fixture()
let received: Turn | undefined
let revision: number | undefined
function send() {
  const update = publisher.update(turn)
  const next = applyTurnUpdate(received, revision, structuredClone(update))
  assert.ok(next)
  assert.deepEqual(next, turn)
  received = next
  revision = update.revision
  return update
}
send()
turn.items.push({ id: 'text', kind: 'text', text: 'hello' })
send()
turn.items[0] = { id: 'text', kind: 'text', text: 'hello world' }
const append = send()
assert.equal(append.kind, 'patch')
if (append.kind === 'patch')
  assert.deepEqual(append.items, [{ kind: 'append', id: 'text', text: ' world' }])
// Rewrites, permissions, nested mutable plan updates and removals must still converge.
turn.items[0] = { id: 'text', kind: 'thought', text: 'rewritten' }
send()
turn.items.push({ id: 'plan', kind: 'plan', entries: [{ content: 'Do it', status: 'pending' }] })
send()
const plan = turn.items[1]
if (plan.kind === 'plan') plan.entries[0].status = 'completed'
send()
turn.items.push({
  id: 'permission',
  kind: 'permission',
  title: 'Run',
  toolKind: 'execute',
  locations: [],
  sensitive: false,
  options: [],
  resolved: null,
})
send()
const permission = turn.items[2]
if (permission.kind === 'permission') permission.resolved = 'allow'
send()
turn.items.splice(0, 1)
turn.status = 'done'
turn.endedAt = 2
send()
const skipped = publisher.update(turn)
turn.error = 'changed'
const afterGap = publisher.update(turn)
assert.equal(applyTurnUpdate(received, revision, afterGap), null)
assert.equal(applyTurnUpdate(undefined, undefined, skipped), null)
// Recovery uses a full transcript plus these revisions, then accepts the next patch.
received = structuredClone(turn)
revision = publisher.revisions()[turn.id]
turn.reverted = true
send()
publisher.clear()
assert.equal(publisher.update(turn).kind, 'snapshot')

// 1 MiB response streamed in 1 KiB chunks; report real JSON transport bytes.
const stream = fixture()
stream.items = [{ id: 'text', kind: 'text', text: '' }]
const measured = new TurnPublisher()
measured.update(stream)
const started = performance.now()
let snapshotBytes = 0
let patchBytes = 0
let maxPatchBytes = 0
for (let index = 0; index < 1024; index++) {
  const item = stream.items[0]
  if (item.kind !== 'text') throw new Error('fixture')
  item.text += 'x'.repeat(1024)
  const update = measured.update(stream)
  const bytes = Buffer.byteLength(JSON.stringify(update))
  snapshotBytes += Buffer.byteLength(JSON.stringify(stream))
  patchBytes += bytes
  maxPatchBytes = Math.max(maxPatchBytes, bytes)
}
assert.ok(maxPatchBytes < 1300)
assert.ok(snapshotBytes > patchBytes * 400)
console.log(
  JSON.stringify(
    {
      snapshotBytes,
      patchBytes,
      maxPatchBytes,
      reduction: snapshotBytes / patchBytes,
      elapsedMs: performance.now() - started,
    },
    null,
    2,
  ),
)
console.log(
  'Chat transport checks passed: ordered patches, recovery, mutable items, reset and bounded append payloads.',
)

// Historical turns do not appear in incremental payloads, even in tool-heavy transcripts.
const longPublisher = new TurnPublisher()
const historical = Array.from({ length: 100 }, (_, index) => {
  const previous = fixture()
  previous.id = `history-${index}`
  previous.index = index
  previous.status = 'done'
  previous.items = Array.from({ length: 100 }, (_, itemIndex) => ({
    kind: 'tool' as const,
    id: `tool-${index}-${itemIndex}`,
    title: 'Inspect project files',
    toolKind: 'read',
    status: 'completed' as const,
    locations: ['src/app.ts'],
  }))
  longPublisher.update(previous)
  return previous
})
const active = fixture()
active.id = 'active'
active.index = historical.length
active.items = [{ id: 'answer', kind: 'text', text: 'x'.repeat(1024 * 1024) }]
longPublisher.update(active)
const longStarted = performance.now()
const longSnapshotBytes = Buffer.byteLength(JSON.stringify([...historical, active]))
let longPatchBytes = 0
for (let index = 0; index < 100; index++) {
  active.items.push({
    kind: 'tool',
    id: `new-${index}`,
    title: 'Inspect',
    toolKind: 'read',
    status: 'completed',
    locations: [],
  })
  const update = longPublisher.update(active)
  const bytes = Buffer.byteLength(JSON.stringify(update))
  assert.ok(bytes < 2500)
  longPatchBytes += bytes
}
console.log(
  JSON.stringify(
    {
      scenario: '100 historical turns with 10,000 tools plus 1 MiB active answer',
      longSnapshotBytes,
      updates: 100,
      longPatchBytes,
      elapsedMs: performance.now() - longStarted,
    },
    null,
    2,
  ),
)

// Isolate main-process production from old full-turn JSON work with screenshot payloads.
const screenshotTurn = fixture()
screenshotTurn.preview = {
  before: 'data:image/jpeg;base64,'.concat('s'.repeat(256 * 1024)),
  after: null,
}
screenshotTurn.items = [
  { kind: 'text', id: 'large-answer', text: 'x'.repeat(1024 * 1024) },
  ...Array.from({ length: 100 }, (_, index) => ({
    kind: 'tool' as const,
    id: `measured-tool-${index}`,
    title: 'Inspect',
    toolKind: 'read',
    status: 'completed' as const,
    locations: ['src/app.ts'],
  })),
]
const samples = Array.from({ length: 200 }, (_, index) => ({
  ...screenshotTurn,
  items: [
    {
      kind: 'text' as const,
      id: 'large-answer',
      text: 'x'.repeat(1024 * 1024).concat('y'.repeat(index * 1024)),
    },
    ...screenshotTurn.items.slice(1),
  ],
}))
const cpuPublisher = new TurnPublisher()
cpuPublisher.update(screenshotTurn)
let producerBytes = 0
const producerStarted = performance.now()
for (const sample of samples) {
  producerBytes += Buffer.byteLength(JSON.stringify(cpuPublisher.update(sample)))
}
const producerMs = performance.now() - producerStarted
let originalBytes = 0
const originalStarted = performance.now()
for (const sample of samples) originalBytes += Buffer.byteLength(JSON.stringify(sample))
const originalMs = performance.now() - originalStarted
assert.ok(producerBytes < originalBytes / 100)
console.log(
  JSON.stringify(
    {
      scenario: '200 isolated flushes with 1 MiB answer, 100 tools and 256 KiB screenshot',
      producerMs,
      originalMs,
      producerBytes,
      originalBytes,
    },
    null,
    2,
  ),
)
