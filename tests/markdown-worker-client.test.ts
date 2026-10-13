import { expect, test } from 'bun:test'
import type { MarkdownUpdate } from '../src/renderer/src/chat/markdown-model'
import { StreamingMarkdown } from '../src/renderer/src/chat/markdown-parser'
import {
  type MarkdownDisplay,
  MarkdownRequest,
} from '../src/renderer/src/chat/markdown-worker-client'

interface Request {
  owner: number
  id: number
  text: string
  live: boolean
  release?: boolean
}

/** Control reply ordering, without pretending a timer test measures browser rendering. */
class ControlledWorker {
  static instance: ControlledWorker | null = null
  readonly queue: Request[] = []
  readonly parsers = new Map<number, StreamingMarkdown>()
  onmessage: ((event: { data: { id: number; result: MarkdownUpdate | null } }) => void) | null =
    null
  onerror: (() => void) | null = null
  terminated = false

  constructor() {
    ControlledWorker.instance = this
  }

  postMessage(request: Request) {
    if (request.release) this.parsers.delete(request.owner)
    else this.queue.push(request)
  }

  reply() {
    const request = this.queue.shift()
    if (!request) throw new Error('No parser request to resolve')
    const parser = this.parsers.get(request.owner) ?? new StreamingMarkdown()
    this.parsers.set(request.owner, parser)
    this.onmessage?.({
      data: { id: request.id, result: parser.update(request.text, request.live) },
    })
  }

  terminate() {
    this.terminated = true
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function withWorker(run: () => Promise<void>) {
  const oldWorker = globalThis.Worker
  const oldFrame = globalThis.requestAnimationFrame
  const oldCancel = globalThis.cancelAnimationFrame
  const frames = new Map<number, ReturnType<typeof setTimeout>>()
  let frameId = 0
  globalThis.Worker = ControlledWorker as unknown as typeof Worker
  globalThis.requestAnimationFrame = (callback) => {
    const id = ++frameId
    frames.set(
      id,
      setTimeout(() => {
        frames.delete(id)
        callback(performance.now())
      }, 1),
    )
    return id
  }
  globalThis.cancelAnimationFrame = (id) => {
    clearTimeout(frames.get(id))
    frames.delete(id)
  }
  try {
    await run()
  } finally {
    globalThis.Worker = oldWorker
    globalThis.requestAnimationFrame = oldFrame
    globalThis.cancelAnimationFrame = oldCancel
    for (const timer of frames.values()) clearTimeout(timer)
  }
}

test('replacement replies cannot redraw stale content, and disposed rows release pending work', async () => {
  await withWorker(async () => {
    const displays: MarkdownDisplay[] = []
    const owner = new MarkdownRequest((display) => displays.push(display))
    try {
      owner.update('old response', true)
      await sleep(5)
      const worker = ControlledWorker.instance
      if (!worker) throw new Error('Expected one shared worker')
      owner.update('replacement', true)
      owner.update('replacement answer', true)
      expect(worker.queue).toHaveLength(1)
      worker.reply()
      expect(displays).toHaveLength(0)
      await sleep(40)
      expect(worker.queue).toHaveLength(1)
      expect(worker.queue[0].text).toBe('replacement answer')
      worker.reply()
      expect(displays).toHaveLength(1)
      owner.update('replacement answer with more', true)
      await sleep(40)
      owner.dispose()
      worker.reply()
      expect(displays).toHaveLength(1)
      expect(worker.terminated).toBe(true)
    } finally {
      owner.dispose()
    }
  })
})

test('a final reply is superseded by replacement text, and parser failures keep safe readable output', async () => {
  await withWorker(async () => {
    const displays: MarkdownDisplay[] = []
    const owner = new MarkdownRequest((display) => displays.push(display))
    try {
      owner.update('final old response', false)
      await sleep(5)
      const worker = ControlledWorker.instance
      if (!worker) throw new Error('Expected one shared worker')
      owner.update('a different final response', false)
      worker.reply()
      expect(displays).toHaveLength(0)
      await sleep(5)
      worker.reply()
      await sleep(10)
      expect(displays.at(-1)?.complete).toBe(true)
      owner.update('readable if the worker fails', false)
      await sleep(5)
      worker.onerror?.()
      expect(displays.at(-1)?.raw).toBe('readable if the worker fails')
      expect(displays.at(-1)?.blocks).toEqual([])
    } finally {
      owner.dispose()
    }
  })
})
