import { Worker } from 'node:worker_threads'

interface Job<Input, Output> {
  input: Input
  resolve: (output: Output) => void
  reject: (error: Error) => void
}

/** One bounded queue per expensive task; a stuck worker cannot hold up Electron's UI. */
export class BackgroundWorker<Input, Output> {
  private worker: Worker | null = null
  private queue: Job<Input, Output>[] = []
  private active: Job<Input, Output> | null = null
  private timeout: NodeJS.Timeout | null = null
  private idle: NodeJS.Timeout | null = null

  constructor(
    private readonly url: URL,
    private readonly timeoutMs = 10_000,
    private readonly maxQueued = 32,
  ) {}

  run(input: Input): Promise<Output> {
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new Error('Background work queue is full.'))
    }
    return new Promise((resolve, reject) => {
      // Queued callers may continue mutating their state before this worker is available.
      this.queue.push({ input: structuredClone(input), resolve, reject })
      this.pump()
    })
  }

  private pump() {
    if (this.active || !this.queue.length) return
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    if (!this.worker) {
      let worker: Worker
      try {
        worker = new Worker(this.url, {
          resourceLimits: { maxOldGenerationSizeMb: 192 },
        })
      } catch (error) {
        this.queue.shift()?.reject(error instanceof Error ? error : new Error(String(error)))
        this.pump()
        return
      }
      this.worker = worker
      worker.on('message', (message: { result?: Output; error?: string }) => {
        if (this.worker !== worker || !this.active) return
        if (this.timeout) clearTimeout(this.timeout)
        this.timeout = null
        const job = this.active
        this.active = null
        if (message.error) job.reject(new Error(message.error))
        else job.resolve(message.result as Output)
        worker.unref()
        if (this.queue.length) this.pump()
        else {
          this.idle = setTimeout(() => this.stop(worker), 30_000)
          this.idle.unref()
        }
      })
      worker.on('error', (error) =>
        this.stop(worker, error instanceof Error ? error : new Error(String(error))),
      )
      worker.on('exit', (code) => {
        if (this.worker === worker) {
          this.stop(worker, new Error(`Background worker exited (${code}).`))
        }
      })
    }
    const worker = this.worker
    this.active = this.queue.shift() ?? null
    if (!this.active) return
    // Keep pending persistence alive in CLI tests; idle workers do not keep the app alive.
    worker.ref()
    this.timeout = setTimeout(
      () => this.stop(worker, new Error('Background work timed out.')),
      this.timeoutMs,
    )
    try {
      worker.postMessage(this.active.input)
    } catch (error) {
      this.stop(worker, error instanceof Error ? error : new Error(String(error)))
    }
  }

  private stop(worker: Worker, error?: Error) {
    if (this.worker !== worker) return
    this.worker = null
    if (this.timeout) clearTimeout(this.timeout)
    if (this.idle) clearTimeout(this.idle)
    this.timeout = null
    this.idle = null
    const active = this.active
    this.active = null
    if (active) active.reject(error ?? new Error('Background worker stopped.'))
    void worker.terminate()
    if (this.queue.length) this.pump()
  }
}
