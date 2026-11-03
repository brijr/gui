import { cp, lstat, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectTemplate } from '../shared/types'
import { writeTemplate } from './templates'
import { trust } from './trust'

/**
 * A project made from a canvas frame: its page as the app's index.html, the canvas's
 * shared images in public/assets, and Vite to serve it, so it opens and runs like any project.
 * All of it or nothing: a folder that couldn't be finished is removed, never left trusted.
 */
export async function createProjectFromFrame(
  name: string,
  parent: string,
  html: string,
  assets: string,
): Promise<string> {
  const dest = await makeProject(name, parent, 'blank')
  try {
    // Frames reach their images as ../assets/…; the app serves them from /assets/.
    await writeFile(join(dest, 'index.html'), html.replaceAll('../assets/', '/assets/'))
    await writeFile(
      join(dest, 'package.json'),
      `${JSON.stringify(
        {
          name: name.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
          private: true,
          type: 'module',
          scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
          devDependencies: { vite: '^8.3.3' },
        },
        null,
        2,
      )}\n`,
    )
    await writeFile(join(dest, '.gitignore'), 'node_modules\ndist\n')
    await copyAssets(assets, join(dest, 'public', 'assets')).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`Couldn't copy the canvas's assets: ${reason}`, { cause: error })
    })
  } catch (error) {
    await rm(dest, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  await trustNew(dest)
  return dest
}

/**
 * The canvas's assets/ folder, its regular files and folders only: a link in it could point
 * anywhere on this Mac, and the project would serve or copy what it points to.
 */
async function copyAssets(from: string, to: string) {
  const info = await stat(from).catch(() => null)
  if (!info?.isDirectory()) return
  await cp(from, to, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: async (source) => {
      const entry = await lstat(source)
      return entry.isDirectory() || entry.isFile()
    },
  })
}

/** A folder name to make: one path segment, and nothing the Finder or git would trip on. */
export function projectName(input: string): string | null {
  const name = input.trim()
  if (!name || name.length > 100 || name === '.' || name === '..') return null
  if (/[/\\:\0]/.test(name) || name.startsWith('.')) return null
  return name
}

/**
 * A folder, `parent/<name>`, with the template's files (none for Blank). Gui made it, so its
 * scripts don't ask: there's nothing in it but Gui's template and what the agent writes.
 * Fails if the folder is already there.
 */
export async function createProject(
  name: string,
  parent: string,
  template: ProjectTemplate,
): Promise<string> {
  const dest = await makeProject(name, parent, template)
  await trustNew(dest)
  return dest
}

/** The folder and its template's files, not yet trusted; nothing left behind when it fails. */
async function makeProject(name: string, parent: string, template: ProjectTemplate) {
  const dest = join(parent, name)
  try {
    await mkdir(dest)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    throw new Error(code === 'EEXIST' ? `${dest} already exists.` : `Couldn't create ${dest}.`)
  }
  try {
    await writeTemplate(dest, template, name)
  } catch (error) {
    console.error('[gui] failed to write the project template', error)
    // Gui made the folder a moment ago: nothing in it is anyone else's.
    await rm(dest, { recursive: true, force: true }).catch(() => undefined)
    throw new Error(`Couldn't set up ${dest}.`)
  }
  return dest
}

async function trustNew(dest: string) {
  await trust(dest).catch((error: unknown) => {
    console.error('[gui] failed to trust the new project', error)
  })
}
