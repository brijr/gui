import { constants } from 'node:fs'
import { access, chmod, copyFile, lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import {
  type At,
  CommandError,
  git,
  gitAsUser,
  gitOrNull,
  listWorktrees,
  openRepo,
  tail,
  type WorktreeEntry,
  withGitMutation,
} from './git'
import { getPrefs, setPrefs } from './prefs'
import { assertBranchName, branchTaken } from './ship'
import { getStartCommand, saveStartCommand } from './start-commands'
import { isTrusted, trust, untrust } from './trust'
import {
  findWorktree,
  readHead,
  registerWorktree,
  uniqueSlug,
  unregisterWorktree,
  type WorktreeRecord,
  worktreeSlug,
  worktreesDir,
} from './worktree-registry'

/**
 * Worktrees Gui makes and removes: a separate checkout of the project on its own branch, in
 * its own folder, which opens as a project of its own (its own chat, preview and install).
 * Removing one never loses work: Git refuses while it has uncommitted changes, and the branch
 * and its commits always stay.
 */

/** Local env files a worktree gets a copy of, at the project root and in its monorepo app. */
const ENV_FILES = ['.env', '.env.local', '.env.development.local']

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

/**
 * A new worktree of the project at `root`, from its current commit, on `gui/<name>`; left
 * blank, the name is the date. It's trusted when `root` is, and starts with the same app,
 * start command and Auto mode, and a copy of the local env files Git ignores.
 */
export async function createWorktree(root: string, name: string): Promise<WorktreeRecord> {
  return withGitMutation(root, async (repo) => {
    if (!repo.hasHead) throw new Error('Make a first commit before starting a worktree.')
    const parent = join(worktreesDir(), basename(repo.top))
    const leaf = await uniqueSlug(
      worktreeSlug(name),
      async (slug) => branchTaken(repo, `gui/${slug}`) || (await exists(join(parent, slug))),
    )
    const branch = `gui/${leaf}`
    await assertBranchName(repo, branch)
    const folder = join(parent, leaf)
    await mkdir(parent, { recursive: true })
    try {
      // The project's own post-checkout hook runs, as it would in Terminal.
      await gitAsUser(repo, ['worktree', 'add', '--quiet', '-b', branch, '--', folder, 'HEAD'])
    } catch (error) {
      // A failing hook still leaves the worktree made; anything else made nothing.
      if (!(error instanceof CommandError) || !(await exists(join(folder, '.git')))) {
        const output = error instanceof CommandError ? tail(error.output, 4) : String(error)
        throw new Error(`Couldn’t create the worktree:\n${output}`)
      }
    }
    const top = await realpath(folder)
    // A monorepo opened at a folder inside the repository opens at the same folder here.
    const inside = relative(repo.top, root)
    const record: WorktreeRecord = {
      path: inside ? join(top, inside) : top,
      top,
      main: root,
      branch,
      created: Date.now(),
    }
    await registerWorktree(record)
    await carryOver(root, record.path, repo)
    return record
  })
}

/** What the worktree starts with from the project it was made from. */
async function carryOver(from: string, to: string, at: At) {
  if (await isTrusted(from)) await trust(to)
  const prefs = getPrefs()
  const app = prefs.apps[from]
  setPrefs({
    ...(app ? { apps: { ...prefs.apps, [to]: app } } : {}),
    ...(prefs.askRoots.includes(from) ? { askRoots: [...prefs.askRoots, to] } : {}),
  })
  const start = await getStartCommand(from)
  if (start) await saveStartCommand(to, start)
  await copyEnvFiles(from, to, app ? ['', app] : [''], at)
}

/**
 * The env files a fresh checkout lacks: those Git ignores (a committed one is already there).
 * Never overwrites, and keeps each file's permissions.
 */
async function copyEnvFiles(from: string, to: string, dirs: string[], at: At) {
  const candidates: string[] = []
  for (const dir of dirs)
    for (const name of ENV_FILES) {
      const path = join(dir, name)
      const info = await lstat(join(from, path)).catch(() => null)
      if (info?.isFile()) candidates.push(path)
    }
  if (candidates.length === 0) return
  // Which of them Git ignores, asked where they are. (`check-ignore` can't take the literal
  // pathspecs Gui always passes.)
  const ignored = await gitOrNull({ top: from, env: at.env }, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '-z',
    '--',
    ...candidates,
  ])
  for (const path of ignored?.split('\0').filter(Boolean) ?? []) {
    if (!candidates.includes(path)) continue
    try {
      const { mode } = await lstat(join(from, path))
      await mkdir(dirname(join(to, path)), { recursive: true })
      await copyFile(join(from, path), join(to, path), constants.COPYFILE_EXCL)
      await chmod(join(to, path), mode & 0o777)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        console.error(`[gui] couldn't copy ${path} into the worktree`, error)
    }
  }
}

/**
 * Why the worktree at `root` can't be removed yet, in the user's words; null when it can.
 * Untracked files count: removing the folder would delete them.
 */
export async function removalBlocked(root: string): Promise<string | null> {
  const head = await readHead(root)
  if (!head?.mainTop) return 'This project isn’t a worktree.'
  const repo = await openRepo(root)
  if (repo.problem) return repo.problem
  const count = repo.changes.length + repo.skipped.length
  if (count === 0) return null
  return `${basename(head.top)} has ${plural(count, 'uncommitted change')}. Commit or discard them first.`
}

/**
 * Deletes the worktree's folder with `git worktree remove`, never forced, so Git refuses too
 * if anything uncommitted turned up meanwhile. The branch and its commits stay.
 */
export async function removeWorktree(root: string) {
  const blocked = await removalBlocked(root)
  if (blocked) throw new Error(blocked)
  const head = await readHead(root)
  if (!head?.mainTop) throw new Error('This project isn’t a worktree.')
  const top = head.top
  await withGitMutation(head.mainTop, async (main) => {
    try {
      await git(main, ['worktree', 'remove', '--', top])
    } catch (error) {
      if (!(error instanceof CommandError)) throw error
      throw new Error(`Couldn’t remove the worktree:\n${tail(error.output, 4)}`)
    }
    await git(main, ['worktree', 'prune']).catch(() => undefined)
  })
  await forgetSettings(root)
}

/**
 * A worktree whose folder was deleted outside Gui: Git's stale record of it goes (prune only
 * drops worktrees whose folders are gone), and so does Gui's. The branch is untouched.
 */
export async function forgetWorktree(root: string) {
  const record = await findWorktree(root)
  if (record && (await exists(record.main)) && (await isTrusted(record.main))) {
    const repo = await openRepo(record.main, { status: false }).catch(() => null)
    if (repo) await git(repo, ['worktree', 'prune']).catch(() => undefined)
  }
  await forgetSettings(root)
}

async function forgetSettings(root: string) {
  await unregisterWorktree(root)
  await untrust(root).catch(() => undefined)
  await saveStartCommand(root, null).catch(() => undefined)
  const prefs = getPrefs()
  const { [root]: _app, ...apps } = prefs.apps
  setPrefs({ apps, askRoots: prefs.askRoots.filter((saved) => saved !== root) })
}

/** The repository's worktrees, each with the folder its project opens at. */
export async function worktreesOf(root: string) {
  const repo = await openRepo(root, { status: false })
  const inside = relative(repo.top, root)
  const entries = await listWorktrees(repo)
  return entries.map((entry: WorktreeEntry) => ({
    ...entry,
    root: inside ? join(entry.path, inside) : entry.path,
    current: resolve(entry.path) === resolve(repo.top),
  }))
}
