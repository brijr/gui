import { existsSync } from 'node:fs'
import { delimiter, isAbsolute } from 'node:path'
import { app } from 'electron'
import { IS_WINDOWS } from '../shared/platform'
import { nodeBinDir, nodeExecutable } from './node-paths'
import { DEFAULT_SHELL } from './os'
import { execFile, scrubInheritedEnv } from './process'

const MARKER = '__GUI_ENV__'
const FALLBACK_PATHS = [
  '/opt/homebrew/bin',
  '/home/linuxbrew/.linuxbrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
]

let cached: Promise<NodeJS.ProcessEnv> | null = null

/**
 * Apps launched from Finder get a minimal PATH. Resolve the user's login-shell
 * environment once so dev servers and agents find bun/node/git like in Terminal.
 */
export function getShellEnv(): Promise<NodeJS.ProcessEnv> {
  cached ??= loadShellEnv()
  return cached
}

/** Login-shell output: `MARKER` then the environment, NUL-separated. */
function readLoginShell(base: NodeJS.ProcessEnv) {
  const shell = process.env.SHELL || DEFAULT_SHELL
  return new Promise<string | null>((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '${MARKER}'; /usr/bin/env -0`],
      { timeout: 8000, maxBuffer: 8 * 1024 * 1024, env: { ...base, DISABLE_AUTO_UPDATE: 'true' } },
      (error, stdout) => resolve(error ? null : stdout),
    )
  })
}

/**
 * Windows: a program started from the Start menu already has the user's whole environment,
 * and there is no login shell to ask. Its PATH is named `Path`; Gui reads and sets `PATH`,
 * so it's renamed (process.ts keeps one spelling for children).
 */
function windowsEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  let path: string | undefined
  for (const [key, value] of Object.entries(base)) {
    if (key.toUpperCase() === 'PATH') path ??= value
    else env[key] = value
  }
  if (path !== undefined) env.PATH = path
  return env
}

async function loadShellEnv(): Promise<NodeJS.ProcessEnv> {
  const base = scrubInheritedEnv(process.env)
  const resolved = IS_WINDOWS ? null : await readLoginShell(base)

  const env: NodeJS.ProcessEnv = IS_WINDOWS ? windowsEnv(base) : { ...base }
  if (resolved) {
    const start = resolved.lastIndexOf(MARKER)
    for (const entry of resolved.slice(start + MARKER.length).split('\0')) {
      const eq = entry.indexOf('=')
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
    }
  }

  // Unpackaged builds (dev, e2e) can stand in for a Mac without some tool (GUI_PATH, used
  // as the whole PATH, with no fallbacks); packaged builds never do.
  const testPath = !app.isPackaged ? process.env.GUI_PATH : undefined
  // A relative entry (`./node_modules/.bin`, or an empty one, which means `.`) would find
  // `git` or `gh` inside whatever project a command runs in.
  const path = new Set((testPath ?? env.PATH ?? '').split(delimiter).filter((p) => isAbsolute(p)))
  if (testPath === undefined && !IS_WINDOWS) for (const p of FALLBACK_PATHS) path.add(p)
  // Gui's own Node.js, for Macs without one (node-runtime.ts). Last, so the user's wins.
  if (existsSync(nodeExecutable())) path.add(nodeBinDir())
  env.PATH = [...path].join(delimiter)

  for (const key of Object.keys(env)) {
    const name = IS_WINDOWS ? key.toUpperCase() : key
    if (name.startsWith('ELECTRON_') || name === 'NODE_OPTIONS') delete env[key]
  }
  return env
}

/**
 * Adds `dir` to the end of the PATH everything Gui starts from now on gets: dev servers,
 * installs, agents and terminals. For a runtime Gui installed after the env was read.
 */
export async function addToPath(dir: string) {
  const env = await getShellEnv()
  const path = (env.PATH ?? '').split(delimiter)
  if (!path.includes(dir)) env.PATH = [...path, dir].filter(Boolean).join(delimiter)
}
