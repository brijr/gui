// Isolated process: Electron/platform stubs must not replace modules used by other fast tests.
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from '../../src/main/atomic-file'
import { type BoardManifest, MAX_FRAMES, parseManifest } from '../../src/shared/board'

const nativeFs = { ...fs }
const base = await fs.mkdtemp(join(tmpdir(), 'gui-board-session-test-'))
const openBoards: { dispose(): Promise<void> }[] = []
let frameRead: { directory: string; gate: Promise<void>; calls: number } | null = null
let manifestRead: { root: string; gate: Promise<void> } | null = null
let writing: ((root: string, manifest: BoardManifest) => Promise<void>) | null = null
let competingPage: { path: string; html: string } | null = null
let failedPage: string | null = null
let frameWrite: { path: string; gate: Promise<void>; calls: number } | null = null

mock.module('node:fs/promises', () => ({
  ...nativeFs,
  readdir: (async (path, options) => {
    if (frameRead && path === frameRead.directory) {
      frameRead.calls++
      await frameRead.gate
    }
    return nativeFs.readdir(path, options)
  }) as typeof fs.readdir,
  writeFile: (async (path, data, options) => {
    if (frameWrite?.path === path) {
      frameWrite.calls++
      await frameWrite.gate
    }
    if (path === failedPage) throw new Error('Page write failed')
    if (competingPage && path === competingPage.path) {
      const external = competingPage
      competingPage = null
      await nativeFs.writeFile(external.path, external.html)
    }
    return nativeFs.writeFile(path, data, options)
  }) as typeof fs.writeFile,
}))
mock.module('../../src/main/board', () => ({
  readManifest: async (root: string) => {
    if (manifestRead?.root === root) await manifestRead.gate
    return parseManifest(await nativeFs.readFile(join(root, 'canvas.json'), 'utf8'), 'Canvas')
  },
  writeManifest: (root: string, manifest: BoardManifest) =>
    writing
      ? writing(root, manifest)
      : writeFileAtomic(join(root, 'canvas.json'), JSON.stringify(manifest)),
  thumbsDir: (id: string) => join(base, 'thumbs', id),
  thumbsUrl: (id: string) => `gui-thumb://${id}`,
}))
mock.module('../../src/main/board-capture-renderer', () => ({
  OffscreenBoardRenderer: class {
    render() {
      return Promise.resolve(null)
    }
    dispose() {}
  },
}))

const { BoardSession } = await import('../../src/main/board-session')
const manifest = (frames: BoardManifest['frames'] = []): BoardManifest => ({
  version: 1,
  name: 'Canvas',
  createdAt: 1,
  frames,
  sections: [],
  camera: null,
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function until(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 2000
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, 'Board operation did not settle')
    await new Promise((done) => setTimeout(done, 1))
  }
}
async function board(id: string, frames: BoardManifest['frames'] = [], open = true) {
  const root = join(base, id)
  await nativeFs.mkdir(join(root, 'frames'), { recursive: true })
  await nativeFs.mkdir(join(root, 'assets'))
  for (const frame of frames)
    await nativeFs.writeFile(join(root, 'frames', `${frame.id}.html`), '<h1>Saved</h1>')
  await nativeFs.writeFile(join(root, 'canvas.json'), JSON.stringify(manifest(frames)))
  const value = new BoardSession(root, id)
  openBoards.push(value)
  if (open) await value.open()
  return value
}
const persisted = async (root: string) =>
  JSON.parse(await nativeFs.readFile(join(root, 'canvas.json'), 'utf8')) as BoardManifest

