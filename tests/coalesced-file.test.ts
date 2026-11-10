import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoalescedFile, diskFile, type FileLayer } from '../src/main/coalesced-file'

// Preferences are saved through CoalescedFile (src/main/prefs.ts): memory changes at once and
// the file follows off the main thread. These are the promises that makes: changes made
// together are one write, an older write never lands after a newer one, a failed write isn't
// forgotten, and quit writes what's left.

/** A disk that finishes each temp write when the test says so. */
function fakeDisk() {
  let text = ''
  let next = 0
  const errors: unknown[] = []
  /** Temp writes that have started and not finished, oldest first. */
  const writing: Array<{ text: string; finish: () => void; fail: (error: Error) => void }> = []
  const temps = new Map<string, string>()
  const disk = {
    /** What the real file holds; null until something is written. */
    file: null as string | null,
    /** Every write that reached the real file, in order, and how. */
    landed: [] as string[],
    discarded: 0,
    /** The next rename into place fails */
    failReplace: false,
    errors,
    writing,
    set(value: string) {
      text = value
      writer.changed()
    },
  }
  const layer: FileLayer = {
    writeTemp: (written) =>
      new Promise((resolve, reject) => {
        const tmp = `tmp-${next++}`
        writing.push({
          text: written,
          finish: () => {
            temps.set(tmp, written)
            resolve(tmp)
          },
          fail: reject,
        })
      }),
    replace: (tmp) => {
      if (disk.failReplace) {
        disk.failReplace = false
        throw new Error('rename failed')
      }
      disk.file = temps.get(tmp) ?? null
      disk.landed.push(`async:${disk.file}`)
      temps.delete(tmp)
    },
    discard: async (tmp) => {
      temps.delete(tmp)
      disk.discarded++
    },
    writeSync: (written) => {
      disk.file = written
      disk.landed.push(`sync:${written}`)
    },
  }
  const writer = new CoalescedFile(
    () => text,
    layer,
    (error) => errors.push(error),
  )
  return { disk, writer, layer }
}

