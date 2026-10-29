import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

// Where to work, worktree naming, the registry, and making and removing a worktree in a real
// repository. Git runs for real; Electron, the shell's environment and GitHub are stood in for.

const base = realpathSync(mkdtempSync(join(tmpdir(), 'gui-worktrees-')))
const userData = join(base, 'user-data')
const projects = join(base, 'projects')
mkdirSync(userData)
mkdirSync(projects)
process.env.GUI_WORKTREES_DIR = join(base, 'worktrees')

const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Gui Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Gui Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim()

/** A repository on `branch`, with a first commit unless `empty`. */
function repo(name: string, branch = 'main', empty = false) {
  const root = join(projects, name)
  mkdirSync(root)
  git(root, 'init', '--quiet', `--initial-branch=${branch}`)
  if (!empty) {
    writeFileSync(join(root, 'README.md'), 'hello\n')
    git(root, 'add', '-A')
    git(root, 'commit', '--quiet', '-m', 'first')
  }
  return root
}

const alwaysMain = join(projects, 'always-main')
writeFileSync(join(userData, 'prefs.json'), JSON.stringify({ defaultBranchRoots: [alwaysMain] }))

mock.module('electron', () => ({
  app: { getPath: () => userData, on() {} },
  dialog: {},
  shell: {},
}))
mock.module('../../src/main/developer-tools', () => ({
  developerTools: { requireGit: async () => undefined },
  GIT_TOOLS_MISSING: 'Git is missing.',
}))
mock.module('../../src/main/shell-env', () => ({ getShellEnv: async () => gitEnv }))
mock.module('../../src/main/github', () => ({
  CredentialUnavailable: class extends Error {},
  connectedGitHub: async () => null,
  getGitHub: async () => ({ configured: false, profile: null, repositories: [] }),
  pullGitHub: async () => null,
  pushGitHub: async () => undefined,
}))

const registry = await import('../../src/main/worktree-registry')
const worktrees = await import('../../src/main/worktrees')
const { trust, isTrusted } = await import('../../src/main/trust')

