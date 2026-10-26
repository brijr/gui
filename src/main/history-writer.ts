import { randomUUID } from 'node:crypto'
import { renameSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { writeFileAtomicSync } from './atomic-file'
import { BackgroundWorker } from './background-worker'
import type { SavedChat } from './history'
import {
  type HistoryWriteRequest,
  type HistoryWriteResult,
  historyChunks,
  serializeHistory,
  snapshotHistory,
} from './history-format'
import { historyStamp, type LiveSummary, lastMessageFor, summaryFile } from './history-summary'

const worker = new BackgroundWorker<HistoryWriteRequest, HistoryWriteResult>(
  new URL(
    import.meta.url.endsWith('.ts') ? './history-worker.ts' : './history-worker.js',
    import.meta.url,
  ),
  30_000,
  16,
)
const writers = new Set<HistoryWriter>()

/** Archive snapshots use the same yielding serialization and bounded disk worker as live saves. */
export function writeHistorySnapshot(file: string, snapshot: SavedChat) {
  return persistSnapshot(file, snapshot, false, () => false)
}

async function persistSnapshot(
  file: string,
  snapshot: SavedChat,
  withSummary: boolean,
  stopped: () => boolean,
) {
  const id = randomUUID()
  let tmp: string | null = null
  let summary: string | null = null
  try {
    tmp = (await worker.run({ action: 'begin', id, file }))?.file ?? null
    if (!tmp) throw new Error('History temporary file unavailable.')
    for await (const text of historyChunks(snapshot)) {
      if (stopped()) break
      await worker.run({ action: 'append', id, text })
    }
    const finished = await worker.run(
      stopped()
        ? { action: 'abort', id }
        : { action: 'finish', id, ...(withSummary ? { recent: lastMessageFor(snapshot) } : {}) },
    )
    summary = finished?.summary ?? null
    // No async gap between the final-save guard and either rename.
    if (!stopped()) {
      renameSync(tmp, file)
      tmp = null
      if (summary) {
        renameSync(summary, summaryFile(file))
        summary = null
      }
    }
  } finally {
    if (tmp) {
      await worker.run({ action: 'abort', id }).catch(() => undefined)
      await rm(tmp, { force: true }).catch(() => undefined)
    }
    if (summary) await rm(summary, { force: true }).catch(() => undefined)
  }
}

/** App quit's fallback also includes saves from tabs already closed asynchronously. */
export function flushHistorySync() {
  for (const writer of writers) writer.saveSync()
}

/**
 * Coalesces saves; bounded serialization yields to input, while disk writes/fsync run off main.
 * A chat with nothing unsaved isn't written again when it closes or Gui quits.
 */
export class HistoryWriter {
  private task: Promise<void> | null = null
  /** A save was asked for and hasn't started */
  private dirty = false
  /** The chat changed since the last write that started, or that write failed */
  private unsaved: boolean
  private closed = false
  private syncFinished = false
  private finalChat: SavedChat | null = null

  /** `saved`: the file already holds what `read` returns (the chat was just loaded from it). */
  constructor(
    private readonly file: string,
    private readonly read: () => SavedChat,
    { saved = false }: { saved?: boolean } = {},
  ) {
    this.unsaved = !saved
    writers.add(this)
  }

  /** The chat changed, and a save will follow; until it's done, close and quit write it. */
  changed() {
    this.unsaved = true
  }

  save() {
    if (this.closed) return
    this.unsaved = true
    this.dirty = true
    this.start()
  }

  /** The file may not hold the chat as it is: it changed, or a write is still under way. */
  private get pending() {
    return this.unsaved || this.task !== null
  }

  /** Normal tab close: capture final state now, then wait before retiring its history claim. */
  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      if (this.pending) {
        this.finalChat = snapshotHistory(this.read())
        this.dirty = true
      }
    }
    this.start()
    if (!this.task) writers.delete(this)
    return this.task ?? Promise.resolve()
  }

  /**
   * Last resort at process shutdown; pending older worker results cannot replace it. A chat
   * already on disk as it is isn't written again.
   */
  saveSync() {
    if (this.syncFinished) return
    this.syncFinished = true
    this.closed = true
    this.dirty = false
    if (!this.pending) {
      writers.delete(this)
      return
    }
    try {
      const saved = this.finalChat ?? this.read()
      writeFileAtomicSync(this.file, serializeHistory(saved))
      const summary: LiveSummary = {
        version: 1,
        source: historyStamp(statSync(this.file)),
        recent: lastMessageFor(saved),
      }
      writeFileAtomicSync(summaryFile(this.file), JSON.stringify(summary))
    } catch (error) {
      console.error('[gui] failed to save chat history', error)
    }
    writers.delete(this)
  }

  private start() {
    if (this.task || !this.dirty || this.syncFinished) return
    this.task = this.drain().finally(() => {
      this.task = null
      if (this.dirty && !this.syncFinished) this.start()
    })
  }

  private async drain() {
    while (this.dirty && !this.syncFinished) {
      this.dirty = false
      this.unsaved = false
      try {
        const snapshot = this.finalChat ?? snapshotHistory(this.read())
        await persistSnapshot(this.file, snapshot, true, () => this.syncFinished)
      } catch (error) {
        this.unsaved = true
        console.error('[gui] failed to save chat history', error)
        // Ordinary close must still persist if its worker failed or the bounded queue filled.
        if (this.closed && !this.syncFinished) this.saveSync()
      }
    }
    if (this.closed) writers.delete(this)
  }
}
