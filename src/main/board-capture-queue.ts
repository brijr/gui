export const CAPTURE_PRIORITY = { background: 0, visible: 1, interactive: 2 } as const

export interface CaptureJob<T> {
  done: Promise<T | null>
  cancel(): void
  promote(priority: number): void
}

interface PendingJob {
  priority: number
  run(): Promise<void>
}

/** All boards share this budget; requested screenshots can pass queued thumbnails. */
export class BoardCaptureQueue {
  private pending: PendingJob[] = []
  private active = 0
  private pumping = false

  constructor(private readonly concurrency = 1) {
    if (concurrency < 1) throw new Error('Capture concurrency must be positive')
  }

  schedule<T>(priority: number, run: (signal: AbortSignal) => Promise<T>): CaptureJob<T> {
    const abort = new AbortController()
    let finish!: (result: T | null) => void
    let fail!: (error: unknown) => void
    const done = new Promise<T | null>((resolve, reject) => {
      finish = resolve
      fail = reject
    })
    const job: PendingJob = {
      priority,
      run: async () => {
        try {
          const result = await run(abort.signal)
          finish(abort.signal.aborted ? null : result)
        } catch (error) {
          if (abort.signal.aborted) finish(null)
          else fail(error)
        }
      },
    }
    this.pending.push(job)
    this.pumpSoon()
    return {
      done,
      cancel: () => {
        abort.abort()
        const index = this.pending.indexOf(job)
        if (index < 0) return
        this.pending.splice(index, 1)
        finish(null)
      },
      promote: (priority) => {
        job.priority = Math.max(priority, job.priority)
      },
    }
  }

  private pumpSoon() {
    if (this.pumping) return
    this.pumping = true
    queueMicrotask(() => {
      this.pumping = false
      while (this.active < this.concurrency && this.pending.length) {
        // Stable sort preserves FIFO order among jobs of the same priority.
        this.pending.sort((a, b) => b.priority - a.priority)
        const next = this.pending.shift()
        if (!next) break
        this.active++
        void next.run().finally(() => {
          this.active--
          this.pumpSoon()
        })
      }
    })
  }
}

export const boardCaptureQueue = new BoardCaptureQueue()
