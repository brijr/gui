import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * Projects whose dev script the user has agreed to run. Opening a folder must not
 * execute its package.json scripts until the user has seen and accepted them.
 */
const file = () => join(app.getPath('userData'), 'trusted-projects.json')

async function load(): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file(), 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

const canonical = (root: string) => realpath(root).catch(() => root)

export async function isTrusted(root: string) {
  return (await load()).includes(await canonical(root))
}

export function listTrusted() {
  return load()
}

/** The project's dev script will ask again before it runs. */
export async function untrust(root: string) {
  const trusted = await load()
  await writeFile(
    file(),
    JSON.stringify(
      trusted.filter((path) => path !== root),
      null,
      2,
    ),
  )
}

export async function trust(root: string) {
  const path = await canonical(root)
  const trusted = await load()
  if (trusted.includes(path)) return
  await writeFile(file(), JSON.stringify([...trusted, path], null, 2))
}
