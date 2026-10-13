import { randomUUID } from 'node:crypto'
import { renameSync } from 'node:fs'
import { open, rm, stat } from 'node:fs/promises'
import type { ChatSummary } from '../shared/types'
import { writeTemp } from './atomic-file'
import { BackgroundWorker } from './background-worker'
import type { SavedChat } from './history'
import {
  type HistoryStamp,
  historyStamp,
  isLiveSummary,
  type LastMessage,
  type LiveSummary,
  sameHistoryStamp,
  summaryFile,
} from './history-summary'
import { applyHistoryParts, type HistoryPart } from './history-transfer'

export interface HistoryReadRequest {
  action: 'load' | 'recent' | 'summary' | 'references'
  file: string
}

export type HistoryReadResult =
  | { status: 'missing' }
  | { status: 'error'; kind: 'read' | 'parse' | 'worker'; message: string; source?: HistoryStamp }
  | ({ status: 'ok'; source: HistoryStamp } & (
      | { action: 'load'; chat: SavedChat }
      | { action: 'recent'; recent: LastMessage | null }
      | { action: 'summary'; summary: ChatSummary | null }
      | { action: 'references'; references: { checkpoints: string[]; recordings: string[] } }
    ))

export type HistoryWorkerRequest =
  | (HistoryReadRequest & { id?: string })
  | { action: 'next'; id: string }
  | { action: 'release'; id: string }

export type HistoryWorkerResult =
  | Exclude<HistoryReadResult, { action: 'load' }>
  | {
      status: 'ok'
      action: 'load'
      source: HistoryStamp
      parts: HistoryPart[]
      done: boolean
    }

// Read jobs carry paths; raw JSON and temporary parse state never cross into main.
const worker = new BackgroundWorker<HistoryWorkerRequest, HistoryWorkerResult>(
  new URL(
    import.meta.url.endsWith('.ts') ? './history-read-worker.ts' : './history-read-worker.js',
    import.meta.url,
  ),
  30_000,
  32,
  384,
)

// One complete read at a time: other parses cannot multiply the heap retained by a full load.
let pendingRead: Promise<unknown> = Promise.resolve()
let queuedReads = 0

async function loadInChunks(file: string): Promise<HistoryReadResult> {
  const id = randomUUID()
  let chat: unknown
  try {
    let result = await worker.run({ action: 'load', id, file })
    while (result.status === 'ok' && result.action === 'load') {
      chat = applyHistoryParts(chat, result.parts)
      if (result.done)
        return { status: 'ok', action: 'load', source: result.source, chat: chat as SavedChat }
      await new Promise<void>((resolve) => setImmediate(resolve))
      result = await worker.run({ action: 'next', id })
    }
    return result as HistoryReadResult
  } finally {
    await worker.run({ action: 'release', id }).catch(() => undefined)
  }
}

export function readHistory(request: HistoryReadRequest): Promise<HistoryReadResult> {
  if (queuedReads >= 32)
    return Promise.resolve({
      status: 'error',
      kind: 'worker',
      message: 'History read queue is full.',
    })
  queuedReads++
  const task = pendingRead.then(() => readWithRetries(request))
  const completion = task.finally(() => queuedReads--)
  pendingRead = completion.catch(() => undefined)
  return completion
}

/** Preserve the existing retry policy for transient filesystem errors. */
async function readWithRetries(request: HistoryReadRequest): Promise<HistoryReadResult> {
  for (let attempt = 1; ; attempt++) {
    const result = await (request.action === 'load'
      ? loadInChunks(request.file)
      : worker.run(request).then((result): HistoryReadResult => {
          if (result.status === 'ok' && result.action === 'load')
            throw new Error('Unexpected full history response.')
          return result
        })
    ).catch(
      (error: unknown): HistoryReadResult => ({
        status: 'error',
        kind: 'worker',
        message: error instanceof Error ? error.message : String(error),
      }),
    )
    if (result.status !== 'error' || result.kind === 'parse' || attempt === 3) return result
    await new Promise((resolve) => setTimeout(resolve, 100 * attempt))
  }
}

async function storedSummary(file: string): Promise<LiveSummary | null> {
  const handle = await open(summaryFile(file), 'r')
  try {
    // A damaged/edited sidecar must never turn this into an unbounded main-thread parse.
    const buffer = Buffer.alloc(4097)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 4096) return null
    const parsed: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
    if (!isLiveSummary(parsed)) return null
    return sameHistoryStamp(parsed.source, historyStamp(await stat(file))) ? parsed : null
  } finally {
    await handle.close()
  }
}

/** Coalesce start-screen refreshes, including a legacy file's one-time summary migration. */
const summaryReads = new Map<string, Promise<LastMessage | null>>()

export function readLastMessage(file: string): Promise<LastMessage | null> {
  const pending = summaryReads.get(file)
  if (pending) return pending
  const task = readOrCreateSummary(file).finally(() => summaryReads.delete(file))
  summaryReads.set(file, task)
  return task
}

async function readOrCreateSummary(file: string, attempt = 1): Promise<LastMessage | null> {
  const stored = await storedSummary(file).catch(() => null)
  if (stored) return stored.recent
  const result = await readHistory({ action: 'recent', file })
  if (result.status !== 'ok' || result.action !== 'recent') return null
  const summary: LiveSummary = { version: 1, source: result.source, recent: result.recent }
  let tmp: string | null = null
  try {
    tmp = await writeTemp(summaryFile(file), JSON.stringify(summary))
    const source = historyStamp(await stat(file))
    // No await between checking and committing: a newer in-process save wins this race.
    if (sameHistoryStamp(source, result.source)) renameSync(tmp, summaryFile(file))
    else return attempt < 3 ? readOrCreateSummary(file, attempt + 1) : null
  } catch {
    // A summary is optional for recovery/read-only files; leave their history alone.
  } finally {
    if (tmp) await rm(tmp, { force: true }).catch(() => undefined)
  }
  return result.recent
}