/** Lets the writer's own steps run: its start after a change, and what follows a temp write. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

test('changes made together are one write, of the last of them', async () => {
  const { disk } = fakeDisk()
  disk.set('a')
  disk.set('b')
  disk.set('c')
  // Nothing touches the disk while the caller is still running.
  expect(disk.writing).toHaveLength(0)
  await settle()
  expect(disk.writing.map((write) => write.text)).toEqual(['c'])
  disk.writing.shift()?.finish()
  await settle()
  expect(disk.landed).toEqual(['async:c'])
  expect(disk.writing).toHaveLength(0)
})

test('a slow older write is finished before the next starts, and the newest lands last', async () => {
  const { disk } = fakeDisk()
  disk.set('old')
  await settle()
  // While the old write is still on its way, two more changes.
  disk.set('newer')
  await settle()
  disk.set('newest')
  await settle()
  expect(disk.writing.map((write) => write.text)).toEqual(['old'])
  disk.writing.shift()?.finish()
  await settle()
  expect(disk.file).toBe('old')
  // One write for both of them, taking the text as it is when it starts.
  expect(disk.writing.map((write) => write.text)).toEqual(['newest'])
  disk.writing.shift()?.finish()
  await settle()
  expect(disk.landed).toEqual(['async:old', 'async:newest'])
  expect(disk.writing).toHaveLength(0)
})

test('a failed write is reported and the next change saves everything', async () => {
  const { disk, writer } = fakeDisk()
  disk.set('first')
  await settle()
  disk.writing.shift()?.fail(new Error('disk full'))
  await settle()
  expect(disk.errors).toHaveLength(1)
  expect(disk.file).toBeNull()
  // It isn't tried again in a loop while nothing changes.
  expect(disk.writing).toHaveLength(0)

  disk.set('second')
  await settle()
  expect(disk.writing.map((write) => write.text)).toEqual(['second'])
  disk.writing.shift()?.finish()
  await settle()
  expect(disk.file).toBe('second')
  // Saved: quitting now has nothing to write.
  writer.flushSync()
  expect(disk.landed).toEqual(['async:second'])
})

test('a temp file that cannot be put in place is a failed write too, and is dropped', async () => {
  const { disk, writer } = fakeDisk()
  disk.set('first')
  await settle()
  disk.failReplace = true
  disk.writing.shift()?.finish()
  await settle()
  expect(disk.errors).toHaveLength(1)
  expect(disk.file).toBeNull()
  expect(disk.discarded).toBe(1)
  writer.flushSync()
  expect(disk.landed).toEqual(['sync:first'])
})

test('what a failed write left unsaved is written at quit', async () => {
  const { disk, writer } = fakeDisk()
  disk.set('unsaved')
  await settle()
  disk.writing.shift()?.fail(new Error('disk full'))
  await settle()
  writer.flushSync()
  expect(disk.landed).toEqual(['sync:unsaved'])
})

test('quitting writes a change that has not started saving, once', async () => {
  const { disk, writer } = fakeDisk()
  disk.set('a')
  disk.set('b')
  writer.flushSync()
  expect(disk.landed).toEqual(['sync:b'])
  // The write that was about to start has nothing left to do, and a second flush neither.
  await settle()
  writer.flushSync()
  expect(disk.writing).toHaveLength(0)
  expect(disk.landed).toEqual(['sync:b'])
})

test('a write under way at quit cannot land over what quit wrote', async () => {
  const { disk, writer } = fakeDisk()
  disk.set('old')
  await settle()
  disk.set('new')
  writer.flushSync()
  expect(disk.file).toBe('new')
  // The old write finishes afterwards: its temp file is dropped, not renamed into place.
  disk.writing.shift()?.finish()
  await settle()
  expect(disk.landed).toEqual(['sync:new'])
  expect(disk.discarded).toBe(1)
  expect(disk.writing).toHaveLength(0)
  expect(disk.errors).toHaveLength(0)
})

test('quit asks twice: the second time writes nothing, with the old write still on its way', async () => {
  const { disk, writer } = fakeDisk()
  disk.set('old')
  await settle()
  disk.set('new')
  // Gui flushes as it starts to quit and again as it goes.
  writer.flushSync()
  writer.flushSync()
  expect(disk.landed).toEqual(['sync:new'])
  disk.writing.shift()?.finish()
  await settle()
  writer.flushSync()
  expect(disk.landed).toEqual(['sync:new'])
  expect(disk.discarded).toBe(1)
})

test('a write that quit overtook and then fails is nothing to report', async () => {
  const { disk, writer } = fakeDisk()
  disk.set('old')
  await settle()
  disk.set('new')
  writer.flushSync()
  disk.writing.shift()?.fail(new Error('folder gone'))
  await settle()
  expect(disk.errors).toHaveLength(0)
  // Nothing is left to save either.
  writer.flushSync()
  expect(disk.landed).toEqual(['sync:new'])
})

test('a write under way at quit is written there even with nothing newer', async () => {
  const { disk, writer } = fakeDisk()
  disk.set('only')
  await settle()
  expect(disk.writing).toHaveLength(1)
  // Nothing after quit would rename its temp file into place.
  writer.flushSync()
  expect(disk.landed).toEqual(['sync:only'])
})

test('a change after a flush is saved as usual', async () => {
  const { disk, writer } = fakeDisk()
  disk.set('a')
  writer.flushSync()
  disk.set('b')
  await settle()
  disk.writing.shift()?.finish()
  await settle()
  expect(disk.landed).toEqual(['sync:a', 'async:b'])
})

test('nothing is written when nothing changed', () => {
  const { disk, writer } = fakeDisk()
  writer.flushSync()
  expect(disk.landed).toEqual([])
})

test('on a real disk: the file follows, quit lands last, and no temp file stays', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gui-coalesced-file-'))
  try {
    const file = join(dir, 'state.json')
    const saved = () => {
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return null
      }
    }
    const until = async (check: () => Promise<boolean> | boolean) => {
      for (let tries = 0; tries < 200 && !(await check()); tries++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(await check()).toBe(true)
    }
    // What a quit in the middle of a write leaves behind: the next write takes its place.
    await writeFile(`${file}.tmp`, 'half a wri')
    const errors: unknown[] = []
    let text = 'one'
    const disk = diskFile(() => file)
    let dropped: Promise<void> | null = null
    const writer = new CoalescedFile(
      () => text,
      { ...disk, discard: (tmp) => (dropped = disk.discard(tmp)) },
      (error) => errors.push(error),
    )
    writer.changed()
    expect(saved()).toBeNull()
    await until(() => saved() === 'one')
    expect(await readdir(dir)).toEqual(['state.json'])

    // A write under way when quit writes: the file holds the newest, there and afterwards.
    text = 'two'
    writer.changed()
    await Promise.resolve()
    text = 'three'
    writer.changed()
    writer.flushSync()
    expect(saved()).toBe('three')
    // The write quit overtook finishes later: its temp file goes, and the file stays as it is.
    await until(() => dropped !== null)
    await dropped
    expect(await readdir(dir)).toEqual(['state.json'])
    expect(saved()).toBe('three')
    expect(errors).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
