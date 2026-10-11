import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SavedChat } from '../src/main/history'
import { serializeHistory } from '../src/main/history-format'
import { HistoryWriter } from '../src/main/history-writer'

/** Synthetic scaling measurement, not a timing assertion or a claim about typical chats. */
async function measure(run: () => unknown | Promise<unknown>) {
  let previous = performance.now()
  let longestTimerGapMs = 0
  const timer = setInterval(() => {
    const now = performance.now()
    longestTimerGapMs = Math.max(longestTimerGapMs, now - previous)
    previous = now
  }, 2)
  await new Promise((resolve) => setTimeout(resolve, 10))
  const start = performance.now()
  await run()
  const elapsedMs = performance.now() - start
  await new Promise((resolve) => setTimeout(resolve, 10))
  clearInterval(timer)
  return { elapsedMs, longestTimerGapMs }
}

const directory = await mkdtemp(join(tmpdir(), 'gui-history-benchmark-'))
try {
  for (const count of [100, 1000]) {
    const chat: SavedChat = {
      version: 1,
      id: '01234567-0123-0123-0123-0123456789ab',
      createdAt: 1,
      agentId: 'claude',
      sessionId: null,
      checkpoints: {},
      redo: null,
      turns: Array.from({ length: count }, (_, index) => ({
        id: `turn-${index}`,
        index,
        prompt: 'Update the interface',
        context: [],
        items: Array.from({ length: 12 }, (_, item) => ({
          id: `item-${item}`,
          kind: 'text' as const,
          text: `Interface implementation context for ${index}/${item}. `.repeat(150),
        })),
        status: 'done',
        error: null,
        startedAt: index,
        endedAt: index + 1,
        changes: null,
        reverted: false,
      })),
    }
    let bytes = 0
    const synchronousSerialization = await measure(() => {
      bytes = Buffer.byteLength(serializeHistory(chat))
    })
    const writer = new HistoryWriter(join(directory, `${count}.json`), () => chat)
    const backgroundSave = await measure(() => writer.close())
    console.log(JSON.stringify({ turns: count, bytes, synchronousSerialization, backgroundSave }))
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
