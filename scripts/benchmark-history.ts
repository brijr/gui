import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SavedChat } from '../src/main/history'
import { serializeHistory, snapshotHistory } from '../src/main/history-format'
import { readHistory, readLastMessage } from '../src/main/history-reader'
import { summaryFile } from '../src/main/history-summary'
import { HistoryWriter, writeHistorySnapshot } from '../src/main/history-writer'

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
    const file = join(directory, `${count}.json`)
    const writer = new HistoryWriter(file, () => chat)
    const backgroundSave = await measure(() => writer.close())
    const summaryBytes = (await stat(summaryFile(file))).size
    const summaryRead = await measure(async () => {
      if (!(await readLastMessage(file))) throw new Error('Saved summary unavailable.')
    })
    await rm(summaryFile(file))
    const summaryMigration = await measure(async () => {
      if (!(await readLastMessage(file))) throw new Error('Legacy summary unavailable.')
    })
    const backgroundLoad = await measure(async () => {
      const result = await readHistory({ action: 'load', file })
      if (result.status !== 'ok' || result.action !== 'load' || result.chat.turns.length !== count)
        throw new Error('History did not load completely.')
    })
    const archive = join(directory, `${count}-archived.json`)
    const archiveSnapshot = await measure(() =>
      writeHistorySnapshot(archive, snapshotHistory(chat)),
    )
    const archiveSummary = await measure(async () => {
      const result = await readHistory({ action: 'summary', file: archive })
      if (result.status !== 'ok' || result.action !== 'summary' || result.summary?.turns !== count)
        throw new Error('Archive summary unavailable.')
    })
    console.log(
      JSON.stringify({
        turns: count,
        bytes,
        summaryBytes,
        synchronousSerialization,
        backgroundSave,
        summaryRead,
        summaryMigration,
        backgroundLoad,
        archiveSnapshot,
        archiveSummary,
      }),
    )
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
