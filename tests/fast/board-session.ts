// Isolated process: Electron/platform stubs must not replace modules used by other fast tests.
import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as fsSync from 'node:fs'
import * as fs from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from '../../src/main/atomic-file'
import { type BoardManifest, MAX_FRAMES } from '../../src/shared/board'

const nativeFs = { ...fs }
const nativeFsSync = { ...fsSync }
type WatchCallback = (event: string, file: string | null) => void
const watchers = new Map<string, Set<WatchCallback>>()
const base = await fs.mkdtemp(join(tmpdir(), 'gui-board-session-test-'))
const openBoards: { dispose(): Promise<void> }[] = []
let frameRead: { directory: string; gate: Promise<void>; calls: number } | null = null
let manifestRead: { root: string; gate: Promise<void> } | null = null
let writing: ((root: string, manifest: BoardManifest) => Promise<void>) | null = null
let competingPage: { path: string; html: string } | null = null
let failedPage: string | null = null
let frameWrite: { path: string; gate: Promise<void>; calls: number } | null = null
let unreadableFrames: string | null = null

// The interleaving probe controls delivery; real recursive watcher delivery is covered in Electron.
mock.module('node:fs', () => ({
  ...nativeFsSync,
  watch: ((root: string, _options: unknown, callback: WatchCallback) => {
    const listeners = watchers.get(root) ?? new Set<WatchCallback>()
    watchers.set(root, listeners)
    listeners.add(callback)
    return Object.assign(new EventEmitter(), {
      close() {
        listeners.delete(callback)
        if (!listeners.size) watchers.delete(root)
      },
    })
  }) as typeof fsSync.watch,
}))

function emitWatch(root: string, file: string) {
  const listeners = watchers.get(root)
  assert.ok(listeners?.size, 'The board must register its watcher')
  for (const callback of listeners) callback('change', file)
}

