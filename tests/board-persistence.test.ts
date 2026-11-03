import { expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoardManifestWriter, BoardMutations, openManifest } from '../src/main/board-persistence'
import type { BoardManifest } from '../src/shared/board'

const manifest = (name: string): BoardManifest => ({
  version: 1,
  name,
  createdAt: 0,
  frames: [],
  sections: [],
  camera: null,
})

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

test('a slow older manifest cannot replace the newest acknowledged state', async () => {
  const writes: { name: string; gate: ReturnType<typeof deferred> }[] = []
  let disk = ''
  const writer = new BoardManifestWriter(async (value) => {
    const gate = deferred()
    writes.push({ name: value.name, gate })
    await gate.promise
    disk = value.name
  })
  const older = writer.save(manifest('Older'))
  await Promise.resolve()
  const skipped = writer.save(manifest('Intermediate'))
  const newer = writer.save(manifest('Newer'))
  expect(writes.map((write) => write.name)).toEqual(['Older'])
  expect(writer.owns(manifest('Newer'))).toBe(false)
  writes[0].gate.resolve()
  await Promise.resolve()
  await Promise.resolve()
  expect(writes.map((write) => write.name)).toEqual(['Older', 'Newer'])
  writes[1].gate.resolve()
  await Promise.all([older, skipped, newer])
  expect(disk).toBe('Newer')
  expect(writer.owns(manifest('Newer'))).toBe(true)
  await writer.save(manifest('Newer'))
  expect(writes).toHaveLength(2)
})

test('failed manifest writes retain the latest dirty state for an unchanged retry', async () => {
  const gate = deferred()
  const attempts: string[] = []
  const writer = new BoardManifestWriter(async (value) => {
    attempts.push(value.name)
    if (attempts.length === 1) await gate.promise
  })
  writer.observe(manifest('Saved'))
  const first = writer.save(manifest('Failed'))
  await Promise.resolve()
  const latest = writer.save(manifest('Newest'))
  gate.reject(new Error('Disk failed'))
  const failures = await Promise.allSettled([first, latest])
  expect(failures.every((result) => result.status === 'rejected')).toBe(true)
  expect(writer.owns(manifest('Newest'))).toBe(false)
  expect(writer.owns(manifest('Saved'))).toBe(true)
  await writer.save(manifest('Newest'))
  expect(attempts).toEqual(['Failed', 'Newest'])
  expect(writer.owns(manifest('Newest'))).toBe(true)
})

test('returning to saved state while another write runs still restores that state', async () => {
  const gate = deferred()
  const written: string[] = []
  const writer = new BoardManifestWriter(async (value) => {
    if (!written.length) await gate.promise
    written.push(value.name)
  })
  writer.observe(manifest('Original'))
  const changing = writer.save(manifest('Changed'))
  await Promise.resolve()
  const undoing = writer.save(manifest('Original'))
  gate.resolve()
  await Promise.all([changing, undoing])
  expect(written).toEqual(['Changed', 'Original'])
})

test('an adopted external manifest has its actual camera and supersedes failed pending state', async () => {
  const writer = new BoardManifestWriter(async () => {
    throw new Error('Read only')
  })
  await writer.save(manifest('Local')).catch(() => undefined)
  const external = { ...manifest('External'), camera: { x: 8, y: 9, zoom: 0.5 } }
  writer.observe(external)
  expect(writer.owns(external)).toBe(true)
  expect(writer.owns({ ...external, camera: null })).toBe(false)
  await writer.save(external)
})

test('closing mutations waits for accepted work and one failure does not poison the lane', async () => {
  const mutations = new BoardMutations()
  const gate = deferred()
  const events: string[] = []
  const failed = mutations.run(async () => {
    events.push('first')
    await gate.promise
    throw new Error('First failed')
  })
  const second = mutations.run(async () => {
    events.push('second')
  })
  const closing = mutations.close()
  let completed = false
  void closing.then(() => {
    completed = true
  })
  await expect(mutations.run(async () => undefined)).rejects.toThrow('Canvas closed')
  expect(events).toEqual(['first'])
  expect(completed).toBe(false)
  gate.resolve()
  await failed.catch(() => undefined)
  await second
  await closing
  expect(events).toEqual(['first', 'second'])
  expect(completed).toBe(true)
})

test('a canvas.json that cannot be read is set aside at open, and a missing one is a new canvas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gui-open-manifest-'))
  const warn = console.warn
  const warned: string[] = []
  console.warn = (...args: unknown[]) => warned.push(args.map(String).join(' '))
  try {
    expect(await openManifest(root, 'New')).toMatchObject({ name: 'New', frames: [] })
    expect(await readdir(root)).toEqual([])
    const good = {
      ...manifest('Saved'),
      frames: [{ id: 'a', name: 'A', x: 1, y: 2, width: 400, height: 300 }],
    }
    await writeFile(join(root, 'canvas.json'), JSON.stringify(good))
    expect(await openManifest(root)).toEqual(good)
    expect(warned).toEqual([])
    for (const broken of ['{ "frames": [', '{"name":"No frames"}', '[]']) {
      await writeFile(join(root, 'canvas.json'), broken)
      expect((await openManifest(root, 'Rebuilt')).frames).toEqual([])
      const aside = (await readdir(root)).filter((file) => file.startsWith('canvas.json.broken-'))
      expect(aside).toHaveLength(1)
      expect(await readFile(join(root, aside[0]), 'utf8')).toBe(broken)
      expect((await readdir(root)).includes('canvas.json')).toBe(false)
      await rm(join(root, aside[0]))
    }
    expect(warned).toHaveLength(3)
  } finally {
    console.warn = warn
    await rm(root, { recursive: true, force: true })
  }
})