try {
  // A new branch on the first message: a main checkout on a shared branch with commits, read from files.
  const main = repo('my-app')
  assert.deepEqual(await registry.sharedBranchCheck(main), { branch: 'main' })
  assert.deepEqual(await registry.sharedBranchCheck(repo('on-master', 'master')), {
    branch: 'master',
  })
  assert.equal(await registry.sharedBranchCheck(repo('fresh', 'main', true)), null, 'no commits')
  const feature = repo('feature', 'feature/thing')
  assert.equal(await registry.sharedBranchCheck(feature), null, 'feature branch')
  const detached = repo('detached')
  git(detached, 'switch', '--quiet', '--detach')
  assert.equal(await registry.sharedBranchCheck(detached), null, 'detached')
  assert.equal(await registry.sharedBranchCheck(join(base, 'user-data')), null, 'no repository')
  repo('always-main')
  assert.equal(await registry.sharedBranchCheck(alwaysMain), null, 'stays on main')
  // The remote's default branch counts as shared, whatever it's called.
  const custom = repo('custom-default', 'release-line')
  mkdirSync(join(custom, '.git/refs/remotes/origin'), { recursive: true })
  writeFileSync(
    join(custom, '.git/refs/remotes/origin/HEAD'),
    'ref: refs/remotes/origin/release-line\n',
  )
  assert.deepEqual(await registry.sharedBranchCheck(custom), { branch: 'release-line' })
  // Packed refs count as commits.
  const packed = repo('packed')
  git(packed, 'pack-refs', '--all')
  assert.ok(!existsSync(join(packed, '.git/refs/heads/main')))
  assert.deepEqual(await registry.sharedBranchCheck(packed), { branch: 'main' })

  // Naming
  assert.equal(registry.worktreeSlug('Pricing page'), 'pricing-page')
  assert.equal(registry.worktreeSlug('  ', new Date(2026, 9, 25)), 'oct-25')
  const used = new Set(['pricing-page', 'pricing-page-2'])
  assert.equal(
    await registry.uniqueSlug('pricing-page', async (slug) => used.has(slug)),
    'pricing-page-3',
  )

  // The registry
  const record = { path: '/x/y', top: '/x/y', main: '/x', branch: 'gui/y', created: 1 }
  await registry.registerWorktree(record)
  assert.deepEqual(await registry.findWorktree('/x/y'), record)
  await registry.unregisterWorktree('/x/y')
  assert.equal(await registry.findWorktree('/x/y'), null)

  // Making a worktree from a trusted project: its own branch and folder, trusted, with the
  // ignored env files (and only those) copied, permissions kept.
  writeFileSync(join(main, '.gitignore'), '.env.local\n')
  git(main, 'add', '.gitignore')
  git(main, 'commit', '--quiet', '-m', 'ignore env')
  writeFileSync(join(main, '.env.local'), 'SECRET=1\n')
  chmodSync(join(main, '.env.local'), 0o600)
  writeFileSync(join(main, '.env'), 'NOT_IGNORED=1\n')
  await trust(main)
  const made = await worktrees.createWorktree(main, 'Pricing page')
  assert.equal(made.branch, 'gui/pricing-page')
  assert.equal(made.path, realpathSync(join(base, 'worktrees', basename(main), 'pricing-page')))
  assert.equal(made.main, main)
  assert.equal(git(made.path, 'symbolic-ref', '--short', 'HEAD'), 'gui/pricing-page')
  assert.equal(readFileSync(join(made.path, '.env.local'), 'utf8'), 'SECRET=1\n')
  assert.equal(statSync(join(made.path, '.env.local')).mode & 0o777, 0o600)
  assert.ok(!existsSync(join(made.path, '.env')), 'an env file Git would show is left alone')
  assert.ok(await isTrusted(made.path))
  assert.deepEqual(await registry.findWorktree(made.path), made)
  const head = await registry.readHead(made.path)
  assert.equal(head?.linked, true)
  assert.equal(head?.mainTop, main)
  assert.equal(await registry.sharedBranchCheck(made.path), null, 'never in a worktree')
  assert.deepEqual(await registry.branchStatus(made.path), {
    branch: 'gui/pricing-page',
    worktree: { of: 'my-app', name: 'pricing-page' },
  })

  // The same name again gets the next free one; no name gets the date.
  assert.equal((await worktrees.createWorktree(main, 'Pricing page')).branch, 'gui/pricing-page-2')
  assert.match((await worktrees.createWorktree(main, '')).branch, /^gui\/[a-z]{3}-\d{1,2}$/)

  // Removing never loses work: refused while anything is uncommitted, folder untouched.
  writeFileSync(join(made.path, 'draft.txt'), 'not committed\n')
  assert.equal(
    await worktrees.removalBlocked(made.path),
    'pricing-page has 1 uncommitted change. Commit or discard them first.',
  )
  await assert.rejects(worktrees.removeWorktree(made.path), /1 uncommitted change/)
  assert.ok(existsSync(join(made.path, 'draft.txt')))
  assert.equal(await worktrees.removalBlocked(main), 'This project isn’t a worktree.')

  // Once it's committed, the folder goes; the branch and its commit stay.
  git(made.path, 'add', 'draft.txt')
  git(made.path, 'commit', '--quiet', '-m', 'draft')
  const commit = git(made.path, 'rev-parse', 'HEAD')
  await worktrees.removeWorktree(made.path)
  assert.ok(!existsSync(made.path))
  assert.equal(git(main, 'rev-parse', 'gui/pricing-page'), commit)
  assert.equal(await registry.findWorktree(made.path), null)
  assert.ok(!(await isTrusted(made.path)))
  assert.ok(!git(main, 'worktree', 'list').includes('pricing-page\n'))

  // A worktree folder deleted outside Gui: forgetting it prunes Git's record of it.
  const gone = await worktrees.createWorktree(main, 'Gone')
  rmSync(gone.top, { recursive: true, force: true })
  await worktrees.forgetWorktree(gone.path)
  assert.ok(!git(main, 'worktree', 'list', '--porcelain').includes(gone.top))
  assert.equal(await registry.findWorktree(gone.path), null)
  assert.ok(git(main, 'branch', '--list', 'gui/gone').includes('gui/gone'), 'the branch stays')

  console.log('worktrees passed')
} finally {
  rmSync(base, { recursive: true, force: true })
}
