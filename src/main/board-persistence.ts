import type { BoardManifest } from '../shared/board'

/** File-backed board operations share a lane with file watcher reconciliation. */
export class BoardMutations {
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Canvas closed'))
    const result = this.tail.then(operation)
    // A failed operation must not prevent later operations, or final persistence.
    this.tail = result.catch(() => undefined)
    return result
  }

  close(): Promise<unknown> {
    this.closed = true
    return this.tail
  }
}

interface Snapshot {
  text: string
  manifest: BoardManifest
}

/** Atomic replacement needs ordering too: one write, followed by the newest pending state. */
export class BoardManifestWriter {
  private written = ''
  private pending: Snapshot | null = null
  private writing: Snapshot | null = null
  private running: Promise<void> | null = null
  private revision = 0

  constructor(private readonly write: (manifest: BoardManifest) => Promise<void>) {}

  get generation() {
    return this.revision
  }

  invalidate() {
    if (this.running) throw new Error('Cannot invalidate a manifest during a write')
    this.written = ''
  }

  /** The actual file just read, before a camera or file reconciliation changes it. */
  observe(manifest: BoardManifest) {
    if (this.running) throw new Error('Cannot adopt a manifest during a write')
    this.written = JSON.stringify(manifest)
    this.pending = null
    this.revision++
  }

  owns(manifest: BoardManifest) {
    const text = JSON.stringify(manifest)
    return text === this.written || text === this.writing?.text
  }

  idle(): Promise<void> {
    return this.running ?? Promise.resolve()
  }

  save(manifest: BoardManifest): Promise<void> {
    const text = JSON.stringify(manifest)
    if (!this.running && !this.pending && text === this.written) return Promise.resolve()
    // This small snapshot (at most 60 frame layouts) cannot change under an in-flight write.
    this.pending = { text, manifest: JSON.parse(text) as BoardManifest }
    if (!this.running) {
      this.running = Promise.resolve().then(() => this.flush())
    }
    return this.running
  }

  private async flush() {
    try {
      while (this.pending) {
        const snapshot = this.pending
        this.pending = null
        if (snapshot.text === this.written) continue
        this.writing = snapshot
        try {
          await this.write(snapshot.manifest)
          this.written = snapshot.text
          this.revision++
        } catch (error) {
          // Retain the newest requested state. An unchanged retry must still write it.
          this.pending ??= snapshot
          throw error
        } finally {
          this.writing = null
        }
      }
    } finally {
      // Clear ownership before resolving: a save in a completion callback starts a new drain.
      this.running = null
    }
  }
}
