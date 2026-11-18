import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { IS_WINDOWS } from '../shared/platform'

async function isExecutableFile(path: string) {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** The extensions Gui can run (process.ts), in PATHEXT's order: `.exe`, and batch files. */
const RUNNABLE = ['.COM', '.EXE', '.BAT', '.CMD']

/**
 * Windows: the names `command` may have on disk. A command named without one of PATHEXT's
 * extensions is looked up with each (`git` → `git.exe`, `npm` → `npm.cmd`), as cmd.exe does.
 */
export function windowsNames(command: string, pathext = process.env.PATHEXT) {
  const listed = (pathext || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim().toUpperCase())
    .filter((ext) => RUNNABLE.includes(ext))
  const dot = command.lastIndexOf('.')
  const ext = dot > 0 ? command.slice(dot).toUpperCase() : ''
  if (RUNNABLE.includes(ext)) return [command]
  return listed.map((ext) => `${command}${ext.toLowerCase()}`)
}

/** Resolves a bare command on PATH, or checks an absolute (or `~/`) path. */
export async function findExecutable(command: string, path: string | undefined) {
  const expanded = command.startsWith('~/') ? join(homedir(), command.slice(2)) : command
  const names = IS_WINDOWS ? windowsNames(expanded) : [expanded]
  if (expanded.includes('/') || (IS_WINDOWS && expanded.includes('\\'))) {
    if (!isAbsolute(expanded)) return null
    for (const name of names) if (await isExecutableFile(name)) return name
    return null
  }
  for (const entry of (path ?? '').split(delimiter)) {
    // Windows allows a quoted entry (`"C:\Program Files\Git\cmd"`).
    const dir = IS_WINDOWS ? entry.replace(/^"(.*)"$/, '$1') : entry
    // A relative PATH entry would resolve against Gui's cwd, not the project's.
    if (!isAbsolute(dir)) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (await isExecutableFile(candidate)) return candidate
    }
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
