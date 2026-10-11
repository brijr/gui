import { randomUUID } from 'node:crypto'
import { renameSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { writeFileAtomicSync } from './atomic-file'
import { BackgroundWorker } from './background-worker'
import type { SavedChat } from './history'
import {
  type HistoryWriteRequest,
  historyChunks,
  serializeHistory,
  snapshotHistory,
} from './history-format'

const worker = new BackgroundWorker<HistoryWriteRequest, string | null>(
  new URL(
    import.meta.url.endsWith('.ts') ? './history-worker.ts' : './history-worker.js',
    import.meta.url,
  ),
  30_000,
  16,
)
const writers = new Set<HistoryWriter>()

/** App quit's fallback also includes saves from tabs already closed asynchronously. */
export function flushHistorySync() {
  for (const writer of writers) writer.saveSync()
}

/** Coalesces saves; bounded serialization yields to input, while disk writes/fsync run off main. */
export class HistoryWriter {
  private task: Promise<void> | null = null
  private dirty = false
  private closed = false
  private syncFinished = false
  private finalChat: SavedChat | null = null

  constructor(
    private readonly file: string,
    private readonly read: () => SavedChat,
  ) {
    writers.add(this)
  }

  save() {
    if (this.closed) return
    this.dirty = true
    this.start()
  }

  /** Normal tab close: capture final state now, then wait before retiring its history claim. */
  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.finalChat = snapshotHistory(this.read())
      this.dirty = true
    }
    this.start()
    return this.task ?? Promise.resolve()
  }

  /** Last resort at process shutdown; pending older worker results cannot replace it. */
  saveSync() {
    if (this.syncFinished) return
    this.syncFinished = true
    this.closed = true
    this.dirty = false
    try {
      writeFileAtomicSync(this.file, serializeHistory(this.finalChat ?? this.read()))
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
      let tmp: string | null = null
      const id = randomUUID()
      try {
        const snapshot = this.finalChat ?? snapshotHistory(this.read())
        tmp = await worker.run({ action: 'begin', id, file: this.file })
        if (!tmp) throw new Error('History temporary file unavailable.')
        for await (const text of historyChunks(snapshot)) {
          if (this.syncFinished) break
          await worker.run({ action: 'append', id, text })
        }
        await worker.run({ action: this.syncFinished ? 'abort' : 'finish', id })
        // The synchronous check and rename prevent quit's final save being overwritten.
        if (this.syncFinished) await rm(tmp, { force: true })
        else renameSync(tmp, this.file)
      } catch (error) {
        console.error('[gui] failed to save chat history', error)
        if (tmp) {
          await worker.run({ action: 'abort', id }).catch(() => undefined)
          await rm(tmp, { force: true }).catch(() => undefined)
        }
        // Ordinary close must still persist if its worker failed or the bounded queue filled.
        if (this.closed && !this.syncFinished) this.saveSync()
      }
    }
    if (this.closed) writers.delete(this)
  }
}
