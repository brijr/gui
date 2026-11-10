import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from '../src/main/process'
import { MAX_CHECKPOINT_FILE_BYTES } from '../src/shared/bounded'

// Checkpoints (docs/architecture.md): "before and after every turn the working tree is
// snapshotted into a shadow git repo under the app's data folder (your `.git` is never
// touched). Undo restores the files that turn (and any later ones) changed to how they were
// before it; files you edited yourself are left alone. Redo reverses the undo."
//
// These run the real `Checkpoints` with real git on temp folders. Which files an undo names
// is decided by `ChatController.restoreTurn` in chat.ts, which needs Electron; `turn` and
// `undo` below make the same calls in the same order.

// Checkpoints asks `developerTools` whether git can run, and that reads the login shell's
// environment through Electron (shell-env.ts). Here the environment is this process's.
mock.module('../src/main/shell-env', () => ({
  getShellEnv: async () => ({ PATH: process.env.PATH }),
  addToPath: async () => {},
}))
const { Checkpoints, shadowRepoName } = await import('../src/main/checkpoints')
const { developerTools } = await import('../src/main/developer-tools')
/** False on a Mac without Apple's developer tools, where running git would offer to install them. */
const gitRuns = await developerTools.gitAvailable()

type Checkpoints = InstanceType<typeof Checkpoints>

/** macOS's `/usr/bin/git` only finds the real one, and takes three times as long each call. */
function realGitDir() {
  try {
    return dirname(execFileSync('xcrun', ['--find', 'git'], { encoding: 'utf8' }).trim())
  } catch {
    return null
  }
}

let base = ''
let store = ''
/** Git's environment: no config of the user's, and a home folder that isn't theirs. */
let env: NodeJS.ProcessEnv = {}