try {
  // Hold the allocator's actual directory read, forcing overlapping user requests.
  const simultaneous = await board('simultaneous')
  const readGate = deferred()
  frameRead = { directory: join(simultaneous.root, 'frames'), gate: readGate.promise, calls: 0 }
  const first = simultaneous.create({ name: 'Same', width: 400, height: 300, html: 'First' })
  const second = simultaneous.create({ name: 'Same', width: 400, height: 300, html: 'Second' })
  await until(() => frameRead?.calls === 1)
  await new Promise((done) => setTimeout(done, 5))
  assert.equal(frameRead.calls, 1, 'Concurrent creation must share the allocation lane')
  readGate.resolve()
  const made = await Promise.all([first, second])
  frameRead = null
  assert.deepEqual(
    made.map((frame) => frame.id),
    ['same', 'same-2'],
  )
  assert.equal(await nativeFs.readFile(simultaneous.framePath('same'), 'utf8'), 'First')
  assert.equal(await nativeFs.readFile(simultaneous.framePath('same-2'), 'utf8'), 'Second')
  assert.ok(made[1].x >= made[0].x + made[0].width)
  await simultaneous.dispose()
  assert.equal((await persisted(simultaneous.root)).frames.length, 2)

  const externalPage = await board('external-page')
  competingPage = { path: externalPage.framePath('taken'), html: 'External page' }
  const unique = await externalPage.create({
    name: 'Taken',
    width: 400,
    height: 300,
    html: 'Our page',
  })
  assert.equal(unique.id, 'taken-2')
  assert.equal(await nativeFs.readFile(externalPage.framePath('taken'), 'utf8'), 'External page')
  assert.equal(await nativeFs.readFile(externalPage.framePath('taken-2'), 'utf8'), 'Our page')
  failedPage = externalPage.framePath('failed')
  await assert.rejects(
    externalPage.create({ name: 'Failed', width: 400, height: 300 }),
    /Page write failed/,
  )
  assert.equal(
    externalPage.has('failed'),
    false,
    'A failed page write cannot leave a phantom frame',
  )
  failedPage = null
  await externalPage.dispose()

  const almostFull = Array.from({ length: MAX_FRAMES - 1 }, (_, i) => ({
    id: `frame-${i}`,
    name: 'Frame',
    x: i * 480,
    y: 0,
    width: 400,
    height: 300,
  }))
  const limited = await board('limited', almostFull)
  const finalSlot = await Promise.allSettled([
    limited.create({ name: 'Last', width: 400, height: 300 }),
    limited.create({ name: 'Last', width: 400, height: 300 }),
  ])
  assert.equal(finalSlot.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(finalSlot.filter((result) => result.status === 'rejected').length, 1)
  assert.equal(limited.frames.length, MAX_FRAMES)
  await limited.dispose()

  // Layout and section requests accepted during an undo's file restore run after it.
  const orderedLayout = await board('ordered-layout', [
    { id: 'a', name: 'A', x: 0, y: 0, width: 400, height: 300 },
    { id: 'b', name: 'B', x: 480, y: 0, width: 400, height: 300 },
  ])
  const originalSection = await orderedLayout.addSection(['a', 'b'], 'Original')
  assert.ok(originalSection)
  await orderedLayout.remove(['a'])
  const undoGate = deferred()
  frameWrite = { path: orderedLayout.framePath('a'), gate: undoGate.promise, calls: 0 }
  const undoing = orderedLayout.undo()
  await until(() => frameWrite?.calls === 1)
  const arranging = orderedLayout.arrange([{ id: 'b', x: 999, y: 0 }])
  const sectioning = orderedLayout.addSection(['a'], 'Restored')
  const renamingSection = orderedLayout.updateSection(originalSection.id, { name: 'Renamed' })
  const removingSection = orderedLayout.removeSection(originalSection.id)
  const layoutDuringUndo = orderedLayout.frame('b')?.x
  undoGate.resolve()
  assert.equal(await undoing, true)
  await Promise.all([arranging, renamingSection, removingSection])
  const restoredSection = await sectioning
  assert.equal(layoutDuringUndo, 480, 'Layout must wait for the active file mutation')
  assert.ok(restoredSection, 'A section can refer to a frame restored by an earlier undo')
  assert.equal(orderedLayout.frame('b')?.x, 999)
  assert.equal(orderedLayout.section(originalSection.id), null)
  assert.deepEqual(orderedLayout.sections, [restoredSection])
  frameWrite = null
  await orderedLayout.dispose()
  const orderedState = await persisted(orderedLayout.root)
  assert.equal(orderedState.frames.find((frame) => frame.id === 'b')?.x, 999)
  assert.deepEqual(orderedState.sections, [restoredSection])

  const deleted = await board('deleted')
  await deleted.create({ name: 'Gone', width: 400, height: 300 })
  writing = async () => {
    throw new Error('Removal save failed')
  }
  await assert.rejects(deleted.remove(['gone']), /Removal save failed/)
  assert.equal(await nativeFs.stat(deleted.framePath('gone')).catch(() => null), null)
  writing = null
  await deleted.save()
  await deleted.dispose()
  const restored = new BoardSession(deleted.root, 'deleted')
  openBoards.push(restored)
  await restored.open()
  assert.equal(
    restored.frames.length,
    0,
    'An unchanged retry must not resurrect a removed page on reopen',
  )
  await restored.dispose()

  const saved = await board('saved')
  const writeGate = deferred()
  const snapshots: BoardManifest[] = []
  writing = async (root, snapshot) => {
    snapshots.push(snapshot)
    if (snapshots.length === 1) await writeGate.promise
    await writeFileAtomic(join(root, 'canvas.json'), JSON.stringify(snapshot))
  }
  saved.setCamera({ x: 1, y: 1, zoom: 1 })
  const oldSave = saved.save()
  await until(() => snapshots.length === 1)
  saved.setCamera({ x: 2, y: 2, zoom: 1 })
  const latestSave = saved.save()
  assert.equal(snapshots.length, 1)
  writeGate.resolve()
  await Promise.all([oldSave, latestSave])
  assert.equal((await persisted(saved.root)).camera?.x, 2)
  assert.equal(snapshots.length, 2)
  let retries = 0
  writing = async (root, snapshot) => {
    if (++retries === 1) throw new Error('Disk failed')
    await writeFileAtomic(join(root, 'canvas.json'), JSON.stringify(snapshot))
  }
  saved.setCamera({ x: 3, y: 3, zoom: 1 })
  await assert.rejects(saved.save(), /Disk failed/)
  await saved.save()
  assert.equal(retries, 2)
  writing = null
  competingPage = null
  failedPage = null
  frameWrite = null
  assert.equal((await persisted(saved.root)).camera?.x, 3)
  const external = { ...(await persisted(saved.root)), name: 'External', camera: null }
  await nativeFs.writeFile(join(saved.root, 'canvas.json'), JSON.stringify(external))
  await until(() => saved.name === 'External')
  await saved.save()
  assert.equal(
    (await persisted(saved.root)).camera?.x,
    3,
    'Preserved camera must be saved, not just marked written',
  )
  await nativeFs.rm(join(saved.root, 'canvas.json'))
  await until(() =>
    nativeFs.access(join(saved.root, 'canvas.json')).then(
      () => true,
      () => false,
    ),
  )
  assert.equal((await persisted(saved.root)).name, 'External')
  await saved.dispose()

  const closing = await board('closing')
  const closeGate = deferred()
  frameRead = { directory: join(closing.root, 'frames'), gate: closeGate.promise, calls: 0 }
  const creating = closing.create({ name: 'Pending', width: 400, height: 300 })
  await until(() => frameRead?.calls === 1)
  const completion = closing.dispose()
  assert.equal(closing.dispose(), completion)
  await assert.rejects(closing.create({ name: 'Late', width: 400, height: 300 }), /Canvas closed/)
  closeGate.resolve()
  await creating
  await completion
  frameRead = null
  assert.deepEqual(
    (await persisted(closing.root)).frames.map((frame) => frame.id),
    ['pending'],
  )
  await assert.rejects(fetch(closing.frameUrl('pending')))

  const opening = await board('opening', [], false)
  const openGate = deferred()
  manifestRead = { root: opening.root, gate: openGate.promise }
  const opened = opening.open()
  const disposed = opening.dispose()
  openGate.resolve()
  await Promise.all([opened, disposed])
  manifestRead = null
  assert.equal(
    opening.origin,
    'http://127.0.0.1:0',
    'Closing an opening board must not leave a late server',
  )
  console.log(
    'BoardSession allocation, limits, save ordering/retry, external files, and close/open passed.',
  )
} finally {
  frameRead = null
  manifestRead = null
  writing = null
  competingPage = null
  failedPage = null
  await Promise.allSettled(openBoards.map((value) => value.dispose()))
  await nativeFs.rm(base, { recursive: true, force: true })
}
