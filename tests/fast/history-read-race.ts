// Isolated process: exercise the actual worker reader with controlled filesystem failures.
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SavedChat } from '../../src/main/history'
import type { HistoryWorkerRequest, HistoryWorkerResult } from '../../src/main/history-reader'

const nativeFs = { ...fs }
const root = await nativeFs.mkdtemp(join(tmpdir(), 'gui-history-read-race-'))
let control: { file: string; mode: 'open' | 'read' | 'changed'; attempts: number } | null = null
const failures: HistoryWorkerResult[] = []
let reader!: (request: HistoryWorkerRequest) => Promise<HistoryWorkerResult>

const chat = (prompt: string): SavedChat => ({
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
    },
  ],
})

async function replace(file: string) {
  const tmp = `${file}.replacement.tmp`
  await nativeFs.writeFile(tmp, JSON.stringify(chat('Newer replacement')))
  await nativeFs.rename(tmp, file)
}

mock.module('node:fs/promises', () => ({
  ...nativeFs,
  open: (async (file, flags, mode) => {
    const scenario = control?.file === file ? control : null
    if (scenario?.mode === 'open' && ++scenario.attempts <= 3) {
      if (scenario.attempts === 3) await replace(scenario.file)
      throw Object.assign(new Error('Transient open failure'), { code: 'EIO' })
    }
    const handle = await nativeFs.open(file, flags, mode)
    if (!scenario || scenario.mode === 'open') return handle
    return {
      stat: () => handle.stat(),
      close: () => handle.close(),
      readFile: async (...args: Parameters<typeof handle.readFile>) => {
        const attempt = ++scenario.attempts
        if (attempt > 3) return handle.readFile(...args)
        if (scenario.mode === 'changed') {
          const text = await handle.readFile(...args)
          // Change the opened inode, then replace the pathname on the final read attempt.
          await nativeFs.writeFile(file, JSON.stringify(chat(`Interrupted ${'x'.repeat(attempt)}`)))
          if (attempt === 3) await replace(scenario.file)
          return text
        }
        if (attempt === 3) await replace(scenario.file)
        throw Object.assign(new Error('Transient read failure'), { code: 'EIO' })
      },
    } as fs.FileHandle
  }) as typeof fs.open,
}))
mock.module('electron', () => ({ app: { getPath: () => root } }))
mock.module('../../src/main/background-worker', () => ({
  BackgroundWorker: class {
    async run(request: HistoryWorkerRequest) {
      const result = await reader(request)
      if (result.status === 'error') failures.push(result)
      return result
    }
  },
}))

const { readHistoryInWorker } = await import('../../src/main/history-read-worker')
reader = readHistoryInWorker
const { loadHistory } = await import('../../src/main/history')
const logged: unknown[][] = []
const logError = console.error
console.error = (...args: unknown[]) => logged.push(args)

try {
  for (const mode of ['read', 'changed'] as const) {
    const file = join(root, `${mode}.json`)
    await nativeFs.writeFile(file, JSON.stringify(chat('Original')))
    const original = await nativeFs.stat(file)
    failures.length = 0
    control = { file, mode, attempts: 0 }
    const loaded = await loadHistory(file)
    assert.equal(loaded?.turns[0].prompt, 'Newer replacement')
    assert.equal(
      JSON.parse(await nativeFs.readFile(file, 'utf8')).turns[0].prompt,
      'Newer replacement',
    )
    assert.equal(failures.length, 3)
    assert.ok(
      failures.every((result) => result.status === 'error' && result.source?.ino === original.ino),
    )
    assert.equal(
      (await nativeFs.readdir(root)).some((name) => name.startsWith(`${mode}.corrupt-`)),
      false,
    )
  }

  const unknown = join(root, 'unknown.json')
  await nativeFs.writeFile(unknown, JSON.stringify(chat('Original')))
  control = { file: unknown, mode: 'open', attempts: 0 }
  await assert.rejects(loadHistory(unknown), /file was kept/)
  assert.equal(
    JSON.parse(await nativeFs.readFile(unknown, 'utf8')).turns[0].prompt,
    'Newer replacement',
  )
  assert.equal(
    (await nativeFs.readdir(root)).some((name) => name.startsWith('unknown.corrupt-')),
    false,
  )

  control = null
  const malformed = join(root, 'malformed.json')
  await nativeFs.writeFile(malformed, '{malformed')
  assert.equal(await loadHistory(malformed), null)
  assert.equal(await nativeFs.stat(malformed).catch(() => null), null)
  const recovery = (await nativeFs.readdir(root)).find((name) =>
    name.startsWith('malformed.corrupt-'),
  )
  assert.ok(recovery)
  assert.equal(await nativeFs.readFile(join(root, recovery), 'utf8'), '{malformed')
  assert.equal(logged.length, 1)
  console.log('History read stamps, replacement retention and malformed recovery passed.')
} finally {
  control = null
  console.error = logError
  await nativeFs.rm(root, { recursive: true, force: true })
}
