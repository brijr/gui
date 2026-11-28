import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import semver from 'semver'
import { DEFAULT_SHELL } from './os'
import { execFile } from './process'

/** A login shell with a slow profile still answers in this long; a start would wait as long. */
const PROBE_TIMEOUT_MS = 20_000

/**
 * The Node.js versions a project says it needs: `engines.node` in its app's package.json and,
 * in a monorepo, the root's. Missing, unreadable and invalid ranges say nothing.
 */
export async function nodeRanges(root: string, appDir: string | null): Promise<string[]> {
  const dirs = appDir ? [join(root, appDir), root] : [root]
  const ranges: string[] = []
  for (const dir of dirs) {
    const range = await engineRange(dir)
    if (range && !ranges.includes(range)) ranges.push(range)
  }
  return ranges
}

async function engineRange(dir: string) {
  try {
    const pkg: unknown = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    const range = (pkg as { engines?: { node?: unknown } } | null)?.engines?.node
    return typeof range === 'string' && semver.validRange(range) ? range.trim() : null
  } catch {
    return null
  }
}

const meets = (version: string, ranges: string[]) =>
  ranges.every((range) => semver.satisfies(version, range, { includePrerelease: true }))

/**
 * Whether a project should run on Gui's own Node.js rather than the user's: only when it
 * states what it needs, the user's (`version`, as `node --version` printed it) is known and
 * doesn't meet that, and Gui's does. Anything unknown keeps the user's.
 */
export function wantsGuiNode(ranges: string[], version: string | null, guiVersion: string) {
  if (ranges.length === 0 || version === null) return false
  return !meets(version, ranges) && meets(guiVersion, ranges)
}

/** The oldest version every range allows, to name on a card ("20.19.0"); null if none is. */
export function oldestAllowed(ranges: string[]) {
  let oldest: string | null = null
  for (const range of ranges) {
    const min = semver.minVersion(range)?.version
    if (!min) return null
    if (!oldest || semver.gt(min, oldest)) oldest = min
  }
  return oldest && meets(oldest, ranges) ? oldest : null
}

/** The version in `node --version` output, after anything a shell profile printed first. */
export function parseNodeVersion(output: string) {
  const matches = [...output.matchAll(/\bv(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/g)]
  return matches.at(-1)?.[1] ?? null
}

/**
 * The version of the `node` the project's commands would run: asked of a login shell in its
 * folder, as the dev server starts (version managers that pick by folder answer for it).
 * Null when it can't tell (no `node`, a shell that didn't answer in time).
 */
export function nodeVersionIn(cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      env.SHELL || DEFAULT_SHELL,
      ['-lc', 'node --version'],
      { cwd, env, timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error ? null : parseNodeVersion(String(stdout))),
    )
  })
}
