import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'

const MARKER = '__GRAT_ENV__'
const FALLBACK_PATHS = [
  '/opt/homebrew/bin',
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

async function loadShellEnv(): Promise<NodeJS.ProcessEnv> {
  const shell = process.env.SHELL || '/bin/zsh'
  const base = { ...process.env }
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

  // A relative entry (`./node_modules/.bin`, or an empty one, which means `.`) would find
  // `git` or `gh` inside whatever project a command runs in.
  const path = new Set((env.PATH ?? '').split(':').filter((p) => isAbsolute(p)))
  for (const p of FALLBACK_PATHS) path.add(p)
  env.PATH = [...path].join(':')

  for (const key of Object.keys(env)) {
    if (key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS') delete env[key]
  }
  return env
}
