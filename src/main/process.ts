import {
  type ChildProcess,
  type ExecFileException,
  type ExecFileOptions,
  type ExecFileSyncOptions,
  execFile as nodeExecFile,
  execFileSync as nodeExecFileSync,
  spawn as nodeSpawn,
  type SpawnOptions,
} from 'node:child_process'
import { type IPty, type IPtyForkOptions, spawn as nodeSpawnPty } from 'node-pty'
import { IS_WINDOWS } from '../shared/platform'
import { batchCommandLine, comSpec, isBatchFile } from './windows-cmd'

export type { ChildProcess, ExecFileException, ExecFileOptions, ExecFileSyncOptions, SpawnOptions }

/**
 * What an agent's terminal marks its commands with. Gui started from one inherits them, and
 * tools that detect agents act on them in everything Gui starts: Astro 7's `astro dev`
 * detaches into the background, leaving a server Gui can't stop or show the output of.
 */
const AGENT_MARKERS = new Set([
  'AGENT',
  'AI_AGENT',
  'AMP_CURRENT_THREAD_ID',
  'ANTIGRAVITY_AGENT',
  'AUGMENT_AGENT',
  'CLAUDECODE',
  'CLAUDE_PID',
  'CODEX_THREAD_ID',
  'CRUSH',
  'GEMINI_CLI',
  'OPENCODE',
  'QWEN_CODE',
])
/**
 * Session variables from a parent agent. Settings like CLAUDE_CODE_USE_BEDROCK in a shell
 * profile come back with the login shell's env and are not stripped after that.
 */
const AGENT_MARKER_PREFIXES = ['CLAUDE_CODE_', 'CODEX_']

/** Windows matches variable names without regard to case (`Path` is `PATH`); Unix doesn't. */
const envName = (key: string, windows = IS_WINDOWS) => (windows ? key.toUpperCase() : key)

/** Session markers on inherited process.env (a parent agent). Prefixes are not re-applied after the login shell, so profile settings like CLAUDE_CODE_USE_BEDROCK still reach agents. */
export const isInheritedAgentMarker = (key: string, windows = IS_WINDOWS) => {
  const name = envName(key, windows)
  return AGENT_MARKERS.has(name) || AGENT_MARKER_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/**
 * What the AppImage runtime exports for Gui itself. zsh runs every command with an exported
 * ARGV0 as its argv[0], so tools that dispatch on it (mise, rustup proxies) see "Gui.AppImage".
 */
const APPIMAGE_VARS = ['APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']
/** Lists electron-builder's AppRun puts the AppImage's mount (APPDIR) in front of. */
const APPIMAGE_PATH_LISTS = ['PATH', 'LD_LIBRARY_PATH', 'XDG_DATA_DIRS', 'GSETTINGS_SCHEMA_DIR']

/**
 * Removes, in place, what running from an AppImage added to `env`: the runtime's variables and
 * the mount's entries in path lists. A list left with nothing is dropped.
 */
function scrubAppImage(env: NodeJS.ProcessEnv) {
  const mount = env.APPDIR?.replace(/\/+$/, '')
  for (const key of APPIMAGE_VARS) delete env[key]
  if (!mount?.startsWith('/')) return
  for (const key of APPIMAGE_PATH_LISTS) {
    const value = env[key]
    if (value === undefined) continue
    const entries = value.split(':')
    const kept = entries.filter((p) => {
      const dir = p.replace(/\/+$/, '')
      return dir !== mount && !dir.startsWith(`${mount}/`)
    })
    if (kept.length === entries.length) continue
    if (kept.some(Boolean)) env[key] = kept.join(':')
    else delete env[key]
  }
}

/**
 * Drops leftover session markers, Electron and Node flags, and the AppImage's runtime env from
 * `env`. Keys in `extra` are applied after, so an adapter can set CODEX_PATH /
 * CLAUDE_CODE_EXECUTABLE.
 */
export function childEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string | undefined> = {},
  options: { browser?: 'none' | false; windows?: boolean } = {},
): NodeJS.ProcessEnv {
  const { windows = IS_WINDOWS } = options
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    const name = envName(key, windows)
    if (AGENT_MARKERS.has(name) || name.startsWith('ELECTRON_') || name === 'NODE_OPTIONS') continue
    env[key] = value
  }
  scrubAppImage(env)
  const set = (key: string, value: string | undefined) => {
    // On Windows, `PATH` replaces `Path`: a child given both gets one of them, unpredictably.
    if (windows) {
      for (const other of Object.keys(env)) {
        if (other !== key && other.toUpperCase() === key.toUpperCase()) delete env[other]
      }
    }
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  for (const [key, value] of Object.entries(extra)) set(key, value)
  if (options.browser === 'none') set('BROWSER', 'none')
  return env
}

