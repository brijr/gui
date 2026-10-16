import type { Stats } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from 'node:path'

/** Where a request's paths may be approved without asking; see `projectEditPath`. */
export interface EditScope {
  /** The project root as the agent was given it */
  root: string
  realRoot: string
  /** Real home folder: its dotfiles and dot-folders, and ~/Library, always ask. */
  home: string
  /** Other real folders whose files always ask, like Gui's own data */
  protectedDirs: string[]
}

/** A relative path that climbs out of the folder it's relative to (or isn't relative at all). */
export const isOutside = (rel: string) =>
  rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)

/** `path` relative to `dir`, or null when it isn't inside `dir` (or `dir` itself). */
function within(dir: string, path: string) {
  const rel = relative(dir, path)
  return isOutside(rel) ? null : rel
}

const isMissing = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

/** The real path of `path`'s deepest existing folder (or itself), with the rest put back. */
async function realLocation(path: string) {
  const rest: string[] = []
  let current = path
  for (;;) {
    try {
      return join(await realpath(current), ...rest)
    } catch (error) {
      const parent = dirname(current)
      if (!isMissing(error) || parent === current) throw error
      rest.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * Where an edit to `path` lands, relative to the project root, when it may be approved
 * without asking; otherwise null. That's never outside the project, never through a
 * symlink inside it (a link can point anywhere, Gui's own data included), only to a plain
 * file or one that doesn't exist yet, and never in the home folder's dotfiles, ~/Library
 * or `protectedDirs`, for projects that contain those. With `folders` (for reads and
 * searches), it may also be a folder, the project root ('') included.
 */
export async function projectEditPath(
  path: string,
  scope: EditScope,
  folders = false,
): Promise<string | null> {
  // `..` after a symlink climbs out of where the link points, not where it sits.
  if (path.includes('\0') || path.split(/[\\/]/).includes('..')) return null
  const target = resolvePath(scope.root, path)
  const rel = [scope.root, scope.realRoot]
    .map((root) => relative(root, target))
    .find((candidate) => (candidate !== '' || folders) && !isOutside(candidate))
  if (rel === undefined) return null

  // Walks down from the real root; what doesn't exist yet can't be a link.
  const parts = rel === '' ? [] : rel.split(sep)
  let current = scope.realRoot
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    let stats: Stats
    try {
      stats = await lstat(current)
    } catch (error) {
      if (isMissing(error)) break
      return null
    }
    if (stats.isSymbolicLink()) return null
    const last = index === parts.length - 1
    const allowed = stats.isDirectory() ? !last || folders : last && stats.isFile()
    if (!allowed) return null
    // A file with other hard links is also a file somewhere else.
    if (stats.isFile() && stats.nlink > 1) return null
  }

  // Where it really lands, as macOS resolves it (realpath also settles letter case).
  const real = await realLocation(join(scope.realRoot, rel)).catch(() => null)
  if (real === null || within(scope.realRoot, real) === null) return null
  if (scope.protectedDirs.some((dir) => within(dir, real) !== null)) return null
  // ~/Library and home dotfiles only matter when the project is the home folder (or one
  // above it): projects in iCloud Drive or Dropbox live under ~/Library themselves.
  if (within(scope.realRoot, scope.home) !== null) {
    if (within(join(scope.home, 'Library'), real) !== null) return null
    if (within(scope.home, real)?.startsWith('.')) return null
  }
  return rel
}
