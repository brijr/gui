import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { app } from 'electron'
import { nodeBinDir } from './node-paths'

const MARKER = '__GUI_ENV__'
const FALLBACK_PATHS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
]

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
/** Claude Code's session variables. Settings like CLAUDE_CODE_USE_BEDROCK in a shell profile come back with the login shell's env. */
const AGENT_MARKER_PREFIXES = ['CLAUDE_CODE_']

const isAgentMarker = (key: string) =>
  AGENT_MARKERS.has(key) || AGENT_MARKER_PREFIXES.some((prefix) => key.startsWith(prefix))

let cached: Promise<NodeJS.ProcessEnv> | null = null

/**
 * Apps launched from Finder get a minimal PATH. Resolve the user's login-shell
 * environment once so dev servers and agents find bun/node/git like in Terminal.
 */
export function getShellEnv(): Promise<NodeJS.ProcessEnv> {
  cached ??= loadShellEnv()
  return cached
}

async function loadShellEnv(): Promise<NodeJS.ProcessEnv> {
  const shell = process.env.SHELL || '/bin/zsh'
  const base = { ...process.env }
  // Before the login shell runs, so what the user's profile sets still comes through.
  for (const key of Object.keys(base)) if (isAgentMarker(key)) delete base[key]
  const resolved = await new Promise<string | null>((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '${MARKER}'; /usr/bin/env -0`],
      { timeout: 8000, maxBuffer: 8 * 1024 * 1024, env: { ...base, DISABLE_AUTO_UPDATE: 'true' } },
      (error, stdout) => resolve(error ? null : stdout),
    )
  })

  const env: NodeJS.ProcessEnv = { ...base }
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
  const path = new Set((testPath ?? env.PATH ?? '').split(':').filter((p) => isAbsolute(p)))
  if (testPath === undefined) for (const p of FALLBACK_PATHS) path.add(p)
  // Gui's own Node.js, for Macs without one (node-runtime.ts). Last, so the user's wins.
  if (existsSync(join(nodeBinDir(), 'node'))) path.add(nodeBinDir())
  env.PATH = [...path].join(':')

  for (const key of Object.keys(env)) {
    if (key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS') delete env[key]
  }
  return env
}

/**
 * Adds `dir` to the end of the PATH everything Gui starts from now on gets: dev servers,
 * installs, agents and terminals. For a runtime Gui installed after the env was read.
 */
export async function addToPath(dir: string) {
  const env = await getShellEnv()
  const path = (env.PATH ?? '').split(':')
  if (!path.includes(dir)) env.PATH = [...path, dir].filter(Boolean).join(':')
}
