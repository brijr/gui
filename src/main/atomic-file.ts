import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

// Gui's own files are written whole to a temp file beside them, flushed to disk, and renamed
// over the old one: a crash or power loss leaves the old file or the new one, never a
// truncated mix. Owner-only, like everything else in Gui's data folder.

/** A fresh name beside `file`; the rename is what replaces it. */
const tempFile = (file: string) => `${file}.${randomBytes(6).toString('hex')}.tmp`

/** Writes `text` to a new, flushed temp file beside `file` and returns its path. */
export async function writeTemp(file: string, text: string): Promise<string> {
  const tmp = tempFile(file)
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    return tmp
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function writeFileAtomic(file: string, text: string) {
  const tmp = await writeTemp(file, text)
  try {
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

export function writeFileAtomicSync(file: string, text: string) {
  const tmp = tempFile(file)
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      writeSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

/**
 * Where an unreadable file goes, so the next write can't replace what might still be
 * recovered from it.
 */
export const asidePath = (file: string) =>
  `${file.replace(/\.json$/, '')}.corrupt-${Date.now()}.json`
