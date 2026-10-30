import { createHash } from 'node:crypto'
import { type FSWatcher, watch } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProjectInfo } from '../shared/types'
import { appRoot, dependencyNames, LOCKFILES, readPackageJson } from './project'
import { ENV_EXAMPLES, fileStamp } from './setup'

/** Changes come in bursts (an install, a save that writes twice): one restart after them. */
const DEBOUNCE_MS = 1000

/** Config files a dev server reads once, at its start. */
const CONFIG =
  /^(?:vite|next|astro|nuxt|svelte|remix|react-router|webpack|vue|craco|gatsby-config|gatsby-node|rsbuild|rspack)\.config\.[cm]?[jt]s$|^angular\.json$/
/**
 * Dev servers that restart themselves when their config or env files change (Vite and what
 * runs on it, Next.js): Gui restarting them too would only do it twice.
 */
const SELF_RELOADING = new Set([
  'next',
  'vite',
  'astro',
  'nuxt',
  '@sveltejs/kit',
  '@remix-run/dev',
  '@react-router/dev',
  'vitepress',
  '@solidjs/start',
  '@tanstack/react-start',
])
/** The package.json fields that change how the app starts or what it can import. */
const START_FIELDS = [
  'scripts',
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'workspaces',
  'packageManager',
] as const
/** The folders whose files decide how the app starts: the project root and the app's own. */
export function startDirs(project: ProjectInfo): string[] {
  const app = appRoot(project)
  return app === project.root ? [project.root] : [project.root, app]
}

/** Whether the app's dev server picks up its own config and env changes. */
export async function reloadsItself(project: ProjectInfo): Promise<boolean> {
  const pkg = await readPackageJson(appRoot(project))
  const deps = [pkg?.dependencies, pkg?.devDependencies].flatMap(dependencyNames)
  return deps.some((name) => SELF_RELOADING.has(name))
}

/** Whether a change to the file `name` can need the app restarted. */
export function isStartFile(name: string, selfReloading: boolean): boolean {
  if (name === 'package.json' || LOCKFILES.some(([file]) => file === name)) return true
  if (selfReloading) return false
  const env = name === '.env' || (name.startsWith('.env.') && !ENV_EXAMPLES.includes(name))
  return env || CONFIG.test(name)
}

/**
 * What the app started from, as one hash: package.json's scripts and dependencies, the
 * lockfiles, and (for a dev server that doesn't reload them itself) env and config files.
 * A change event whose files still hash the same (a save with no change, an install that
 * rewrote the lockfile as it was) doesn't restart anything.
 */
export async function startSignature(project: ProjectInfo): Promise<string> {
  const selfReloading = await reloadsItself(project)
  const hash = createHash('sha256')
  for (const dir of startDirs(project)) {
    const pkg = await readPackageJson(dir)
    hash.update(JSON.stringify(START_FIELDS.map((field) => pkg?.[field as keyof typeof pkg])))
    const names = await readdir(dir).catch((): string[] => [])
    for (const name of names.sort()) {
      if (name === 'package.json' || !isStartFile(name, selfReloading)) continue
      hash.update(`\0${dir}/${name}\0${await fileStamp(join(dir, name))}`)
    }
  }
  return hash.digest('hex')
}

/**
 * Watches the folders that decide how the app starts, and calls `onChange` once a burst of
 * changes to its start files has settled. Closed with the project (ProjectResources).
 */
export class StartWatch {
  private watchers: FSWatcher[] = []
  private timer: NodeJS.Timeout | null = null
  private closed = false
  readonly key: string

  constructor(
    dirs: string[],
    selfReloading: boolean,
    private onChange: () => void,
  ) {
    this.key = StartWatch.keyOf(dirs, selfReloading)
    for (const dir of dirs) {
      try {
        const watcher = watch(dir, (_event, name) => {
          if (name && !isStartFile(String(name), selfReloading)) return
          this.schedule()
        })
        // A folder that goes away (or can't be watched) just stops being watched.
        watcher.on('error', () => watcher.close())
        this.watchers.push(watcher)
      } catch (error) {
        console.error('[gui] could not watch the project for start changes', error)
      }
    }
  }

  /** What a watch covers: the same folders, watched for the same files. */
  static keyOf(dirs: string[], selfReloading: boolean) {
    return `${dirs.join('\0')}\0${selfReloading}`
  }

  /** Runs `onChange` after DEBOUNCE_MS, starting over on each change meanwhile. */
  schedule() {
    if (this.closed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.closed) this.onChange()
    }, DEBOUNCE_MS)
  }

  close() {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
  }
}
