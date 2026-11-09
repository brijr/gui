import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

async function isExecutableFile(path: string) {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolves a bare command on PATH, or checks an absolute (or `~/`) path. */
export async function findExecutable(command: string, path: string | undefined) {
  const expanded = command.startsWith('~/') ? join(homedir(), command.slice(2)) : command
  if (expanded.includes('/')) {
    return isAbsolute(expanded) && (await isExecutableFile(expanded)) ? expanded : null
  }
  for (const dir of (path ?? '').split(delimiter)) {
    // A relative PATH entry would resolve against Gui's cwd, not the project's.
    if (!isAbsolute(dir)) continue
    const candidate = join(dir, expanded)
    if (await isExecutableFile(candidate)) return candidate
  }
  return null
}

/** Another name an agent's CLI may be installed under, which other CLIs may use too. */
export interface CommandFallback {
  command: string
  /** Matches the fallback's real path (symlinks resolved) when it is this agent's CLI */
  owner: RegExp
}

/**
 * Finds an agent's CLI on PATH: `command`, else `fallback` if that resolves to the
 * agent's own program. Returns the name it was found by and its path.
 */
export async function findAgentCommand(
  command: string,
  fallback: CommandFallback | undefined,
  path: string | undefined,
): Promise<{ command: string; path: string } | null> {
  const found = await findExecutable(command, path)
  if (found) return { command, path: found }
  if (!fallback) return null
  const other = await findExecutable(fallback.command, path)
  if (!other) return null
  const target = await realpath(other).catch(() => other)
  return fallback.owner.test(target) ? { command: fallback.command, path: other } : null
}
