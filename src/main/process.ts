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

/** Session markers on inherited process.env (a parent agent). Prefixes are not re-applied after the login shell, so profile settings like CLAUDE_CODE_USE_BEDROCK still reach agents. */
export const isInheritedAgentMarker = (key: string) =>
  AGENT_MARKERS.has(key) || AGENT_MARKER_PREFIXES.some((prefix) => key.startsWith(prefix))

/**
 * Drops leftover session markers, Electron, and Node flags from `env`. Keys in `extra` are
 * applied after, so an adapter can set CODEX_PATH / CLAUDE_CODE_EXECUTABLE.
 */
export function childEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string | undefined> = {},
  options: { browser?: 'none' | false } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (AGENT_MARKERS.has(key) || key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS') continue
    env[key] = value
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  if (options.browser === 'none') env.BROWSER = 'none'
  return env
}

/** Inherited process.env before the login shell runs: parent-agent session vars don't leak in. */
export function scrubInheritedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  for (const key of Object.keys(next)) if (isInheritedAgentMarker(key)) delete next[key]
  return next
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
  return nodeSpawn(command, args, {
    ...rest,
    env: childEnv(env ?? process.env, extra, { browser }),
  })
}

export interface SpawnPtyOptions extends IPtyForkOptions {
  extra?: Record<string, string | undefined>
  browser?: 'none' | false
}

/** Starts `file` on a fresh PTY (terminals, dev servers) with the same env scrub as spawn. */
export function spawnPty(file: string, args: string[], options: SpawnPtyOptions): IPty {
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
  if (typeof argsOrOptionsOrCallback === 'function') {
    return nodeExecFile(file, withEnv({}), argsOrOptionsOrCallback as never)
  }
  if (Array.isArray(argsOrOptionsOrCallback)) {
    if (typeof optionsOrCallback === 'function') {
      return nodeExecFile(file, argsOrOptionsOrCallback, withEnv({}), optionsOrCallback as never)
    }
    return nodeExecFile(
      file,
      argsOrOptionsOrCallback,
      withEnv((optionsOrCallback as ExecFileOptions | undefined) ?? {}),
      callback as never,
    )
  }
  return nodeExecFile(
    file,
    withEnv((argsOrOptionsOrCallback as ExecFileOptions | undefined) ?? {}),
    optionsOrCallback as never,
  )
}) as typeof nodeExecFile

export const execFileSync: typeof nodeExecFileSync = ((
  file: string,
  argsOrOptions?: unknown,
  options?: unknown,
) => {
  if (Array.isArray(argsOrOptions)) {
    return nodeExecFileSync(
      file,
      argsOrOptions,
      withEnv((options as ExecFileSyncOptions | undefined) ?? {}),
    )
  }
  return nodeExecFileSync(file, withEnv((argsOrOptions as ExecFileSyncOptions | undefined) ?? {}))
}) as typeof nodeExecFileSync

function withEnv<T extends { env?: NodeJS.ProcessEnv }>(options: T): T {
  return { ...options, env: childEnv(options.env ?? process.env) }
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

/**
 * Kills what's left of every stopped tracked group now. Quitting can't wait out the grace
 * period: the timer that would send SIGKILL dies with the app.
 */
export function killLeftoverProcesses() {
  for (const pid of liveGroups) killProcessGroup(pid, 'SIGKILL', false)
  liveGroups.clear()
}