/**
 * Inherited process.env before the login shell runs: parent-agent session vars and the
 * AppImage's runtime env don't leak in, nor into what the shell env falls back to.
 */
export function scrubInheritedEnv(env: NodeJS.ProcessEnv, windows = IS_WINDOWS): NodeJS.ProcessEnv {
  const next = { ...env }
  for (const key of Object.keys(next)) if (isInheritedAgentMarker(key, windows)) delete next[key]
  scrubAppImage(next)
  return next
}

/**
 * How `file` starts on Windows. A batch file (`npm.cmd`) runs through cmd.exe with its
 * arguments escaped (windows-cmd.ts); Node won't start one directly. No console window
 * opens for the child. `detached` is dropped: on Windows it starts the child with no console
 * at all, so every console program it runs in turn (git, node) opens a window of its own.
 * Process trees are stopped with taskkill (killProcessGroup), which needs no group.
 */
function windowsLaunch<T extends { env?: NodeJS.ProcessEnv }>(
  file: string,
  args: readonly string[],
  options: T,
): { file: string; args: readonly string[]; options: T } {
  const launch = { ...options, windowsHide: true, detached: false }
  if (!isBatchFile(file)) return { file, args, options: launch }
  return {
    file: comSpec(options.env ?? process.env),
    args: batchCommandLine(file, args),
    options: { ...launch, windowsVerbatimArguments: true },
  }
}

export interface SpawnProcessOptions extends SpawnOptions {
  extra?: Record<string, string | undefined>
  browser?: 'none' | false
}

/**
 * Starts a child with a scrubbed env. Detached processes get their own group so dispose can
 * stop them and everything they started.
 */
export function spawnProcess(
  command: string,
  args: readonly string[],
  options: SpawnProcessOptions = {},
): ChildProcess {
  const { extra = {}, browser, env, ...rest } = options
  const spawnOptions = { ...rest, env: childEnv(env ?? process.env, extra, { browser }) }
  if (IS_WINDOWS) {
    const launch = windowsLaunch(command, args, spawnOptions)
    return nodeSpawn(launch.file, launch.args, launch.options)
  }
  return nodeSpawn(command, args, spawnOptions)
}

export interface SpawnPtyOptions extends IPtyForkOptions {
  extra?: Record<string, string | undefined>
  browser?: 'none' | false
}

/** Starts `file` on a fresh PTY (terminals, dev servers) with the same env scrub as spawn. */
export function spawnPty(file: string, args: string[] | string, options: SpawnPtyOptions): IPty {
  const { extra = {}, browser, env, ...rest } = options
  return nodeSpawnPty(file, args, {
    ...rest,
    env: childEnv(env ?? process.env, extra, { browser }),
  })
}

