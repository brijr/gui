import { renameSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { writeFileAtomicSync, writeTemp } from './atomic-file'

/** The disk under a `CoalescedFile`; the fast tests put a fake here. */
export interface FileLayer {
  /** Writes `text` to a flushed temp file beside the real one, off the main thread. */
  writeTemp(text: string): Promise<string>
  /** Puts a temp file in the real one's place: a rename, with no flush to wait for. */
  replace(tmp: string): void
  /** Drops a temp file that won't be used, before the next one is written. */
  discard(tmp: string): Promise<void>
  /** The whole write on the calling thread, for quit. */
  writeSync(text: string): void
}

export const diskFile = (file: () => string): FileLayer => ({
  // One temp name: a write that quit overtook leaves at most that one file, for the next to replace.
  writeTemp: (text) => writeTemp(file(), text, true),
  replace: (tmp) => renameSync(tmp, file()),
  discard: (tmp) => rm(tmp, { force: true }).catch(() => undefined),
  writeSync: (text) => writeFileAtomicSync(file(), text),
})

/**
 * Saves a small file that changes often without the main thread waiting on the disk. A write
 * starts as soon as the code that made the change returns, so changes made together are one
 * write and nothing waits on a timer. One write runs at a time and each takes the text as it
 * is when it starts, so an older one can't land after a newer one. A failed write is reported
 * and tried again with the next change, or at quit, where `flushSync` writes whatever the file
 * doesn't hold yet.
 */
export class CoalescedFile {
  /** A write was asked for and hasn't started */
  private dirty = false
  /** The text changed since the last write started, or that write failed */
  private unsaved = false
  private task: Promise<void> | null = null
  /** The write on its way to the file; null once it's there, or once `flushSync` wrote over it */
  private landing: object | null = null

  constructor(
    private readonly read: () => string,
    private readonly files: FileLayer,
    private readonly failed: (error: unknown) => void,
  ) {}

  /** What `read` returns changed. */
  changed() {
    this.unsaved = true
    if (this.dirty) return
    this.dirty = true
    queueMicrotask(() => this.start())
  }

  /**
   * At quit: nothing after this would finish a write, so what the file doesn't hold is
   * written here. A write still on its way is older than this one, and is dropped.
   */
  flushSync() {
    if (!this.unsaved && !this.landing) return
    this.landing = null
    this.dirty = false
    this.unsaved = false
    try {
      this.files.writeSync(this.read())
    } catch (error) {
      this.unsaved = true
      this.failed(error)
    }
  }

  private start() {
    if (this.task || !this.dirty) return
    this.task = this.drain().finally(() => {
      this.task = null
      if (this.dirty) this.start()
    })
  }

  private async drain() {
    while (this.dirty) {
      this.dirty = false
      this.unsaved = false
      const write = {}
      this.landing = write
      let tmp: string | null = null
      try {
        tmp = await this.files.writeTemp(this.read())
        // No async gap between this check and the rename: a flush can't come between them.
        if (this.landing === write) {
          this.files.replace(tmp)
          tmp = null
        }
      } catch (error) {
        // One a flush overtook no longer matters: the file already holds something newer.
        if (this.landing === write) {
          this.unsaved = true
          this.failed(error)
        }
      } finally {
        if (this.landing === write) this.landing = null
        if (tmp) await this.files.discard(tmp)
      }
    }
  }
}
