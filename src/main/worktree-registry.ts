import { access, lstat, readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { SHARED_BRANCHES } from './branch-names'
import { getPrefs } from './prefs'

/**
 * What Gui can tell about a project's branch by reading files alone. Nothing here runs Git:
 * Git can run the project's own code (hooks, fsmonitor), so it waits for trust, and this is
 * read as a project opens, before anything is trusted.
 */

// Reading HEAD

export interface HeadState {
  /** The work tree's top folder */
  top: string
  /** Null when detached */
  branch: string | null
  /** `.git` is a file: a linked worktree, or a submodule */
  linked: boolean
  /** A worktree of another checkout; its main checkout's folder */
  mainTop: string | null
  /** The branch has at least one commit */
  hasCommits: boolean
  /** Each remote's default branch, from `refs/remotes/<remote>/HEAD` */
  remoteDefaults: string[]
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

/** The repository `root` is in, read from `.git` the way `inRepository` finds it. Null outside one. */
export async function readHead(root: string): Promise<HeadState | null> {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git')
    const info = await lstat(dotGit).catch(() => null)
    if (info) return readFrom(dir, dotGit, info.isFile())
    if (dirname(dir) === dir) return null
  }
}

async function readFrom(top: string, dotGit: string, linked: boolean): Promise<HeadState | null> {
  let gitDir = dotGit
  if (linked) {
    const pointer = /^gitdir: (.+)$/m.exec(await readFile(dotGit, 'utf8').catch(() => ''))
    if (!pointer?.[1]) return null
    gitDir = resolve(top, pointer[1].trim())
  }
  // A worktree's own folder in `.git/worktrees/<name>` names the shared one in `commondir`.
  const common = await readFile(join(gitDir, 'commondir'), 'utf8').catch(() => null)
  const commonDir = common === null ? gitDir : resolve(gitDir, common.trim())
  const head = (await readFile(join(gitDir, 'HEAD'), 'utf8').catch(() => null))?.trim()
  if (!head) return null
  const branch = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? null
  const hasCommits = branch
    ? await refExists(commonDir, `refs/heads/${branch}`)
    : /^[0-9a-f]{40,64}$/.test(head)
  return {
    top,
    branch,
    linked,
    mainTop: linked && common !== null ? dirname(commonDir) : null,
    hasCommits,
    remoteDefaults: await remoteDefaults(commonDir),
  }
}

async function refExists(commonDir: string, ref: string) {
  if (await exists(join(commonDir, ref))) return true
  const packed = await readFile(join(commonDir, 'packed-refs'), 'utf8').catch(() => '')
  return packed.split('\n').some((line) => line.endsWith(` ${ref}`))
}

async function remoteDefaults(commonDir: string) {
  const remotes = await readdir(join(commonDir, 'refs', 'remotes')).catch(() => [])
  const found = await Promise.all(
    remotes.map(async (remote) => {
      const head = await readFile(join(commonDir, 'refs', 'remotes', remote, 'HEAD'), 'utf8')
        .then((text) => text.trim())
        .catch(() => '')
      return head.startsWith(`ref: refs/remotes/${remote}/`)
        ? head.slice(`ref: refs/remotes/${remote}/`.length)
        : null
    }),
  )
  return found.filter((name): name is string => name !== null)
}

/**
 * Whether opening `root` asks where to work, and the shared branch it's on if so. Only for a
 * main checkout on a branch a team shares (main, develop, the remote's default) that has
 * commits, and not one the user said always opens on main. Reads files only.
 */
export async function whereToWorkCheck(root: string): Promise<{ branch: string } | null> {
  if (getPrefs().defaultBranchRoots.includes(root)) return null
  const head = await readHead(root)
  if (!head || head.linked || !head.branch || !head.hasCommits) return null
  const shared = SHARED_BRANCHES.has(head.branch) || head.remoteDefaults.includes(head.branch)
  return shared ? { branch: head.branch } : null
}
