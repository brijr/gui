import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeImage } from 'electron'
import { boardAssetSignature } from '../src/main/board-assets'
import {
  type BoardCaptureRenderer,
  BoardCaptures,
  UnresponsiveFrameError,
} from '../src/main/board-capture'
import { BoardCaptureQueue, CAPTURE_PRIORITY } from '../src/main/board-capture-queue'
import { type BoardFrameLayout, FRAME_MAX } from '../src/shared/board'

const roots: string[] = []
const owners: BoardCaptures[] = []
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function until(condition: () => boolean) {
  const end = Date.now() + 2000
  while (!condition()) {
    if (Date.now() > end) throw new Error('Capture did not settle')
    await new Promise((done) => setTimeout(done, 1))
  }
}

const image = (text: string) =>
  ({
    getSize: () => ({ width: 400, height: 300 }),
    toJPEG: () => Buffer.from(text),
  }) as NativeImage

async function fixture(ids = ['a', 'b']) {
  const base = await mkdtemp(join(tmpdir(), 'gui-capture-test-'))
  roots.push(base)
  const root = join(base, 'board')
  const thumbs = join(base, 'thumbs')
  await mkdir(join(root, 'frames'), { recursive: true })
  await mkdir(join(root, 'assets'))
  const frames = new Map<string, BoardFrameLayout>(
    ids.map((id) => [id, { id, name: id, x: 0, y: 0, width: 400, height: 300 }]),
  )
  for (const id of ids) await writeFile(join(root, 'frames', `${id}.html`), `<h1>${id}</h1>`)
  const changed: string[] = []
  const create = (renderer: BoardCaptureRenderer, queue = new BoardCaptureQueue()) => {
    const owner = new BoardCaptures(
      {
        root,
        thumbs,
        frames: () => [...frames.values()],
        frame: (id) => frames.get(id) ?? null,
        url: (id) => `http://board/frames/${id}.html`,
        changed: (id) => changed.push(id),
      },
      renderer,
      queue,
    )
    owners.push(owner)
    return owner
  }
  return { root, thumbs, frames, changed, create }
}

test('interactive screenshots overtake queued thumbnails and active stale results are discarded', async () => {
  const f = await fixture(['a', 'b', 'c'])
  const gate = deferred()
  const rendered: string[] = []
  const owner = f.create({
    render: async (frame, _url, scale) => {
      rendered.push(`${frame.id}:${scale}`)
      if (rendered.length === 1) await gate.promise
      return image(frame.id)
    },
    dispose: gate.resolve,
  })
  await owner.open()
  await until(() => rendered.length === 1)
  // Opening queues the thumbnails in whatever order their files are read, so hold whichever
  // went first and screenshot another.
  const first = rendered[0].split(':')[0]
  const other = ['a', 'b', 'c'].find((id) => id !== first) ?? ''
  const replacement = owner.thumbnail(first)
  const coalesced = owner.thumbnail(first)
  const shot = owner.screenshot(other, 2)
  gate.resolve()
  expect((await shot).toJPEG(82).toString()).toBe(other)
  expect(rendered.slice(0, 2)).toEqual([`${first}:1`, `${other}:2`])
  await Promise.all([replacement, coalesced])
  await until(() => f.changed.length === 3)
  expect(rendered.filter((value) => value === `${first}:1`)).toHaveLength(2)
  expect(f.changed.filter((id) => id === first)).toHaveLength(1)
})

test('the shared capture budget is bounded and waiting visible work can be promoted', async () => {
  const queue = new BoardCaptureQueue(1)
  const gate = deferred()
  const events: string[] = []
  let active = 0
  let peak = 0
  const run =
    (name: string, wait = false) =>
    async () => {
      active++
      peak = Math.max(peak, active)
      events.push(name)
      if (wait) await gate.promise
      active--
    }
  const first = queue.schedule(CAPTURE_PRIORITY.background, run('board one', true))
  await until(() => events.length === 1)
  const background = queue.schedule(CAPTURE_PRIORITY.background, run('board two'))
  const visible = queue.schedule(CAPTURE_PRIORITY.background, run('visible'))
  visible.promote(CAPTURE_PRIORITY.visible)
  const cancelled = queue.schedule(CAPTURE_PRIORITY.interactive, run('cancelled'))
  cancelled.cancel()
  const interactive = queue.schedule(CAPTURE_PRIORITY.interactive, run('screenshot'))
  gate.resolve()
  await Promise.all([first.done, background.done, visible.done, cancelled.done, interactive.done])
  expect(peak).toBe(1)
  expect(events).toEqual(['board one', 'screenshot', 'visible', 'board two'])
  expect(await cancelled.done).toBeNull()
})