mock.module('node:fs/promises', () => ({
  ...nativeFs,
  readdir: (async (path, options) => {
    if (path === unreadableFrames)
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    if (frameRead && path === frameRead.directory) {
      frameRead.calls++
      await frameRead.gate
    }
    return nativeFs.readdir(path, options)
  }) as typeof fs.readdir,
  readFile: (async (path, options) => {
    if (manifestRead && path === join(manifestRead.root, 'canvas.json')) await manifestRead.gate
    return nativeFs.readFile(path, options)
  }) as typeof fs.readFile,
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

const { BoardSession, canvasHost } = await import('../../src/main/board-session')
const { createBoardTools } = await import('../../src/main/board-tool-workflow')
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
  const caller = new Error().stack
  const deadline = Date.now() + 2000
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, `Board operation did not settle:\n${caller}`)
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
const toolsFor = (value: InstanceType<typeof BoardSession>) =>
  createBoardTools(value, {
    prompt: () => null,
    open: async () => {},
    live: () => true,
    closed: new AbortController().signal,
  })
/** Runs `task` with console warnings and errors kept, not printed (the harness wants none). */
async function quietly<T>(task: () => Promise<T>) {
  const logged: string[] = []
  const { warn, error } = console
  console.warn = (...args: unknown[]) => logged.push(args.map(String).join(' '))
  console.error = console.warn
  try {
    return { result: await task(), logged }
  } finally {
    console.warn = warn
    console.error = error
  }
}
const exists = (path: string) =>
  nativeFs.access(path).then(
    () => true,
    () => false,
  )

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

  // An agent edit and its undo boundary are one lane entry, even behind a user file write.
  const agentBoundary = await board('agent-boundary', [
    { id: 'b', name: 'B', x: 480, y: 0, width: 400, height: 300 },
  ])
  const pendingGate = deferred()
  frameWrite = { path: agentBoundary.framePath('pending'), gate: pendingGate.promise, calls: 0 }
  const userCreating = agentBoundary.create({ name: 'Pending', width: 400, height: 300 })
  await until(() => frameWrite?.calls === 1)
  const tools = createBoardTools(agentBoundary, {
    prompt: () => null,
    open: async () => {},
    live: () => true,
    closed: new AbortController().signal,
  })
  const agentCreating = tools.create({ name: 'Agent', width: 400, height: 300 })
  const userArranging = agentBoundary.arrange([{ id: 'b', x: 999, y: 0 }])
  pendingGate.resolve()
  await Promise.all([userCreating, agentCreating, userArranging])
  frameWrite = null
  assert.equal(agentBoundary.frame('b')?.x, 999)
  assert.equal(await agentBoundary.undo(), true)
  assert.equal(agentBoundary.frame('b')?.x, 480)
  assert.deepEqual(
    agentBoundary.frames.map((frame) => frame.id),
    ['b', 'pending', 'agent'],
    'Undoing a later user edit must preserve the preceding agent frame',
  )
  assert.equal(await agentBoundary.undo(), false, 'User undo cannot cross the agent edit')
  await agentBoundary.dispose()

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
  emitWatch(saved.root, 'canvas.json')
  await until(() => saved.name === 'External')
  await saved.save()
  assert.equal(
    (await persisted(saved.root)).camera?.x,
    3,
    'Preserved camera must be saved, not just marked written',
  )
  await nativeFs.rm(join(saved.root, 'canvas.json'))
  emitWatch(saved.root, 'canvas.json')
  await until(() =>
    nativeFs.access(join(saved.root, 'canvas.json')).then(
      () => true,
      () => false,
    ),
  )
  assert.equal((await persisted(saved.root)).name, 'External')
  // A broken manifest (a bad hand edit, a half-written file) keeps the board, and is repaired.
  await saved.create({ name: 'Kept', width: 400, height: 300 })
  await saved.arrange([{ id: 'kept', x: 777, y: 55 }])
  await saved.save()
  const layoutBefore = JSON.stringify(saved.frames)
  await nativeFs.writeFile(join(saved.root, 'canvas.json'), '{ "frames": [ { "id": "x"')
  emitWatch(saved.root, 'canvas.json')
  await until(() =>
    nativeFs
      .readFile(join(saved.root, 'canvas.json'), 'utf8')
      .then((text) => text.startsWith('{') && text.endsWith('}')),
  )
  assert.equal(saved.name, 'External', 'A broken manifest must not reset the board')
  assert.equal(JSON.stringify(saved.frames), layoutBefore)
  assert.deepEqual((await persisted(saved.root)).frames, [
    { id: 'kept', name: 'Kept', x: 777, y: 55, width: 400, height: 300 },
  ])
  await saved.dispose()

  // Someone else rewriting a page (the agent, by hand) ends what ⌘Z can undo on the board, so
  // undoing the frame's creation can't delete what they wrote. The board's own writes don't.
  const outside = await board('outside')
  await outside.create({ name: 'Mine', width: 400, height: 300 })
  emitWatch(outside.root, 'frames/mine.html')
  await new Promise((done) => setTimeout(done, 400))
  assert.equal(outside.state().canUndo, true, "The board's own page write keeps undo")
  await nativeFs.writeFile(outside.framePath('mine'), '<h1>The agent wrote this</h1>')
  emitWatch(outside.root, 'frames/mine.html')
  await until(() => !outside.state().canUndo)
  assert.equal(await outside.undo(), false)
  assert.equal(
    await nativeFs.readFile(outside.framePath('mine'), 'utf8'),
    '<h1>The agent wrote this</h1>',
  )

  // Undoing a resize renders the frame again at the size it gets back.
  const captures = (outside as unknown as { captures: { thumbnail(id: string): Promise<void> } })
    .captures
  const thumbnail = captures.thumbnail.bind(captures)
  const rendered: string[] = []
  captures.thumbnail = (id) => {
    rendered.push(id)
    return thumbnail(id)
  }
  await outside.arrange([{ id: 'mine', width: 900, height: 900 }])
  rendered.length = 0
  assert.equal(await outside.undo(), true)
  assert.equal(outside.frame('mine')?.width, 400)
  assert.deepEqual(rendered, ['mine'], 'An undone resize needs a new thumbnail')

  // A canvas tool call that arrives after the canvas closed changes nothing.
  let live = true
  const late = createBoardTools(outside, {
    prompt: () => null,
    open: async () => {},
    live: () => live,
    closed: new AbortController().signal,
  })
  live = false
  assert.throws(() => late.list(), /The canvas closed/)
  assert.throws(() => late.create({ name: 'Late', width: 400, height: 300 }), /The canvas closed/)
  assert.deepEqual(
    outside.frames.map((frame) => frame.id),
    ['mine'],
  )
  await outside.dispose()

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

  // A canvas's pages are served on its own host only, never as 127.0.0.1 or localhost, so
  // frames in the preview share no cookies with the user's apps there (cookies ignore ports).
  const served = await board('served', [
    { id: 'page', name: 'Page', x: 0, y: 0, width: 400, height: 300 },
  ])
  const page = new URL(served.frameUrl('page'))
  assert.equal(page.hostname, 'served.localhost')
  assert.equal(served.frameAt(page.href), 'page')
  const asHost = async (host: string) => {
    return new Promise<number>((done, fail) => {
      const req = request(
        { host: '127.0.0.1', port: page.port, path: page.pathname, headers: { host } },
        (res) => {
          res.resume()
          done(res.statusCode ?? 0)
        },
      )
      req.on('error', fail)
      req.end()
    })
  }
  assert.equal(await asHost(page.host), 200)
  assert.equal(await asHost(`127.0.0.1:${page.port}`), 404)
  assert.equal(await asHost(`localhost:${page.port}`), 404)
  assert.equal(
    served.frameAt(`http://127.0.0.1:${page.port}${page.pathname}`),
    null,
    'A frame address on 127.0.0.1 is not the canvas’s',
  )
  await served.dispose()
  assert.equal(canvasHost('0123456789ab'), '0123456789ab.localhost')
  assert.match(canvasHost('Not A Label!'), /^[0-9a-f]{16}\.localhost$/)

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
    'http://opening.localhost:0',
    'Closing an opening board must not leave a late server',
  )
  // A canvas.json that can't be read at open is set aside, not replaced; the board is rebuilt
  // from its pages.
  const brokenOpen = await board(
    'broken-open',
    [{ id: 'kept', name: 'Kept', x: 900, y: 40, width: 400, height: 300 }],
    false,
  )
  await nativeFs.writeFile(join(brokenOpen.root, 'canvas.json'), '{ "frames": [ { "id": "ke')
  const brokenOpening = await quietly(() => brokenOpen.open())
  assert.ok(brokenOpening.logged.some((line) => line.includes('broken-')))
  assert.deepEqual(
    brokenOpen.frames.map((frame) => frame.id),
    ['kept'],
  )
  const asides = (await nativeFs.readdir(brokenOpen.root)).filter((file) =>
    file.startsWith('canvas.json.broken-'),
  )
  assert.equal(asides.length, 1)
  assert.equal(
    await nativeFs.readFile(join(brokenOpen.root, asides[0]), 'utf8'),
    '{ "frames": [ { "id": "ke',
  )
  await brokenOpen.dispose()

  // A manifest broken just before closing is repaired by the last save, not left broken.
  const brokenClose = await board('broken-close', [
    { id: 'a', name: 'A', x: 0, y: 0, width: 400, height: 300 },
  ])
  await brokenClose.arrange([{ id: 'a', x: 321, y: 0 }])
  await brokenClose.save()
  await nativeFs.writeFile(join(brokenClose.root, 'canvas.json'), '{ broken')
  emitWatch(brokenClose.root, 'canvas.json')
  await brokenClose.dispose()
  assert.equal((await persisted(brokenClose.root)).frames[0]?.x, 321)

  // Sections are set exactly as asked or not at all.
  const sectioned = await board('sectioned', [
    { id: 'a', name: 'A', x: 0, y: 0, width: 400, height: 300 },
    { id: 'b', name: 'B', x: 480, y: 0, width: 400, height: 300 },
  ])
  const sectionTools = toolsFor(sectioned)
  const one = await sectioned.addSection(['a', 'b'], 'One')
  assert.ok(one)
  await assert.rejects(
    sectionTools.updateSection(one.id, { frames: ['a', 'missing', 'gone'] }),
    /no frame missing, gone/,
  )
  await assert.rejects(sectionTools.updateSection(one.id, { frames: [] }), /canvas_delete_section/)
  assert.deepEqual(sectioned.section(one.id)?.frames, ['a', 'b'])
  assert.match(await sectionTools.updateSection(one.id, { frames: ['b'] }), /: b\./)

  // A blank name is refused, not reported as a rename.
  await assert.rejects(sectionTools.rename('a', '   '), /can't be blank/)
  assert.equal(sectioned.frame('a')?.name, 'A')

  // Pages that can't be frames are named in the listing, with what to rename them to.
  await nativeFs.writeFile(join(sectioned.root, 'frames', 'My Page.html'), '<h1>Page</h1>')
  await nativeFs.writeFile(join(sectioned.root, 'frames', 'Hero.html'), '<h1>Page</h1>')
  await nativeFs.writeFile(join(sectioned.root, 'frames', 'hero!.html'), '<h1>Page</h1>')
  const listing = await sectionTools.list()
  assert.match(listing, /frames\/My Page\.html → frames\/my-page\.html/)
  assert.match(listing, /frames\/Hero\.html → frames\/hero\.html/)
  assert.match(listing, /frames\/hero!\.html → frames\/hero-2\.html/)

  // A frames folder that can't be read keeps the board as it is.
  unreadableFrames = join(sectioned.root, 'frames')
  const unreadable = await quietly(async () => {
    emitWatch(sectioned.root, 'frames')
    await new Promise((done) => setTimeout(done, 400))
  })
  unreadableFrames = null
  assert.ok(unreadable.logged.length > 0)
  assert.deepEqual(
    sectioned.frames.map((frame) => frame.id),
    ['a', 'b'],
  )
  assert.equal((await persisted(sectioned.root)).frames.length, 2)
  await sectioned.dispose()

  // Duplicating past the limit makes nothing; a copy that fails takes back the others.
  const nearFull = await board(
    'near-full',
    Array.from({ length: MAX_FRAMES - 2 }, (_, i) => ({
      id: `frame-${i}`,
      name: 'Frame',
      x: i * 480,
      y: 0,
      width: 400,
      height: 300,
    })),
  )
  await nearFull.arrange([{ id: 'frame-0', x: -999, y: 0 }])
  await assert.rejects(nearFull.duplicate(['frame-0', 'frame-1', 'frame-2']), /room for 2 more/)
  assert.equal(nearFull.frames.length, MAX_FRAMES - 2)
  failedPage = nearFull.framePath('frame-copy-2')
  await assert.rejects(nearFull.duplicate(['frame-0', 'frame-1']), /Page write failed/)
  failedPage = null
  assert.equal(nearFull.frames.length, MAX_FRAMES - 2)
  assert.equal(await exists(nearFull.framePath('frame-copy')), false)
  assert.equal((await persisted(nearFull.root)).frames.length, MAX_FRAMES - 2)
  assert.equal(await nearFull.undo(), true, 'The failed copy leaves no undo step of its own')
  assert.equal(nearFull.frame('frame-0')?.x, 0)
  assert.equal(await nearFull.undo(), false)
  await nearFull.dispose()

  // Undo never deletes or overwrites a page someone else wrote before the watcher settled.
  const racing = await board('racing')
  await racing.create({ name: 'Mine', width: 400, height: 300 })
  await nativeFs.writeFile(racing.framePath('mine'), 'The agent wrote this')
  assert.equal(await racing.undo(), false)
  assert.equal(racing.state().canUndo, false)
  assert.ok(racing.has('mine'))
  assert.equal(await nativeFs.readFile(racing.framePath('mine'), 'utf8'), 'The agent wrote this')
  await racing.create({ name: 'Other', width: 400, height: 300 })
  await racing.remove(['other'])
  await nativeFs.writeFile(racing.framePath('other'), 'Also the agent')
  assert.equal(await racing.undo(), false)
  assert.equal(await nativeFs.readFile(racing.framePath('other'), 'utf8'), 'Also the agent')

  // A frame undone off the board takes its thumbnail with it.
  const thumb = join(base, 'thumbs', 'racing', 'third.jpg')
  await racing.create({ name: 'Third', width: 400, height: 300 })
  await nativeFs.mkdir(join(base, 'thumbs', 'racing'), { recursive: true })
  await nativeFs.writeFile(thumb, 'jpeg')
  assert.equal(await racing.undo(), true)
  assert.equal(racing.has('third'), false)
  assert.equal(await exists(thumb), false)
  await racing.dispose()

  console.log(
    'BoardSession allocation, limits, save ordering/retry, external files, and close/open passed.',
  )
} finally {
  frameRead = null
  manifestRead = null
  writing = null
  competingPage = null
  failedPage = null
  unreadableFrames = null
  await Promise.allSettled(openBoards.map((value) => value.dispose()))
  await nativeFs.rm(base, { recursive: true, force: true })
}
