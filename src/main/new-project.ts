import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getShellEnv } from './shell-env'
import { trust } from './trust'

/** A folder name to make: one path segment, and nothing the Finder or git would trip on. */
export function projectName(input: string): string | null {
  const name = input.trim()
  if (!name || name.length > 100 || name === '.' || name === '..') return null
  if (/[/\\:\0]/.test(name) || name.startsWith('.')) return null
  return name
}

/**
 * An empty folder, `parent/<name>`, with a git repo so checkpoints work from the first
 * change. Gui made it, so its scripts don't ask: there's nothing in it but what the agent
 * writes. Fails if the folder is already there.
 */
export async function createProject(name: string, parent: string): Promise<string> {
  const dest = join(parent, name)
  try {
    await mkdir(dest)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new Error(code === 'EEXIST' ? `${dest} already exists.` : `Couldn't create ${dest}.`)
  }
  const env = await getShellEnv()
  // Without git (or with it failing) the project still works, just without a repo.
  await new Promise<void>((done) => {
    execFile('git', ['init', '--quiet'], { cwd: dest, env }, (error) => {
      if (error) console.error('[gui] git init failed', error)
      done()
    })
  })
  await trust(dest).catch((error: unknown) => {
    console.error('[gui] failed to trust the new project', error)
  })
  return dest
}
