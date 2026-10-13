import { open } from 'node:fs/promises'
import { parentPort } from 'node:worker_threads'
import type { SavedChat } from './history'
import type { HistoryWorkerRequest, HistoryWorkerResult } from './history-reader'
import { historyReferences, settleHistory } from './history-record'
import { historyStamp, lastMessageFor, sameHistoryStamp, summarizeHistory } from './history-summary'
import { type HistoryPart, historyParts, nextHistoryParts } from './history-transfer'

let loaded: {
  id: string
  source: ReturnType<typeof historyStamp>
  parts: Generator<HistoryPart>
} | null = null

parentPort?.on('message', async (request: HistoryWorkerRequest) => {
  const result = await read(request)
  parentPort?.postMessage({ result })
})

async function read(request: HistoryWorkerRequest): Promise<HistoryWorkerResult> {
  if (request.action === 'release') {
    if (loaded?.id === request.id) loaded = null
    return { status: 'missing' }
  }
  if (request.action === 'next') {
    if (!loaded || loaded.id !== request.id)
      return { status: 'error', kind: 'worker', message: 'Chat history read ended.' }
    const next = nextHistoryParts(loaded.parts)
    const result: HistoryWorkerResult = {
      status: 'ok',
      action: 'load',
      source: loaded.source,
      ...next,
    }
    if (next.done) loaded = null
    return result
  }
  let text: string
  let source: ReturnType<typeof historyStamp>
  try {
    const handle = await open(request.file, 'r')
    try {
      source = historyStamp(await handle.stat())
      text = await handle.readFile('utf8')
      if (!sameHistoryStamp(source, historyStamp(await handle.stat())))
        throw new Error('Chat history changed during its read.')
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
    return { status: 'error', kind: 'read', message: String(error) }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (request.action === 'references') {
      return {
        status: 'ok',
        action: 'references',
        source,
        references: historyReferences(parsed),
      }
    }
    if (request.action === 'recent') {
      const saved = parsed as Partial<SavedChat> | null
      if (saved?.version !== 1 || !Array.isArray(saved.turns)) throw new Error('unknown format')
      return { status: 'ok', action: 'recent', source, recent: lastMessageFor(saved) }
    }
    const chat = settleHistory(parsed)
    if (request.action === 'summary')
      return { status: 'ok', action: 'summary', source, summary: summarizeHistory(chat) }
    const parts = historyParts(chat)
    const next = nextHistoryParts(parts)
    loaded = next.done ? null : { id: request.id ?? '', source, parts }
    return { status: 'ok', action: 'load', source, ...next }
  } catch (error) {
    return { status: 'error', kind: 'parse', message: String(error), source }
  }
}
