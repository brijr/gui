import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { app } from 'electron'
import { nodeBinDir } from './node-paths'
import { DEFAULT_SHELL } from './os'
import { execFile, scrubInheritedEnv } from './process'

const MARKER = '__GUI_ENV__'
/** Most login shells answer in well under a second; this long and Gui goes on without. */
const FIRST_READ_MS = 8000
/** The read again, in the background, for a shell that's slow (first run of nvm, oh-my-zsh). */
const RETRY_READ_MS = 60_000
const FALLBACK_PATHS = [
  '/opt/homebrew/bin',
  '/home/linuxbrew/.linuxbrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
]
/**
 * Where installers put tools for one user (the Claude Code installer, bun, Volta, pnpm, npm's
 * own global folder, asdf and mise shims): added, when they exist, only while the login
 * shell's PATH couldn't be read.
 */
const USER_BIN_DIRS = [
  '.local/bin',
  '.bun/bin',
  '.volta/bin',
  '.npm-global/bin',
  'Library/pnpm',
  '.local/share/pnpm',
  '.asdf/shims',
  '.local/share/mise/shims',
]

/** Runs the login shell and resolves with its output, or null if it failed or took too long. */
export type ShellRead = (timeoutMs: number) => Promise<string | null>

/**
 * The user's login-shell environment, read once. When the shell doesn't answer in time, a
 * fallback (Gui's own environment and the usual tool folders) stands in while it's read
 * again in the background with a longer limit; when that answers, the same env object
 * becomes the real one, so everything started from then on gets it, and `onArrived`
 * listeners run. What's already running keeps what it started with.
 */
export function shellEnvLoader(read: ShellRead, home = homedir()) {
  let cached: Promise<NodeJS.ProcessEnv> | null = null
  const listeners = new Set<() => void>()
  /** Folders `addToPath` added, kept when the real env replaces the fallback. */
  const added: string[] = []

  async function load() {
    const output = await read(FIRST_READ_MS)
    if (output !== null) return buildEnv(output, home)
    console.warn(
      `[gui] the login shell didn't answer within ${FIRST_READ_MS / 1000}s; using a fallback PATH until it does`,
    )
    const env = buildEnv(null, home)
    void retry(env)
    return env
  }

  async function retry(env: NodeJS.ProcessEnv) {
    const output = await read(RETRY_READ_MS)
    if (output === null) {
      console.warn(
        `[gui] the login shell didn't answer within ${RETRY_READ_MS / 1000}s either; keeping the fallback PATH`,
      )
      return
    }
    const next = buildEnv(output, home)
    const path = (next.PATH ?? '').split(':')
    for (const dir of added) if (!path.includes(dir)) path.push(dir)
    next.PATH = path.filter(Boolean).join(':')
    for (const key of Object.keys(env)) delete env[key]
    Object.assign(env, next)
    console.log("[gui] read the login shell's environment; using it from now on")
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[gui] a shell env listener failed', error)
      }
    }
  }

  return {
    get(): Promise<NodeJS.ProcessEnv> {
      cached ??= load()
      return cached
    },
    /** Runs `listener` when the real env replaces a fallback; returns how to stop. */
    onArrived(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async addToPath(dir: string) {
      const env = await this.get()
      if (!added.includes(dir)) added.push(dir)
      const path = (env.PATH ?? '').split(':')
      if (!path.includes(dir)) env.PATH = [...path, dir].filter(Boolean).join(':')
    },
  }
}

/** `$SHELL -ilc`: an interactive login shell, as Terminal opens, printing its env. */
function readLoginShell(timeoutMs: number): Promise<string | null> {
  const shell = process.env.SHELL || DEFAULT_SHELL
  const base = scrubInheritedEnv(process.env)
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '${MARKER}'; /usr/bin/env -0`],
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...base, DISABLE_AUTO_UPDATE: 'true' },
      },
      (error, stdout) => resolve(error ? null : stdout),
    )
  })
}

/** The env Gui gives what it starts: the shell's (`output`), or the fallback when null. */
function buildEnv(output: string | null, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...scrubInheritedEnv(process.env) }
  if (output !== null) {
    const start = output.lastIndexOf(MARKER)
    for (const entry of output.slice(start + MARKER.length).split('\0')) {
      const eq = entry.indexOf('=')
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
    }
  }

  // Unpackaged builds (dev, e2e) can stand in for a Mac without some tool (GUI_PATH, used
  // as the whole PATH, with no fallbacks); packaged builds never do.
  const testPath = !app.isPackaged ? process.env.GUI_PATH : undefined
  // A relative entry (`./node_modules/.bin`, or an empty one, which means `.`) would find
  // `git` or `gh` inside whatever project a command runs in.
  const path = new Set((testPath ?? env.PATH ?? '').split(':').filter((p) => isAbsolute(p)))
  if (testPath === undefined) {
    if (output === null && isAbsolute(home)) {
      for (const dir of USER_BIN_DIRS) {
        const full = join(home, dir)
        if (existsSync(full)) path.add(full)
      }
    }
    for (const p of FALLBACK_PATHS) path.add(p)
  }
  // Gui's own Node.js, for Macs without one (node-runtime.ts). Last, so the user's wins.
  if (existsSync(join(nodeBinDir(), 'node'))) path.add(nodeBinDir())
  env.PATH = [...path].join(':')

  for (const key of Object.keys(env)) {
    if (key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS') delete env[key]
  }
  return env
}

const loader = shellEnvLoader(readLoginShell)

/**
 * Apps launched from Finder get a minimal PATH. Resolve the user's login-shell
 * environment once so dev servers and agents find bun/node/git like in Terminal.
 */
export function getShellEnv(): Promise<NodeJS.ProcessEnv> {
  return loader.get()
}

/**
 * Runs `listener` once the login shell's environment arrives after a fallback stood in
 * (`shellEnvLoader`): what found nothing on the fallback PATH can look again.
 */
export function onShellEnvArrived(listener: () => void) {
  return loader.onArrived(listener)
}

/**
 * Adds `dir` to the end of the PATH everything Gui starts from now on gets: dev servers,
 * installs, agents and terminals. For a runtime Gui installed after the env was read.
 */
export function addToPath(dir: string) {
  return loader.addToPath(dir)
}
