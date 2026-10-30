import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { writeFileAtomic } from './atomic-file'

export const isStrings = (value: unknown): value is Record<string, string> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.values(value).every((text) => typeof text === 'string')

/** Project roots use their real path, even when opened through a symlink. */
export const canonical = (root: string) => realpath(root).catch(() => root)

/** Gui's per-project records: tolerate unreadable files and serialize changes so none is lost. */
export function rootStore<T, List extends boolean = false>(
  fileName: string,
  isValue: (value: unknown) => value is T,
  list?: List,
) {
  const file = () => join(app.getPath('userData'), fileName)
  type Saved = List extends true ? T[] : Record<string, T>
  const empty = () => (list ? [] : {}) as Saved
  async function load(): Promise<Saved> {
    try {
      const parsed: unknown = JSON.parse(await readFile(file(), 'utf8'))
      if (list) {
        return (Array.isArray(parsed) ? parsed.filter(isValue) : []) as Saved
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty()
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, T] => isValue(entry[1])),
      ) as Saved
    } catch {
      return empty()
    }
  }
  let pending: Promise<unknown> = Promise.resolve()
  function update(change: (saved: Saved) => Saved) {
    const task = pending.then(async () => {
      const saved = await load()
      const next = change(saved)
      if (next !== saved) await writeFileAtomic(file(), JSON.stringify(next, null, 2))
    })
    pending = task.catch(() => undefined)
    return task
  }
  return { load, update }
}
