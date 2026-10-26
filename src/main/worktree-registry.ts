import { access, lstat, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { app } from 'electron'
import type { BranchStatus } from '../shared/types'
import { writeFileAtomic } from './atomic-file'
import { SHARED_BRANCHES, slugify } from './branch-names'
import { getPrefs } from './prefs'

/**
 * Worktrees Gui made, and what Gui can tell about a project's branch by reading files alone.
 * Nothing here runs Git: Git can run the project's own code (hooks, fsmonitor), so it waits
 * for trust, and this is read as a project opens, before anything is trusted.
 */

/** Where new worktrees go: `~/.gui/worktrees/<project>/<name>`. Tests set GUI_WORKTREES_DIR. */
export function worktreesDir() {
  return process.env.GUI_WORKTREES_DIR || join(homedir(), '.gui', 'worktrees')
}

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

/** The branch the toolbar shows; null outside a repository. */
export async function branchStatus(root: string): Promise<BranchStatus | null> {
  const head = await readHead(root)
  if (!head) return null
  return {
    branch: head.branch,
    worktree: head.mainTop ? { of: basename(head.mainTop), name: basename(head.top) } : null,
  }
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

// Naming

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** "Pricing page" → `pricing-page`; left blank, the date, like `oct-25`. */
export function worktreeSlug(name: string, now = new Date()) {
  if (!name.trim()) return `${MONTHS[now.getMonth()]}-${now.getDate()}`
  return slugify(name)
}

/** `slug`, or `slug-2`, `slug-3`… while `taken` says the name is used. */
export async function uniqueSlug(slug: string, taken: (candidate: string) => Promise<boolean>) {
  if (!(await taken(slug))) return slug
  for (let n = 2; ; n++) if (!(await taken(`${slug}-${n}`))) return `${slug}-${n}`
}

// The registry

export interface WorktreeRecord {
  /** The project's folder in the worktree (below `top` in a monorepo) */
  path: string
  /** The worktree's top folder */
  top: string
  /** The project it was made from */
  main: string
  branch: string
  created: number
}

const file = () => join(app.getPath('userData'), 'worktrees.json')

const isRecord = (value: unknown): value is WorktreeRecord => {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.path === 'string' &&
    typeof record.top === 'string' &&
    typeof record.main === 'string' &&
    typeof record.branch === 'string' &&
    typeof record.created === 'number'
  )
}

export async function loadWorktrees(): Promise<WorktreeRecord[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file(), 'utf8'))
    return Array.isArray(parsed) ? parsed.filter(isRecord) : []
  } catch {
    return []
  }
}

export async function findWorktree(path: string) {
  return (await loadWorktrees()).find((record) => record.path === path) ?? null
}

let pendingWrite: Promise<unknown> = Promise.resolve()

/** One change at a time, each on the list the last one wrote, so none is lost. */
function update(change: (records: WorktreeRecord[]) => WorktreeRecord[]) {
  const task = pendingWrite.then(async () => {
    const records = await loadWorktrees()
    await writeFileAtomic(file(), JSON.stringify(change(records), null, 2))
  })
  pendingWrite = task.catch(() => undefined)
  return task
}

export function registerWorktree(record: WorktreeRecord) {
  return update((records) => [...records.filter((r) => r.path !== record.path), record])
}

export function unregisterWorktree(path: string) {
  return update((records) => records.filter((record) => record.path !== path))
}
