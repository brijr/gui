import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { writeFileAtomic } from './atomic-file'

/**
 * What each project's dependencies were last installed from: by project root (real path),
 * then by install folder ('' for the root), a stamp of its package.json dependencies and
 * lockfile (`dependencyStamp`). In Gui's data, never the project. A stamp that no longer
 * matches means the project changed since, and installs again before it starts.
 */
const file = () => join(app.getPath('userData'), 'installed-dependencies.json')

export type InstallRecord = Record<string, string>
type Saved = Record<string, InstallRecord>

const isRecord = (value: unknown): value is InstallRecord =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.values(value).every((stamp) => typeof stamp === 'string')

async function load(): Promise<Saved> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file(), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry) => isRecord(entry[1])))
  } catch {
    return {}
  }
}

const canonical = (root: string) => realpath(root).catch(() => root)

let pendingWrite: Promise<unknown> = Promise.resolve()

/** One change at a time, each on what the last one wrote, so none is lost. */
function update(change: (saved: Saved) => Saved) {
  const task = pendingWrite.then(async () => {
    await writeFileAtomic(file(), JSON.stringify(change(await load()), null, 2))
  })
  pendingWrite = task.catch(() => undefined)
  return task
}

export async function installedStamps(root: string): Promise<InstallRecord> {
  return (await load())[await canonical(root)] ?? {}
}

/** Records that `dir`'s dependencies are installed as `stamp` says. */
export async function recordInstall(root: string, dir: string, stamp: string) {
  const path = await canonical(root)
  await update((saved) => ({ ...saved, [path]: { ...saved[path], [dir]: stamp } }))
}
