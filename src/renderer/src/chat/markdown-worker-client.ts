import { MARKDOWN_NODE_BUDGET, type MarkdownBlock, type MarkdownUpdate } from './markdown-model'

export interface MarkdownDisplay {
  blocks: MarkdownBlock[]
  tail: MarkdownBlock | null
  raw: string
  complete: boolean
}

/** One parser worker per chat view, with at most one outstanding request per mounted item. */
let worker: Worker | null = null
let nextId = 0
let nextOwner = 0
const owners = new Set<number>()
const replies = new Map<
  number,
  { owner: number; callback: (result: MarkdownUpdate | null) => void }
>()

function stopWorker() {
  worker?.terminate()
  worker = null
}

function parse(
  owner: number,
  text: string,
  live: boolean,
  callback: (result: MarkdownUpdate | null) => void,
) {
  try {
    if (!worker) {
      worker = new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<{ id: number; result: MarkdownUpdate | null }>) => {
        const pending = replies.get(event.data.id)
        replies.delete(event.data.id)
        pending?.callback(event.data.result)
      }
      worker.onerror = () => {
        stopWorker()
        const pending = [...replies.values()]
        replies.clear()
        for (const reply of pending) reply.callback(null)
      }
    }
    const id = ++nextId
    replies.set(id, { owner, callback })
    worker.postMessage({ owner, id, text, live })
  } catch {
    callback(null)
  }
}

export function markdownCadence(size: number) {
  return size <= 16_384 ? 32 : size <= 65_536 ? 100 : 200
}

/** Reuse settled trees, and replace final content in bounded batches between input frames. */
export class MarkdownRequest {
  private readonly owner = ++nextOwner
  private latest = { text: '', live: true }
  private display: MarkdownDisplay = { blocks: [], tail: null, raw: '', complete: false }
  private timer: ReturnType<typeof setTimeout> | null = null
  private paint: number | null = null
  private inFlight = false
  private dirty = false
  private disposed = false
  private lastRequest = Number.NEGATIVE_INFINITY

  constructor(private changed: (display: MarkdownDisplay) => void) {
    owners.add(this.owner)
  }

  update(text: string, live: boolean) {
    this.latest = { text, live }
    this.dirty = true
    if (this.paint !== null) cancelAnimationFrame(this.paint)
    this.paint = null
    // A final parse shouldn't wait behind a live-cadence timer.
    if (!live && this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.schedule()
  }

  private schedule() {
    if (this.disposed || this.inFlight || this.timer !== null || !this.dirty) return
    const delay = this.latest.live
      ? Math.max(0, this.lastRequest + markdownCadence(this.latest.text.length) - performance.now())
      : 0
    this.timer = setTimeout(() => {
      this.timer = null
      this.inFlight = true
      this.dirty = false
      this.lastRequest = performance.now()
      const requested = this.latest
      parse(this.owner, requested.text, requested.live, (result) => {
        this.inFlight = false
        if (this.disposed) return
        // An append can use an earlier result. A replacement must wait for its own parse.
        if (this.latest.text.startsWith(requested.text)) {
          if (!result)
            this.publish({ blocks: [], tail: null, raw: this.latest.text, complete: true })
          else if (result.complete && requested.text === this.latest.text && !this.latest.live) {
            this.finish(result.blocks, requested.text)
          } else if (!result.complete) {
            this.publish({
              blocks: result.reset ? result.blocks : [...this.display.blocks, ...result.blocks],
              tail: result.tail,
              raw: result.raw,
              complete: false,
            })
          }
        }
        this.schedule()
      })
    }, delay)
  }

  private publish(display: MarkdownDisplay) {
    this.display = display
    this.changed(display)
  }

  private finish(blocks: MarkdownBlock[], source: string) {
    const before = this.display.blocks
    const drawn: MarkdownBlock[] = []
    for (let index = 0; index < blocks.length; index++) {
      if (before[index]?.key !== blocks[index].key) break
      drawn.push(before[index])
    }
    let index = 0
    const step = () => {
      if (this.disposed) return
      let budget = MARKDOWN_NODE_BUDGET
      while (index < blocks.length && budget > 0) {
        const next = blocks[index]
        const old = before[index]
        drawn[index] = old?.key === next.key && old.signature === next.signature ? old : next
        budget -= old === drawn[index] ? 1 : next.nodes
        index++
      }
      const complete = index === blocks.length
      this.publish({
        blocks: drawn.slice(),
        tail: null,
        raw: complete ? '' : source.slice(drawn.at(-1)?.end ?? 0),
        complete,
      })
      this.paint = complete ? null : requestAnimationFrame(step)
    }
    this.paint = requestAnimationFrame(step)
  }

  dispose() {
    this.disposed = true
    if (this.timer !== null) clearTimeout(this.timer)
    if (this.paint !== null) cancelAnimationFrame(this.paint)
    for (const [id, reply] of replies) if (reply.owner === this.owner) replies.delete(id)
    owners.delete(this.owner)
    if (!owners.size) stopWorker()
    else worker?.postMessage({ owner: this.owner, release: true })
  }
}
