import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, session } from 'electron'
import type { StorageKind, StorageUsage } from '../shared/types'
import { shadowRepoName } from './checkpoints'
import { claimedHistoryFiles, historyFile } from './history'
import { recordingProjectKey } from './recordings'

/** Session partition the previewed apps run in; its cookies and storage persist. */
export const PREVIEW_PARTITION = 'persist:gui-preview'

const dirs: Record<StorageKind, () => string> = {
  chats: () => join(app.getPath('userData'), 'chats'),
  checkpoints: () => join(app.getPath('userData'), 'checkpoints'),
  previewData: () =>
    join(app.getPath('userData'), 'Partitions', PREVIEW_PARTITION.replace(/^persist:/, '')),
}

async function sizeOf(path: string): Promise<number> {
  try {
    const stats = await lstat(path)
    if (!stats.isDirectory()) return stats.size
    const entries = await readdir(path)
    const sizes = await Promise.all(entries.map((entry) => sizeOf(join(path, entry))))
    return sizes.reduce((total, size) => total + size, 0)
  } catch {
    return 0
  }
}

export async function measureStorage(): Promise<StorageUsage> {
  const [chats, checkpoints, previewData, recordings] = await Promise.all([
    sizeOf(dirs.chats()),
    sizeOf(dirs.checkpoints()),
    sizeOf(dirs.previewData()),
    sizeOf(join(app.getPath('userData'), 'recordings')),
  ])
  return { chats: chats + recordings, checkpoints, previewData }
}

/** Removes everything in `dir` except the named entries. */
async function clearDir(dir: string, keep: Set<string>) {
  const entries = await readdir(dir).catch(() => [])
  await Promise.all(
    entries
      .filter((entry) => !keep.has(entry))
      .map((entry) => rm(join(dir, entry), { recursive: true, force: true })),
  )
}

/**
 * Clears one kind of stored data. Projects open in a window keep their chat history and
 * checkpoints, since their chats are live and still write to them.
 */
export async function clearStorage(kind: StorageKind, openRoots: string[]) {
  if (kind === 'previewData') {
    const preview = session.fromPartition(PREVIEW_PARTITION)
    await Promise.all([preview.clearStorageData(), preview.clearCache()])
    return
  }
  if (kind === 'chats') {
    await clearDir(
      join(app.getPath('userData'), 'recordings'),
      new Set(openRoots.map(recordingProjectKey)),
    )
    const keep = await Promise.all(openRoots.map(async (root) => basename(await historyFile(root))))
    await clearDir(
      dirs.chats(),
      new Set([...keep, ...claimedHistoryFiles().map((file) => basename(file))]),
    )
    return
  }
  const keep = await Promise.all(
    openRoots.map(async (root) => shadowRepoName(await realpath(root).catch(() => root))),
  )
  await clearDir(dirs.checkpoints(), new Set(keep))
}