/** One-shot `execFile`, with the same env scrub as spawn when `env` is omitted or passed. */
export const execFile: typeof nodeExecFile = ((
  file: string,
  argsOrOptionsOrCallback?: unknown,
  optionsOrCallback?: unknown,
  callback?: unknown,
) => {
  let args: readonly string[] = []
  let options: ExecFileOptions = {}
  let done: unknown
  if (typeof argsOrOptionsOrCallback === 'function') done = argsOrOptionsOrCallback
  else if (Array.isArray(argsOrOptionsOrCallback)) {
    args = argsOrOptionsOrCallback
    if (typeof optionsOrCallback === 'function') done = optionsOrCallback
    else {
      options = (optionsOrCallback as ExecFileOptions | undefined) ?? {}
      done = callback
    }
  } else {
    options = (argsOrOptionsOrCallback as ExecFileOptions | undefined) ?? {}
    done = optionsOrCallback
  }
  const launch = execLaunch(file, args, options)
  return nodeExecFile(launch.file, launch.args, launch.options, done as never)
}) as typeof nodeExecFile

export const execFileSync: typeof nodeExecFileSync = ((
  file: string,
  argsOrOptions?: unknown,
  options?: unknown,
) => {
  const launch = Array.isArray(argsOrOptions)
    ? execLaunch(file, argsOrOptions, (options as ExecFileSyncOptions | undefined) ?? {})
    : execLaunch(file, [], (argsOrOptions as ExecFileSyncOptions | undefined) ?? {})
  return nodeExecFileSync(launch.file, launch.args, launch.options)
}) as typeof nodeExecFileSync

/**
 * Writes a child's whole stdin and closes it. A child that exits without reading it (git
 * failing on its arguments, a missing repo) closes the pipe, and the write's EPIPE would be
 * an uncaught error in main; the child's own exit already says it failed.
 */
export function endInput(child: ChildProcess, input = '') {
  if (!child.stdin) return
  child.stdin.on('error', () => undefined)
  child.stdin.end(input)
}

function execLaunch<T extends { env?: NodeJS.ProcessEnv }>(
  file: string,
  args: readonly string[],
  options: T,
) {
  const scrubbed = { ...options, env: childEnv(options.env ?? process.env) }
  return IS_WINDOWS ? windowsLaunch(file, args, scrubbed) : { file, args, options: scrubbed }
}

/** Agent process groups sent SIGTERM and not yet past their SIGKILL grace period. */
const liveGroups = new Set<number>()

export function registerLiveGroup(pid: number) {
  liveGroups.add(pid)
}

export function unregisterLiveGroup(pid: number) {
  liveGroups.delete(pid)
}

/**
 * Signals the process group. Only while the leader is alive is its own pid a fallback:
 * once it has exited, the pid may belong to some other process.
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals, leaderAlive: boolean) {
  if (IS_WINDOWS) {
    // No groups and no signals: the tree is ended at once, whatever `signal` asks. Only
    // from a live leader, which taskkill finds the tree by; a dead one's pid may be reused.
    if (leaderAlive) void killProcessTree(pid)
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    if (!leaderAlive) return
    try {
      process.kill(pid, signal)
    } catch {
      // already gone
    }
  }
}

const taskkill = () => `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\taskkill.exe`

/**
 * Windows: ends `pid` and every process descended from it (`taskkill /T /F`, which finds
 * them by parent pid). Resolves once taskkill is done; false when `pid` wasn't running.
 */
export function killProcessTree(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    nodeExecFile(
      taskkill(),
      ['/PID', String(pid), '/T', '/F'],
      { windowsHide: true, timeout: 10_000 },
      (error) => resolve(!error),
    )
  })
}

/** `killProcessTree`, blocking: for quitting, when nothing runs after. */
export function killProcessTreeSync(pid: number) {
  try {
    nodeExecFileSync(taskkill(), ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 10_000,
      stdio: 'ignore',
    })
  } catch {
    // Not running any more.
  }
}

/**
 * Kills what's left of every stopped tracked group now. Quitting can't wait out the grace
 * period: the timer that would send SIGKILL dies with the app.
 */
export function killLeftoverProcesses() {
  for (const pid of liveGroups) killProcessGroup(pid, 'SIGKILL', false)
  liveGroups.clear()
}
