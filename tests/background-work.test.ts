import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceMapGenerator } from 'source-map-js'
import { BackgroundWorker } from '../src/main/background-worker'
import type { SavedChat } from '../src/main/history'
import { readLastMessage } from '../src/main/history-reader'
import { HistoryWriter } from '../src/main/history-writer'
import { resolveFrame } from '../src/main/source-resolver'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'gui-background-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

function chat(prompt: string): SavedChat {
  return {
    version: 1,
    id: '01234567-0123-0123-0123-0123456789ab',
    createdAt: 1,
    agentId: 'claude',
    sessionId: null,
    checkpoints: {},
    redo: null,
    turns: [
      {
        id: 'turn-1',
        index: 0,
        prompt,
        context: [],
        items: [],
        status: 'done',
        error: null,
        reverted: false,
        startedAt: 1,
        endedAt: 2,
        changes: null,
        preview: null,
      },
    ],
  }
}

test('normal history close saves final state before completing and cannot be changed later', async () => {
  const root = await directory()
  const file = join(root, 'history.json')
  let state = chat('initial')
  const writer = new HistoryWriter(file, () => state)
  writer.save()
  state = chat('final')
  const completion = writer.close()
  state.turns[0].prompt = 'too late'
  writer.save()
  await completion
  expect(JSON.parse(await readFile(file, 'utf8')).turns[0].prompt).toBe('final')
  expect((await readdir(root)).sort()).toEqual(['history.json', 'history.summary.json'])
  expect(await readLastMessage(file)).toEqual({ prompt: 'final', at: 1 })
})

test('shutdown final save wins over an older worker write and repeated disposal', async () => {
  const root = await directory()
  const file = join(root, 'history.json')
  let state = chat('older background state')
  const writer = new HistoryWriter(file, () => state)
  writer.save()
  state = chat('shutdown final state')
  writer.saveSync()
  await writer.close()
  // Let the older worker result return and be discarded before checking.
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(JSON.parse(await readFile(file, 'utf8')).turns[0].prompt).toBe('shutdown final state')
  expect((await readdir(root)).sort()).toEqual(['history.json', 'history.summary.json'])
  expect(await readLastMessage(file)).toEqual({ prompt: 'shutdown final state', at: 1 })
})

test('worker source maps resolve precise positions and preserve approximate fallback', async () => {
  const root = await directory()
  await writeFile(join(root, 'view.tsx'), '<button />')
  const map = new SourceMapGenerator({ file: 'bundle.js' })
  map.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 7, column: 3 },
    source: './view.tsx',
  })
  const server = createServer((request, response) => {
    if (request.url === '/bundle.js') {
      response.end('render();\n//# sourceMappingURL=bundle.js.map')
    } else if (request.url === '/bundle.js.map') response.end(map.toString())
    else if (request.url === '/bad.js') response.end('render();\n//# sourceMappingURL=bad.map')
    else if (request.url === '/bad.map') response.end('{broken JSON')
    else response.end('source without a map')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.unshift(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No HTTP listener')
  const origin = `http://127.0.0.1:${address.port}`
  expect(
    await resolveFrame({ url: `${origin}/bundle.js`, line: 1, column: 1 }, root, origin),
  ).toEqual({ file: 'view.tsx', line: 7, column: 4, approximate: false })
  expect(
    await resolveFrame({ url: `${origin}/bad.js`, line: 1, column: 1 }, root, origin),
  ).toBeNull()
  expect(
    await resolveFrame({ url: `${origin}/view.tsx`, line: 2, column: 1 }, root, origin),
  ).toEqual({ file: 'view.tsx', line: 2, approximate: true })
  expect(
    await resolveFrame(
      { url: `${origin}/bundle.js`, line: 1, column: 1 },
      root,
      'http://localhost:9',
    ),
  ).toBeNull()
})

test('bounded worker queue freezes input and recovers after a failed job', async () => {
  const worker = new BackgroundWorker<{ value: string; wait?: number; fail?: boolean }, string>(
    new URL('./fixtures/background-worker.ts', import.meta.url),
    1000,
    1,
  )
  const first = worker.run({ value: 'first', wait: 20 })
  const queued = { value: 'captured' }
  const second = worker.run(queued)
  queued.value = 'mutated'
  await expect(worker.run({ value: 'overflow' })).rejects.toThrow('queue is full')
  expect(await first).toBe('first')
  expect(await second).toBe('captured')
  await expect(worker.run({ value: '', fail: true })).rejects.toThrow('Fixture failure')
  expect(await worker.run({ value: 'restarted' })).toBe('restarted')
})

test('a stuck worker times out without blocking subsequent work', async () => {
  const worker = new BackgroundWorker<{ value: string; wait?: number }, string>(
    new URL('./fixtures/background-worker.ts', import.meta.url),
    1000,
  )
  await expect(worker.run({ value: 'stuck', wait: -1 })).rejects.toThrow('timed out')
  expect(await worker.run({ value: 'after timeout' })).toBe('after timeout')
})

test('bounded history chunks preserve JSON escaping and nested snapshot immutability', async () => {
  const { historyChunks, serializeHistory, snapshotHistory } = await import(
    '../src/main/history-format'
  )
  const state = chat('Unicode 😀 and controls \n\t\\"'.repeat(2000))
  state.checkpoints = JSON.parse('{"__proto__":{"before":"sha","after":null}}')
  state.turns[0].items = [
    { id: 'item', kind: 'text', text: 'mutable container with immutable text' },
  ]
  const snapshot = snapshotHistory(state)
  const expected = JSON.parse(serializeHistory(state))
  state.turns[0].prompt = 'later'
  state.turns[0].items[0] = { id: 'item', kind: 'text', text: 'later item' }
  const chunks: string[] = []
  for await (const chunk of historyChunks(snapshot, 1024)) chunks.push(chunk)
  expect(chunks.length).toBeGreaterThan(1)
  expect(JSON.parse(chunks.join(''))).toEqual(expected)
})
