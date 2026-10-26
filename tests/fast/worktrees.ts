import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Whether opening a project asks where to work, read from Git's files in real repositories.

const base = realpathSync(mkdtempSync(join(tmpdir(), 'gui-worktrees-')))
const userData = join(base, 'user-data')
const projects = join(base, 'projects')
mkdirSync(userData)
mkdirSync(projects)

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
const registry = await import('../../src/main/worktree-registry')

try {
  // Asking where to work: a main checkout on a shared branch with commits, read from files.
  const main = repo('my-app')
  assert.deepEqual(await registry.whereToWorkCheck(main), { branch: 'main' })
  assert.deepEqual(await registry.whereToWorkCheck(repo('on-master', 'master')), {
    branch: 'master',
  })
  assert.equal(await registry.whereToWorkCheck(repo('fresh', 'main', true)), null, 'no commits')
  const feature = repo('feature', 'feature/thing')
  assert.equal(await registry.whereToWorkCheck(feature), null, 'feature branch')
  const detached = repo('detached')
  git(detached, 'switch', '--quiet', '--detach')
  assert.equal(await registry.whereToWorkCheck(detached), null, 'detached')
  assert.equal(await registry.whereToWorkCheck(join(base, 'user-data')), null, 'no repository')
  repo('always-main')
  assert.equal(await registry.whereToWorkCheck(alwaysMain), null, 'always open on main')
  // The remote's default branch counts as shared, whatever it's called.
  const custom = repo('custom-default', 'release-line')
  mkdirSync(join(custom, '.git/refs/remotes/origin'), { recursive: true })
  writeFileSync(
    join(custom, '.git/refs/remotes/origin/HEAD'),
    'ref: refs/remotes/origin/release-line\n',
  )
  assert.deepEqual(await registry.whereToWorkCheck(custom), { branch: 'release-line' })
  // Packed refs count as commits.
  const packed = repo('packed')
  git(packed, 'pack-refs', '--all')
  assert.ok(!existsSync(join(packed, '.git/refs/heads/main')))
  assert.deepEqual(await registry.whereToWorkCheck(packed), { branch: 'main' })

  console.log('worktrees passed')
} finally {
  rmSync(base, { recursive: true, force: true })
}
