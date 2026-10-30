import { canonical, isStrings, rootStore } from './root-store'

/**
 * What each project's dependencies were last installed from: by project root (real path),
 * then by install folder ('' for the root), a stamp of its package.json dependencies and
 * lockfile (`dependencyStamp`). In Gui's data, never the project. A stamp that no longer
 * matches means the project changed since, and installs again before it starts.
 */
export type InstallRecord = Record<string, string>
const { load, update } = rootStore('installed-dependencies.json', isStrings)

export async function installedStamps(root: string): Promise<InstallRecord> {
  return (await load())[await canonical(root)] ?? {}
}

/** Records that `dir`'s dependencies are installed as `stamp` says. */
export async function recordInstall(root: string, dir: string, stamp: string) {
  const path = await canonical(root)
  await update((saved) => ({ ...saved, [path]: { ...saved[path], [dir]: stamp } }))
}