beforeAll(() => {
  base = mkdtempSync(join(realpathSync(tmpdir()), 'gui-checkpoints-'))
  store = join(base, 'gui-data', 'checkpoints')
  mkdirSync(join(base, 'home'))
  env = {
    PATH: [realGitDir(), process.env.PATH].filter(Boolean).join(':'),
    HOME: join(base, 'home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  }
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

/** A file's text, or null when it isn't there. */
type Text = string | null

function put(root: string, file: string, text: Text) {
  const path = join(root, file)
  if (text === null) return rmSync(path, { force: true })
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const get = (root: string, file: string): Text =>
  existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : null

const state = (root: string, files: string[]) =>
  Object.fromEntries(files.map((file) => [file, get(root, file)]))

function project(name: string, files: Record<string, string> = {}) {
  const root = join(base, name)
  mkdirSync(root, { recursive: true })
  for (const [file, text] of Object.entries(files)) put(root, file, text)
  return root
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()

/** Commits what's in the repository at `dir`. */
function commit(dir: string) {
  git(dir, 'add', '-A')
  git(dir, '-c', 'user.name=me', '-c', 'user.email=me@example.com', 'commit', '-qm', 'mine')
}

/** A repository of the user's own in `dir`, with what's there committed. */
function ownRepo(dir: string) {
  git(dir, 'init', '--quiet')
  commit(dir)
}

/** Every file checkpoint `sha` holds, read from the shadow repo itself. */
const recorded = (root: string, sha: string) =>
  git(root, `--git-dir=${join(store, shadowRepoName(root))}`, 'ls-tree', '-r', '--name-only', sha)
    .split('\n')
    .filter(Boolean)
    .sort()

/** Everything under `dir`, contents and times: the same string means nothing was touched. */
function fingerprint(dir: string): string {
  const hash = createHash('sha256')
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name)
      const info = lstatSync(path)
      hash.update(`${path}\0${info.mode}\0${info.size}\0${info.mtimeMs}\0`)
      if (info.isDirectory()) walk(path)
      else if (info.isFile()) hash.update(readFileSync(path))
    }
  }
  walk(dir)
  return hash.digest('hex')
}

interface Turn {
  before: string
  after: string
  /** The files the turn changed, as the chat keeps them (`turn.changes`) */
  paths: string[]
}

/** One agent turn: a checkpoint, the agent's changes (files, or what `changes` does), a checkpoint. */
async function turn(
  points: Checkpoints,
  root: string,
  changes: Record<string, Text> | (() => void),
) {
  const before = await points.snapshot('before turn')
  if (typeof changes === 'function') changes()
  else for (const [file, text] of Object.entries(changes)) put(root, file, text)
  const after = await points.snapshot('after turn')
  const paths = (await points.diff(before, after)).map((change) => change.path).sort()
  return { before, after, paths } satisfies Turn
}

/**
 * Undo of `turns` (a turn and every later one), as `restoreTurn` does it. `warned` is what
 * the "Overwrite changes made outside Gui?" prompt would list; `alone` is the folders the
 * turn's notice then names ("Undo left my-app alone. …"); `redo` is the way back, and
 * resolves to the folders it left alone in turn.
 */
async function undo(points: Checkpoints, turns: Turn[]) {
  const current = await points.snapshot('before restoring')
  const paths = [...new Set(turns.flatMap((each) => each.paths))]
  const last = turns.at(-1)
  const edited = last ? await points.changedAmong(last.after, current, paths) : []
  const kept = await points.leftAlone(turns[0].before, edited)
  const warned = edited.filter((path) => !kept.includes(path))
  const alone = await points.restore(turns[0].before, paths)
  return { warned, alone, redo: () => points.restore(current, paths) }
}

describe.skipIf(!gitRuns)('undoing a turn', () => {
  interface Row {
    file: string
    /** Before the turn */
    start: Text
    /** What the agent's turn leaves, when it touches the file */
    turn?: Text
    /** What the user leaves afterwards, in their own editor */
    user?: Text
    /** After Undo */
    undone: Text
    why: string
  }
  // biome-ignore format: one file a line reads as a table
  const rows: Row[] = [
    { file: 'src/changed.ts', start: 'old\n', turn: 'new\n', undone: 'old\n', why: 'a file the turn changed goes back' },
    { file: 'src/added.ts', start: null, turn: 'new\n', undone: null, why: 'a file the turn added goes' },
    { file: 'src/removed.ts', start: 'old\n', turn: null, undone: 'old\n', why: 'a file the turn deleted comes back' },
    { file: 'src/pages/new/index.ts', start: null, turn: 'new\n', undone: null, why: 'a file the turn added in new folders goes' },
    { file: 'src/both.ts', start: 'old\n', turn: 'new\n', user: 'mine\n', undone: 'old\n', why: 'a file the turn changed and the user then edited goes back (after the warning)' },
    { file: 'src/untouched.ts', start: 'old\n', undone: 'old\n', why: 'a file nobody touched stays' },
    { file: 'src/mine.ts', start: 'old\n', user: 'mine\n', undone: 'mine\n', why: 'a file only the user edited is left alone' },
    { file: 'src/mine-new.ts', start: null, user: 'mine\n', undone: 'mine\n', why: 'a file the user added is left alone' },
    { file: 'src/mine-gone.ts', start: 'old\n', user: null, undone: null, why: 'a file the user deleted stays deleted' },
    { file: '.gitignore', start: 'ignored/\n', undone: 'ignored/\n', why: "the project's ignore file stays" },
    { file: '.env', start: 'KEY=1\n', turn: 'KEY=2\n', undone: 'KEY=2\n', why: 'a secret is never recorded, so undo leaves it' },
    { file: 'node_modules/pkg/index.js', start: 'old\n', turn: 'new\n', undone: 'new\n', why: "dependencies aren't recorded" },
    { file: 'dist/app.js', start: 'old\n', turn: 'new\n', undone: 'new\n', why: "build output isn't recorded" },
    { file: 'ignored/cache.bin', start: 'old\n', turn: 'new\n', undone: 'new\n', why: "what the project ignores isn't recorded" },
  ]
  const files = rows.map((row) => row.file)

  let root = ''
  let ran: Turn
  let warned: string[] = []
  let beforeUndo: Record<string, Text> = {}
  let afterUndo: Record<string, Text> = {}
  let afterRedo: Record<string, Text> = {}
  let newFoldersLeft = true

  beforeAll(async () => {
    root = project('undo')
    const points = new Checkpoints(root, store, env)
    for (const row of rows) put(root, row.file, row.start)
    const changes: Record<string, Text> = {}
    for (const row of rows) if (row.turn !== undefined) changes[row.file] = row.turn
    ran = await turn(points, root, changes)
    for (const row of rows) if (row.user !== undefined) put(root, row.file, row.user)
    beforeUndo = state(root, files)

    const undone = await undo(points, [ran])
    warned = undone.warned
    afterUndo = state(root, files)
    newFoldersLeft = existsSync(join(root, 'src/pages'))

    await undone.redo()
    afterRedo = state(root, files)
  })

  test('the turn is credited with the files it changed, and only those', () => {
    expect(ran.paths).toEqual([
      'src/added.ts',
      'src/both.ts',
      'src/changed.ts',
      'src/pages/new/index.ts',
      'src/removed.ts',
    ])
  })

  test.each(rows)('$why ($file)', (row) => {
    expect(afterUndo[row.file]).toBe(row.undone)
  })

  test('folders the undo leaves empty go, and no others', () => {
    expect(newFoldersLeft).toBe(false)
    expect(existsSync(join(root, 'src'))).toBe(true)
  })

  test('the warning lists the files of the turn that the user edited since, and no others', () => {
    expect(warned).toEqual(['src/both.ts'])
  })

  test('Redo reverses the undo: every file is as it was just before it', () => {
    expect(afterRedo).toEqual(beforeUndo)
  })

  test('a checkpoint holds the project’s files, without secrets, dependencies or build output', () => {
    expect(recorded(root, ran.after)).toEqual([
      '.gitignore',
      'src/added.ts',
      'src/both.ts',
      'src/changed.ts',
      'src/mine-gone.ts',
      'src/mine.ts',
      'src/pages/new/index.ts',
      'src/untouched.ts',
    ])
  })

  test('a project without a repository gets none: the shadow one is in Gui’s data', () => {
    expect(existsSync(join(root, '.git'))).toBe(false)
    expect(existsSync(join(store, shadowRepoName(root), 'HEAD'))).toBe(true)
  })
})

describe.skipIf(!gitRuns)('undoing a turn and the ones after it', () => {
  const files = ['a.ts', 'b.ts', 'c.ts', 'one.ts', 'two.ts']
  let afterTurns: Record<string, Text> = {}
  let newestUndone: Record<string, Text> = {}
  let newestRedone: Record<string, Text> = {}
  let bothUndone: Record<string, Text> = {}
  let bothRedone: Record<string, Text> = {}
  let warned: string[] = ['unset']

  beforeAll(async () => {
    const root = project('turns', { 'a.ts': 'start\n', 'b.ts': 'start\n', 'c.ts': 'start\n' })
    const points = new Checkpoints(root, store, env)
    const first = await turn(points, root, { 'a.ts': 'first\n', 'one.ts': 'first\n' })
    // Between the turns, the user edits a file neither turn touches.
    put(root, 'c.ts', 'mine\n')
    const second = await turn(points, root, {
      'a.ts': 'second\n',
      'b.ts': 'second\n',
      'two.ts': '',
    })
    afterTurns = state(root, files)

    const newest = await undo(points, [second])
    newestUndone = state(root, files)
    await newest.redo()
    newestRedone = state(root, files)

    const both = await undo(points, [first, second])
    warned = both.warned
    bothUndone = state(root, files)
    await both.redo()
    bothRedone = state(root, files)
  })

  test('the newest turn alone: earlier turns keep their work', () => {
    expect(newestUndone).toEqual({
      'a.ts': 'first\n',
      'b.ts': 'start\n',
      'c.ts': 'mine\n',
      'one.ts': 'first\n',
      'two.ts': null,
    })
    expect(newestRedone).toEqual(afterTurns)
  })

  test('an earlier turn: it and every later one go, and the user’s own edit stays', () => {
    expect(bothUndone).toEqual({
      'a.ts': 'start\n',
      'b.ts': 'start\n',
      'c.ts': 'mine\n',
      'one.ts': null,
      'two.ts': null,
    })
    expect(warned).toEqual([])
    expect(bothRedone).toEqual(afterTurns)
  })
})

describe.skipIf(!gitRuns)("the project's own .git is never touched", () => {
  test('snapshots and undo leave a repository exactly as it was, and run no hooks', async () => {
    const root = project('repo', { 'src/app.ts': 'committed\n' })
    ownRepo(root)
    // The project's hooks, and the ones the user's git template would copy into a new repo.
    const marker = join(base, 'hook-ran')
    const template = join(base, 'template')
    for (const hook of ['post-checkout', 'pre-commit', 'post-commit', 'post-index-change']) {
      for (const dir of [join(root, '.git'), template]) {
        put(dir, `hooks/${hook}`, `#!/bin/sh\necho ${hook} >> '${marker}'\n`)
        chmodSync(join(dir, 'hooks', hook), 0o755)
      }
    }
    const own = fingerprint(join(root, '.git'))

    // Gui started from a terminal inside a git command would inherit these, which point
    // git at the project's repository instead of the shadow one.
    const inherited = {
      ...env,
      GIT_TEMPLATE_DIR: template,
      GIT_DIR: join(root, '.git'),
      GIT_WORK_TREE: root,
      GIT_INDEX_FILE: join(root, '.git', 'index'),
      GIT_OBJECT_DIRECTORY: join(root, '.git', 'objects'),
    }
    const points = new Checkpoints(root, store, inherited)
    const ran = await turn(points, root, { 'src/app.ts': 'agent\n', 'src/new.ts': 'agent\n' })
    expect(await points.read(ran.after, 'src/app.ts')).toBe('agent\n')
    await undo(points, [ran])
    expect(state(root, ['src/app.ts', 'src/new.ts'])).toEqual({
      'src/app.ts': 'committed\n',
      'src/new.ts': null,
    })

    expect(fingerprint(join(root, '.git'))).toBe(own)
    expect(existsSync(marker)).toBe(false)
    expect(recorded(root, ran.after)).toEqual(['src/app.ts', 'src/new.ts'])
    // The template's hook did reach the shadow repo; it is there and was not run.
    expect(existsSync(join(store, shadowRepoName(root), 'hooks', 'post-checkout'))).toBe(true)
  })

  describe('paths and versions it refuses', () => {
    let root = ''
    let points: Checkpoints
    let sha = ''
    beforeAll(async () => {
      root = project('refusals', { 'src/app.ts': 'x\n' })
      put(root, '.git/config', '[core]\n')
      put(root, 'vendor/lib/.git/hooks/pre-commit', '#!/bin/sh\n')
      points = new Checkpoints(root, store, env)
      sha = await points.snapshot('only')
    })

    const paths: Array<[path: string, error: RegExp, why: string]> = [
      ['.git/config', /Refusing to touch \.git/, "the repository's config"],
      ['.git/hooks/pre-commit', /Refusing to touch \.git/, 'a hook'],
      ['.git', /Refusing to touch \.git/, 'the folder itself'],
      ['.GIT/config', /Refusing to touch \.git/, 'in another letter case'],
      ['src/../.git/HEAD', /Refusing to touch \.git/, 'by way of another folder'],
      ['vendor/lib/.git/hooks/pre-commit', /Refusing to touch \.git/, "a nested repository's"],
      ['../outside.ts', /escapes project root/, 'above the project'],
      ['src/../../outside.ts', /escapes project root/, 'above it, from inside'],
      ['.', /escapes project root/, 'the project folder'],
      ['/etc/hosts', /Invalid path/, 'an absolute path'],
      ['', /Invalid path/, 'an empty path'],
      ['src/app.ts\0', /Invalid path/, 'a NUL'],
    ]
    test.each(paths)('%p: %p (%s)', async (path, error) => {
      const before = fingerprint(root)
      await expect(points.restore(sha, [path])).rejects.toThrow(error)
      await expect(points.restore(sha, ['src/app.ts', path])).rejects.toThrow(error)
      await expect(points.read(sha, path)).rejects.toThrow(error)
      await expect(points.changedAmong(sha, sha, [path])).rejects.toThrow(error)
      expect(fingerprint(root)).toBe(before)
    })

    // A version is a commit id and nothing else: never a branch, a ref or an option for git.
    const versions = ['HEAD', 'main', '--output=/tmp/x', '-h', 'abc', `${'a'.repeat(40)}^`, '', ' ']
    test.each(versions)('version %p', async (version) => {
      const invalid = /Invalid version ID/
      await expect(points.restore(version, ['src/app.ts'])).rejects.toThrow(invalid)
      await expect(points.read(version, 'src/app.ts')).rejects.toThrow(invalid)
      await expect(points.diff(version, sha)).rejects.toThrow(invalid)
      await expect(points.diff(sha, version)).rejects.toThrow(invalid)
      await expect(points.changedAmong(sha, version, ['src/app.ts'])).rejects.toThrow(invalid)
      await expect(points.hasCommits([sha, version])).rejects.toThrow(invalid)
      await expect(points.trees([version])).rejects.toThrow(invalid)
    })

    test('a version that was never saved is reported missing, and restores nothing', async () => {
      const unknown = 'f'.repeat(40)
      expect(await points.hasCommits([sha])).toBe(true)
      expect(await points.hasCommits([sha, unknown])).toBe(false)
      await expect(points.restore(unknown, ['src/app.ts'])).rejects.toThrow(/git ls-tree failed/)
      expect(get(root, 'src/app.ts')).toBe('x\n')
    })
  })
})

describe.skipIf(!gitRuns)('undo never writes outside the project', () => {
  test('a file the turn added is not removed through a link that replaced its folder', async () => {
    const root = project('link-remove', { 'keep.ts': 'x\n' })
    const outside = project('link-remove-outside', { 'new.ts': 'theirs\n' })
    const points = new Checkpoints(root, store, env)
    const ran = await turn(points, root, { 'gen/new.ts': 'agent\n' })
    rmSync(join(root, 'gen'), { recursive: true })
    symlinkSync(outside, join(root, 'gen'))
    await expect(points.restore(ran.before, ran.paths)).rejects.toThrow(/outside project root/)
    expect(get(outside, 'new.ts')).toBe('theirs\n')
  })

  test('a file the turn changed is not restored through one: the folder comes back', async () => {
    const root = project('link-restore', { 'pages/index.html': 'old\n' })
    const outside = project('link-restore-outside', { 'index.html': 'theirs\n' })
    const points = new Checkpoints(root, store, env)
    const ran = await turn(points, root, { 'pages/index.html': 'agent\n' })
    rmSync(join(root, 'pages'), { recursive: true })
    symlinkSync(outside, join(root, 'pages'))
    await points.restore(ran.before, ran.paths)
    expect(get(outside, 'index.html')).toBe('theirs\n')
    expect(lstatSync(join(root, 'pages')).isDirectory()).toBe(true)
    expect(get(root, 'pages/index.html')).toBe('old\n')
  })
})

describe.skipIf(!gitRuns)('what a checkpoint leaves out', () => {
  const secrets = ['.env', '.env.local', 'config/.env.production', 'deploy.pem', '.npmrc']
  const kept = ['.env.example', 'src/env.ts']
  const large = 'media/intro.mov'
  let root = ''
  let ran: Turn

  beforeAll(async () => {
    // The project's own ignore file outranks Gui's, and this one un-ignores every secret.
    root = project('left-out', { '.gitignore': '!.env\n!.env.*\n!*.pem\n!.npmrc\n' })
    for (const file of [...secrets, ...kept]) put(root, file, 'TOKEN=1\n')
    const points = new Checkpoints(root, store, env)
    const before = await points.snapshot('before turn')
    for (const file of [...secrets, ...kept]) put(root, file, 'TOKEN=2\n')
    put(root, 'media/poster.png', 'small')
    // A sparse file: over the limit without writing that much.
    put(root, large, '')
    truncateSync(join(root, large), MAX_CHECKPOINT_FILE_BYTES + 1)
    const after = await points.snapshot('after turn')
    const paths = (await points.diff(before, after)).map((change) => change.path).sort()
    ran = { before, after, paths }
    await points.restore(before, paths)
  })

  test('files that may hold secrets, even when the project stops ignoring them', () => {
    expect(recorded(root, ran.after)).toEqual([
      '.env.example',
      '.gitignore',
      'media/poster.png',
      'src/env.ts',
    ])
    // Never recorded, so undo has nothing to put back: they stay as the turn left them.
    for (const file of secrets) expect(get(root, file)).toBe('TOKEN=2\n')
    for (const file of kept) expect(get(root, file)).toBe('TOKEN=1\n')
  })

  test('new files over the size limit, which undo leaves as they are', () => {
    expect(ran.paths).toEqual(['.env.example', 'media/poster.png', 'src/env.ts'])
    expect(lstatSync(join(root, large)).size).toBe(MAX_CHECKPOINT_FILE_BYTES + 1)
    expect(get(root, 'media/poster.png')).toBeNull()
  })
})

describe.skipIf(!gitRuns)('a folder inside the project with a repository of its own', () => {
  // A submodule, a clone kept inside the project, or an app scaffolded in a subfolder by a
  // tool that runs `git init`. Git records such a folder as a link to its commit, not as
  // its files, so it isn't Gui's to restore: Undo and Redo leave the folder exactly as it
  // is, its `.git` included, put everything else back, and name the folder.

  /** `path` as it is on disk: a folder's fingerprint, a file's text, null when it isn't there. */
  const asIs = (root: string, path: string) =>
    lstatSync(join(root, path), { throwIfNoEntry: false })?.isDirectory()
      ? fingerprint(join(root, path))
      : get(root, path)

  const nested = (root: string) => {
    put(root, 'vendor/lib/x.ts', 'old\n')
    ownRepo(join(root, 'vendor/lib'))
  }

  interface Row {
    name: string
    why: string
    /** Before the turn, besides src/app.ts */
    start?: (root: string) => void
    /** What the turn does, besides changing src/app.ts */
    turn: (root: string) => void
    /** What the turn is credited with: how git records what it did */
    paths: string[]
    /** The folder Undo leaves as the turn left it, and names */
    folder: string
    /** What Redo leaves alone, when that isn't `folder` again */
    redone?: string[]
  }
  const rows: Row[] = [
    {
      name: 'created',
      why: 'one the turn created (as `create-next-app` does) stays',
      turn: (root) => {
        put(root, 'my-app/index.ts', 'agent\n')
        ownRepo(join(root, 'my-app'))
      },
      paths: ['my-app', 'src/app.ts'],
      folder: 'my-app',
    },
    {
      name: 'deleted',
      why: 'one the turn deleted is not brought back, not even as an empty folder',
      start: nested,
      turn: (root) => rmSync(join(root, 'vendor/lib'), { recursive: true }),
      paths: ['src/app.ts', 'vendor/lib'],
      folder: 'vendor/lib',
      // Nothing is there, as when the undo began, and nothing is asked of it.
      redone: [],
    },
    {
      name: 'committed',
      why: 'one the turn committed in keeps the commit and its files',
      start: nested,
      turn: (root) => {
        put(root, 'vendor/lib/x.ts', 'agent\n')
        commit(join(root, 'vendor/lib'))
      },
      paths: ['src/app.ts', 'vendor/lib'],
      folder: 'vendor/lib',
    },
    {
      name: 'from-file',
      why: 'one the turn put where a file was stays, and the file is not written over it',
      start: (root) => put(root, 'lib', 'old\n'),
      turn: (root) => {
        put(root, 'lib', null)
        put(root, 'lib/x.ts', 'agent\n')
        ownRepo(join(root, 'lib'))
      },
      paths: ['lib', 'src/app.ts'],
      folder: 'lib',
    },
    {
      name: 'from-folder',
      // Git goes on recording the files of a folder it already knew, repository or not.
      why: 'one the turn made of a folder Gui was recording stays, with the files in it',
      start: (root) => put(root, 'pkg/a.ts', 'old\n'),
      turn: (root) => {
        put(root, 'pkg/a.ts', 'agent\n')
        put(root, 'pkg/b.ts', 'agent\n')
        ownRepo(join(root, 'pkg'))
      },
      paths: ['pkg/a.ts', 'pkg/b.ts', 'src/app.ts'],
      folder: 'pkg',
    },
    {
      name: 'to-file',
      why: 'a file the turn put where one was stays: there is no repository to put back',
      start: nested,
      turn: (root) => {
        rmSync(join(root, 'vendor/lib'), { recursive: true })
        put(root, 'vendor/lib', 'agent\n')
      },
      paths: ['src/app.ts', 'vendor/lib'],
      folder: 'vendor/lib',
      // A plain file by then, which Gui recorded: Redo writes what is already there.
      redone: [],
    },
  ]

  test.each(rows)('$why', async ({ name, start, turn: change, paths, folder, redone }) => {
    const root = project(`nested-${name}`, { 'src/app.ts': 'old\n' })
    start?.(root)
    const points = new Checkpoints(root, store, env)
    const ran = await turn(points, root, () => {
      put(root, 'src/app.ts', 'agent\n')
      change(root)
    })
    expect(ran.paths).toEqual(paths)
    const left = asIs(root, folder)

    const undone = await undo(points, [ran])
    expect(undone.alone).toEqual([folder])
    expect(get(root, 'src/app.ts')).toBe('old\n')
    expect(asIs(root, folder)).toBe(left)

    expect(await undone.redo()).toEqual(redone ?? [folder])
    expect(get(root, 'src/app.ts')).toBe('agent\n')
    expect(asIs(root, folder)).toBe(left)
  })

  /** A turn that changes src/app.ts and scaffolds my-app/, a repository with a commit. */
  const scaffold = (points: Checkpoints, root: string) =>
    turn(points, root, () => {
      put(root, 'src/app.ts', 'agent\n')
      put(root, 'my-app/index.ts', 'agent\n')
      ownRepo(join(root, 'my-app'))
    })

  test('undoing an earlier turn takes a later one that created a repository with it', async () => {
    const root = project('nested-later', { 'a.ts': 'old\n', 'src/app.ts': 'old\n' })
    const points = new Checkpoints(root, store, env)
    const first = await turn(points, root, { 'a.ts': 'first\n' })
    const second = await scaffold(points, root)
    const left = asIs(root, 'my-app')

    const undone = await undo(points, [first, second])
    expect(undone.alone).toEqual(['my-app'])
    expect(state(root, ['a.ts', 'src/app.ts'])).toEqual({ 'a.ts': 'old\n', 'src/app.ts': 'old\n' })
    expect(asIs(root, 'my-app')).toBe(left)
  })

  // Deleting the `.git` a scaffolding tool left is how its app joins the project's own
  // repository. Git still lists the folder as a link, and Gui still has none of its files.
  test('one the turn created stays after its .git is deleted, with the files in it', async () => {
    const root = project('nested-no-git', { 'src/app.ts': 'old\n' })
    const points = new Checkpoints(root, store, env)
    const ran = await scaffold(points, root)
    rmSync(join(root, 'my-app/.git'), { recursive: true })

    const undone = await undo(points, [ran])
    expect(undone.alone).toEqual(['my-app'])
    expect(state(root, ['src/app.ts', 'my-app/index.ts'])).toEqual({
      'src/app.ts': 'old\n',
      'my-app/index.ts': 'agent\n',
    })
  })

  // Over two turns git does record a repository giving way to plain files: the folder gone
  // after the first, files in its place after the second. Before both, what was there was
  // the repository's, which Gui never had: removing the files would not put that back.
  test('files a later turn wrote where a repository was are not removed', async () => {
    const root = project('nested-to-folder', { 'src/app.ts': 'old\n' })
    nested(root)
    const points = new Checkpoints(root, store, env)
    const first = await turn(points, root, () => {
      put(root, 'src/app.ts', 'agent\n')
      rmSync(join(root, 'vendor/lib'), { recursive: true })
    })
    const second = await turn(points, root, { 'vendor/lib/x.ts': 'agent\n' })
    expect(second.paths).toEqual(['vendor/lib/x.ts'])

    const undone = await undo(points, [first, second])
    expect(undone.alone).toEqual(['vendor/lib'])
    expect(state(root, ['src/app.ts', 'vendor/lib/x.ts'])).toEqual({
      'src/app.ts': 'old\n',
      'vendor/lib/x.ts': 'agent\n',
    })
  })

  test('the warning before an overwrite leaves it out: nothing in it is overwritten', async () => {
    const root = project('nested-warned', { 'src/app.ts': 'old\n' })
    const points = new Checkpoints(root, store, env)
    const ran = await scaffold(points, root)
    // Afterwards the user edits a file of the turn's, and commits in the new repository.
    put(root, 'src/app.ts', 'mine\n')
    put(root, 'my-app/index.ts', 'mine\n')
    commit(join(root, 'my-app'))

    const undone = await undo(points, [ran])
    expect(undone.warned).toEqual(['src/app.ts'])
    expect(undone.alone).toEqual(['my-app'])
    expect(state(root, ['src/app.ts', 'my-app/index.ts'])).toEqual({
      'src/app.ts': 'old\n',
      'my-app/index.ts': 'mine\n',
    })
  })

  // Still a gap. A file changed in such a folder without a commit there changes nothing git
  // records (the link is to the same commit), so the turn isn't credited with the folder
  // and nothing names it to Undo: there is nothing to leave alone, and nothing to say.
  //   input:    vendor/lib/ holds its own .git (one commit); a turn changes vendor/lib/x.ts
  //   expected: the turn is credited with vendor/lib/x.ts, and Undo puts 'old' back
  //   actual:   the turn is credited with nothing, and Undo leaves 'agent' without a word
  test.failing('a file the turn changed in it goes back', async () => {
    const root = project('nested', { 'vendor/lib/x.ts': 'old\n' })
    ownRepo(join(root, 'vendor/lib'))
    const points = new Checkpoints(root, store, env)
    const ran = await turn(points, root, { 'vendor/lib/x.ts': 'agent\n' })
    expect(ran.paths).toEqual(['vendor/lib/x.ts'])
    await undo(points, [ran])
    expect(get(root, 'vendor/lib/x.ts')).toBe('old\n')
  })

  // After `git init` and before its first commit there is no commit to point to, and git
  // can't record the folder at all ("'fresh/' does not have a commit checked out"). It is
  // left out, like a secret or a file over the size limit, and the rest is recorded.
  test('a new, empty repository does not stop checkpoints: it is left out', async () => {
    const files = ['src/app.ts', 'fresh/x.ts', 'apps/new app/y.ts']
    const root = project('nested-empty', Object.fromEntries(files.map((file) => [file, 'old\n'])))
    const empty = [join(root, 'fresh'), join(root, 'apps/new app')]
    for (const dir of empty) git(dir, 'init', '--quiet')
    const own = empty.map((dir) => fingerprint(join(dir, '.git')))

    const points = new Checkpoints(root, store, env)
    const ran = await turn(points, root, Object.fromEntries(files.map((file) => [file, 'agent\n'])))
    expect(ran.paths).toEqual(['src/app.ts'])
    expect(recorded(root, ran.after)).toEqual(['src/app.ts'])

    await undo(points, [ran])
    // The rest of the project goes back; what was never recorded stays as the turn left it.
    expect(state(root, files)).toEqual({
      'src/app.ts': 'old\n',
      'fresh/x.ts': 'agent\n',
      'apps/new app/y.ts': 'agent\n',
    })
    expect(empty.map((dir) => fingerprint(join(dir, '.git')))).toEqual(own)
  })
})

describe.skipIf(!gitRuns)('one store per project folder', () => {
  test('named from the real path, so a sibling with the same prefix has its own', () => {
    const name = shadowRepoName('/Users/me/proj')
    expect(name).toMatch(/^[0-9a-f]{16}\.git$/)
    expect(shadowRepoName('/Users/me/proj')).toBe(name)
    expect(shadowRepoName('/Users/me/proj-other')).not.toBe(name)
    expect(shadowRepoName('/Users/me/proj/apps/web')).not.toBe(name)
  })

  test('a folder opened through a link shares the real folder’s versions', async () => {
    const root = project('shared', { 'a.ts': 'old\n' })
    const link = join(base, 'shared-link')
    symlinkSync(root, link)
    const direct = new Checkpoints(root, store, env)
    const linked = new Checkpoints(link, store, env)
    const sha = await direct.snapshot('from one tab')
    expect(await linked.hasCommits([sha])).toBe(true)
    expect(await linked.read(sha, 'a.ts')).toBe('old\n')
    // Identical files are the same version, whoever took it.
    const again = await linked.snapshot('from another tab')
    const trees = await direct.trees([sha, again])
    expect(trees.get(sha)).toBe(trees.get(again))
    expect(readdirSync(store).filter((name) => name === shadowRepoName(root))).toHaveLength(1)
  })

  test('two tabs on one folder take turns, so each is credited with its own changes', async () => {
    const root = project('slots')
    const one = new Checkpoints(root, store, env).turnSlot()
    const two = new Checkpoints(root, store, env).turnSlot()
    const elsewhere = new Checkpoints(project('slots-other'), store, env).turnSlot()
    const order: string[] = []
    void two.ready.then(() => order.push('two'))
    void elsewhere.ready.then(() => order.push('elsewhere'))
    await one.ready
    await new Promise((done) => setTimeout(done, 5))
    expect(order).toEqual(['elsewhere'])
    one.release()
    await two.ready
    expect(order).toEqual(['elsewhere', 'two'])
    two.release()
    elsewhere.release()
  })
})
