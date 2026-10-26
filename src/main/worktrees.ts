import { constants } from 'node:fs'
import { access, chmod, copyFile, lstat, mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import {
  type At,
  CommandError,
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
import { isTrusted, trust } from './trust'
import {
  registerWorktree,
  uniqueSlug,
  type WorktreeRecord,
  worktreeSlug,
  worktreesDir,
} from './worktree-registry'

/**
 * Worktrees Gui makes: a separate checkout of the project on its own branch, in its own
 * folder, which opens as a project of its own (its own chat, preview and install).
 */

/** Local env files a worktree gets a copy of, at the project root and in its monorepo app. */
const ENV_FILES = ['.env', '.env.local', '.env.development.local']

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

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