test('shared CSS edits invalidate all thumbnails and cache metadata remains fresh across reopen', async () => {
  const f = await fixture()
  const css = join(f.root, 'assets', 'style.css')
  await writeFile(css, 'body { color: red }')
  const rendered: string[] = []
  const renderer = () => ({
    render: async (frame: BoardFrameLayout) => {
      rendered.push(frame.id)
      return image(await readFile(css, 'utf8').catch(() => 'removed'))
    },
    dispose: () => undefined,
  })
  const first = f.create(renderer())
  await first.open()
  await until(() => f.changed.length === 2)
  await writeFile(css, 'body { color: blue }')
  expect(await first.invalidateAssets()).toBe(true)
  expect(await first.invalidateAssets()).toBe(false)
  await until(() => f.changed.length === 4)
  expect((await readFile(first.path('a'), 'utf8')).includes('blue')).toBe(true)
  await first.dispose()
  rendered.length = 0
  const reused = f.create(renderer())
  await reused.open()
  expect(reused.status('a').captured).toBe(true)
  await new Promise((done) => setTimeout(done, 10))
  expect(rendered).toEqual([])
  await reused.dispose()
  await rm(css)
  const reopened = f.create(renderer())
  await reopened.open()
  await until(() => rendered.length === 2 && f.changed.length === 6)
  expect(await readFile(reopened.path('a'), 'utf8')).toBe('removed')
})

test('removing a frame during capture cannot publish or persist its obsolete thumbnail', async () => {
  const f = await fixture(['a'])
  const gate = deferred()
  let started = false
  const owner = f.create({
    render: async () => {
      started = true
      await gate.promise
      return image('obsolete')
    },
    dispose: gate.resolve,
  })
  await owner.open()
  await until(() => started)
  f.frames.delete('a')
  owner.forget('a')
  gate.resolve()
  await owner.dispose()
  expect(f.changed).toEqual([])
  expect(owner.status('a').captured).toBe(false)
  expect(await readFile(owner.path('a')).catch(() => null)).toBeNull()
})

test('asset signatures include nested shared files and deletions but exclude board bookkeeping', async () => {
  const f = await fixture(['a'])
  const before = await boardAssetSignature(f.root)
  await writeFile(join(f.root, 'canvas.json'), '{"name":"Changed"}')
  await writeFile(join(f.root, 'canvas.json.temp.tmp'), 'Pending')
  await writeFile(join(f.root, 'frames', 'a.html'), '<h1>Changed</h1>')
  await mkdir(join(f.root, '.git'))
  await writeFile(join(f.root, '.git', 'HEAD'), 'bookkeeping')
  expect(await boardAssetSignature(f.root)).toBe(before)
  await mkdir(join(f.root, 'assets', 'nested'))
  const shared = join(f.root, 'assets', 'nested', 'script.js')
  await writeFile(shared, 'window.shared = true')
  const added = await boardAssetSignature(f.root)
  expect(added).not.toBe(before)
  await rm(shared)
  expect(await boardAssetSignature(f.root)).not.toBe(added)
})

test('a frame whose page hangs is stopped once, not retried until its page changes', async () => {
  const f = await fixture(['a', 'b'])
  const rendered: string[] = []
  const heights: number[] = []
  const owner = f.create({
    render: async (frame, _url, _scale, _signal, maxHeight) => {
      rendered.push(frame.id)
      heights.push(maxHeight)
      if (frame.id === 'a') throw new UnresponsiveFrameError(frame.id)
      return image(frame.id)
    },
    dispose: () => undefined,
  })
  const warn = console.warn
  console.warn = () => undefined
  try {
    await owner.open()
    await until(() => f.changed.includes('b'))
    await owner.thumbnail('a')
    await owner.thumbnail('a', true)
    expect(rendered.filter((id) => id === 'a')).toHaveLength(1)
    expect(owner.status('a').captured).toBe(false)
    // Screenshots always try, and say why they failed.
    await expect(owner.screenshot('a')).rejects.toThrow(/didn't respond/)
    // Thumbnails stop at a height; screenshots and exports show the whole frame.
    expect(heights.at(-1)).toBe(FRAME_MAX)
    expect(Math.max(...heights.slice(0, -1))).toBeLessThan(FRAME_MAX)
    await new Promise((done) => setTimeout(done, 5))
    await writeFile(join(f.root, 'frames', 'a.html'), '<h1>Fixed</h1>')
    await owner.thumbnail('a')
    expect(rendered.filter((id) => id === 'a')).toHaveLength(3)
  } finally {
    console.warn = warn
  }
})

test('thumbnail versions never repeat across openings, and stale thumbnails are deleted', async () => {
  const f = await fixture(['a'])
  const renderer = () => ({
    render: async (frame: BoardFrameLayout) => image(frame.id),
    dispose: () => undefined,
  })
  const first = f.create(renderer())
  await first.open()
  await until(() => f.changed.length === 1)
  const seen = first.status('a').version
  await first.dispose()
  await new Promise((done) => setTimeout(done, 5))
  // Deleted while the canvas was closed, and a write that never finished.
  await writeFile(join(f.thumbs, 'gone.jpg'), 'old')
  await writeFile(join(f.thumbs, 'a.jpg.123.tmp'), 'partial')
  const second = f.create(renderer())
  await second.open()
  expect(second.status('a').version).toBeGreaterThan(seen)
  expect(await readFile(join(f.thumbs, 'gone.jpg')).catch(() => null)).toBeNull()
  expect(await readFile(join(f.thumbs, 'a.jpg.123.tmp')).catch(() => null)).toBeNull()
  expect(await readFile(second.path('a'), 'utf8')).toBe('a')
  // A frame that leaves the board takes its thumbnail with it.
  f.frames.delete('a')
  await second.forget('a')
  expect(await readFile(second.path('a')).catch(() => null)).toBeNull()
})
