import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, mkdir, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { MAX_CHECKPOINT_FILE_BYTES } from '../shared/bounded'
import { developerTools } from './developer-tools'
import { execFile } from './process'
import { mayHoldSecrets } from './secret-files'

export interface FileChange {
  path: string // POSIX path relative to project root
  status: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
}

interface Repo {
  root: string // realpath of the project root (git work tree)
  gitDir: string // shadow git dir
}

interface LineCounts {
  additions: number
  deletions: number
}

const EXCLUDES = [
  'node_modules/',
  '.git/',
  '.next/',
  '.turbo/',
  '.vercel/',
  '.svelte-kit/',
  '.nuxt/',
  '.output/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.cache/',
  '.parcel-cache/',
  '*.log',
  '.DS_Store',
  // Never copy secrets into the shadow repo, even if the project doesn't ignore them. A
  // project's own .gitignore outranks this file (`!.env` would bring it back), so snapshots
  // also leave out whatever `mayHoldSecrets` matches; these only save looking.
  '.env',
  '.env.*',
  '!.env.example',
  '*.pem',
  '*.key',
  '*.p12',
  '.ssh/',
  '.aws/',
  '.npmrc',
]

// Inherited vars that would point git at a repo other than the shadow one.
const STRIPPED_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]

const MAX_BUFFER = 64 * 1024 * 1024
const PATH_CHUNK = 200
const SHA_RE = /^[0-9a-f]{4,64}$/i
/**
 * Bigger new or changed files aren't kept: a video or database rewritten every turn would
 * add its whole size to the store each time. Undo leaves them as they are.
 */
const MAX_FILE_BYTES = MAX_CHECKPOINT_FILE_BYTES
/** Each checkpoint is a commit of its own under this prefix, so one nothing needs can go. */
const KEEP_REF = 'refs/gui/checkpoints/'
/** How often a project's store is pruned, at most. */
const PRUNE_EVERY_MS = 7 * 24 * 60 * 60 * 1000
/** A checkpoint this new is kept even unreferenced: its chat may not have been saved yet. */
const PRUNE_GRACE_S = 24 * 60 * 60

/** Name of a project's shadow repo inside the checkpoint store, from its real path. */
export function shadowRepoName(realRoot: string) {
  return `${createHash('sha1').update(realRoot).digest('hex').slice(0, 16)}.git`
}

/**
 * Git calls queued per project, shared by every Checkpoints on it: two tabs on one folder
 * (a monorepo's apps, say) use the same shadow repo, and git can't run two commits at once.
 * Keyed by real path, so a folder opened through a symlink shares its queue too.
 */
const queues = new Map<string, Promise<unknown>>()
/** Per project, the turn that holds it and those waiting; see `turnSlot`. */
const turnSlots = new Map<string, Promise<void>>()

interface GitOptions {
  /** Run against the project's files (the default), or the shadow repo alone */
  workTree?: boolean
  /** Paths are taken as written (the default); off for Gui's own pathspec magic */
  literal?: boolean
  /** Written to git's stdin */
  input?: string
}

export interface CheckpointOptions {
  /**
   * Every checkpoint the project's saved chats still refer to, for pruning the rest; null
   * when that can't be known (an unreadable chat), which skips pruning.
   */
  referenced?: () => Promise<Set<string> | null>
  /**
   * Folders (relative to the project) a restore never removes, even left empty: a canvas's
   * `frames/`, which undoing its first turn would otherwise take away with the turn's pages.
   */
  keepDirs?: string[]
}

export class Checkpoints {
  private readonly projectRoot: string
  private readonly key: string
  private readonly storeDir: string
  private readonly env: NodeJS.ProcessEnv
  private readonly options: CheckpointOptions
  private repo: Repo | null = null

  constructor(
    projectRoot: string,
    storeDir: string,
    env: NodeJS.ProcessEnv = process.env,
    options: CheckpointOptions = {},
  ) {
    this.projectRoot = resolve(projectRoot)
    this.key = realpathOr(this.projectRoot)
    this.storeDir = resolve(storeDir)
    this.env = gitEnv(env)
    this.options = options
  }

  init(): Promise<void> {
    return this.enqueue(async () => {
      await this.setup()
    })
  }

  snapshot(message: string): Promise<string> {
    return this.enqueue(async () => {
      const repo = await this.ready()
      const { secrets, large } = await this.leftOut(repo)
      const excluded = [...secrets, ...large].map((path) => `:(exclude,literal)${path}`)
      await this.git(repo, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        literal: false,
        input: ['.', ...excluded].join('\0'),
      })
      // Kept by an older Gui, or before the project stopped ignoring them: drop them from here on.
      for (const batch of chunk(secrets)) {
        await this.git(repo, [
          'rm',
          '--cached',
          '-r',
          '--quiet',
          '--ignore-unmatch',
          '--',
          ...batch,
        ])
      }
      const tree = (await this.git(repo, ['write-tree'])).trim()
      const sha = (await this.git(repo, ['commit-tree', tree, '-m', message])).trim()
      assertSha(sha)
      await this.git(repo, ['update-ref', `${KEEP_REF}${sha}`, sha], { workTree: false })
      return sha
    })
  }

  /**
   * Waits for any other tab's turn on this folder to end, so each turn's checkpoints hold only
   * its own changes: two agents writing at once would each be credited (and undone) with the
   * other's. `ready` settles when this turn may go on; call `release` when it's over, whether
   * it went on or not.
   */
  turnSlot(): { ready: Promise<void>; release: () => void } {
    const previous = turnSlots.get(this.key) ?? Promise.resolve()
    let release = () => {}
    const mine = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => mine)
    turnSlots.set(this.key, tail)
    void tail.then(() => {
      if (turnSlots.get(this.key) === tail) turnSlots.delete(this.key)
    })
    return { ready: previous, release }
  }

  diff(from: string, to: string): Promise<FileChange[]> {
    return this.enqueue(async () => {
      assertSha(from)
      assertSha(to)
      const repo = await this.ready()
      const base = ['diff', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', '-z']
      const [nameStatus, numstat] = await Promise.all([
        this.git(repo, [...base, '--name-status', from, to, '--']),
        this.git(repo, [...base, '--numstat', from, to, '--']),
      ])
      const counts = parseNumstat(numstat)
      return parseNameStatus(nameStatus).map(({ path, status }) => ({
        path,
        status,
        ...(counts.get(path) ?? { additions: 0, deletions: 0 }),
      }))
    })
  }

  /** Of `paths`, the ones whose contents differ between checkpoints `from` and `to`. */
  changedAmong(from: string, to: string, paths: string[]): Promise<string[]> {
    return this.enqueue(async () => {
      assertSha(from)
      assertSha(to)
      const repo = await this.ready()
      const files = [...new Set(paths.map((path) => toRepoPath(repo.root, path)))]
      const changed: string[] = []
      for (const batch of chunk(files)) {
        const args = ['diff', '--no-renames', '--name-only', '-z', from, to, '--', ...batch]
        changed.push(...splitNul(await this.git(repo, args)))
      }
      return changed
    })
  }

  /**
   * Whether every sha is still a commit in the shadow repo; the user may have deleted
   * its folder. Callers check before acting on old checkpoints.
   */
  hasCommits(shas: string[]): Promise<boolean> {
    return this.enqueue(async () => {
      for (const sha of shas) assertSha(sha)
      try {
        const repo = await this.ready()
        for (const batch of chunk([...new Set(shas)])) {
          const revs = batch.map((sha) => `${sha}^{commit}`)
          await this.git(repo, ['rev-list', '--quiet', '--no-walk', ...revs, '--'], {
            workTree: false,
          })
        }
        return true
      } catch {
        return false
      }
    })
  }

  /** Each checkpoint's tree, so snapshots of identical files compare equal. */
  trees(shas: string[]): Promise<Map<string, string>> {
    return this.enqueue(async () => {
      for (const sha of shas) assertSha(sha)
      const repo = await this.ready()
      const trees = new Map<string, string>()
      for (const batch of chunk([...new Set(shas)])) {
        const revs = batch.map((sha) => `${sha}^{tree}`)
        const out = await this.git(repo, ['rev-parse', ...revs], { workTree: false })
        const lines = out.split('\n').filter(Boolean)
        batch.forEach((sha, index) => {
          const tree = lines[index]
          if (tree) trees.set(sha, tree)
        })
      }
      return trees
    })
  }

  /** A file's contents at checkpoint `sha`; null when it wasn't there. */
  read(sha: string, path: string): Promise<string | null> {
    return this.enqueue(async () => {
      assertSha(sha)
      const repo = await this.ready()
      const file = toRepoPath(repo.root, path)
      return this.git(repo, ['cat-file', 'blob', `${sha}:${file}`], { workTree: false }).catch(
        () => null,
      )
    })
  }

  restore(sha: string, paths: string[]): Promise<void> {
    return this.enqueue(async () => {
      assertSha(sha)
      const repo = await this.ready()
      const files = [...new Set(paths.map((path) => toRepoPath(repo.root, path)))]
      if (files.length === 0) return
      const keep = new Set((this.options.keepDirs ?? []).map((dir) => resolve(repo.root, dir)))

      const present = new Set<string>()
      for (const batch of chunk(files)) {
        const args = ['ls-tree', '-r', '--name-only', '-z', sha, '--', ...batch]
        const out = await this.git(repo, args)
        for (const name of splitNul(out)) present.add(name)
      }

      // Delete first so a path that flipped between file and directory can be checked out.
      for (const file of files) {
        if (!present.has(file)) await removeFile(repo.root, file, keep)
      }
      for (const batch of chunk(files.filter((file) => present.has(file)))) {
        await this.git(repo, ['checkout', sha, '--', ...batch])
      }
    })
  }

  /**
   * What snapshots leave out of what git would add: files that may hold secrets (named
   * anywhere in the project, tracked or not), and new or changed files over the size limit.
   */
  private async leftOut(repo: Repo): Promise<{ secrets: string[]; large: string[] }> {
    const listed = (args: string[]) =>
      this.git(repo, ['ls-files', '-z', '--exclude-standard', ...args]).then(splitNul)
    const [all, changed] = await Promise.all([
      listed(['--cached', '--others']),
      listed(['--others', '--modified']),
    ])
    const secrets = [...new Set(all.filter(mayHoldSecrets))]
    const large: string[] = []
    const candidates = [...new Set(changed)].filter((path) => !mayHoldSecrets(path))
    for (let i = 0; i < candidates.length; i += 64) {
      const batch = candidates.slice(i, i + 64)
      const sizes = await Promise.all(
        batch.map((path) =>
          lstat(join(repo.root, path)).then(
            (info) => (info.isFile() ? info.size : 0),
            () => 0,
          ),
        ),
      )
      batch.forEach((path, j) => {
        if (sizes[j] > MAX_FILE_BYTES) large.push(path)
      })
    }
    return { secrets, large }
  }

  /**
   * Now and then (a week apart, when the project opens), drops checkpoints none of its saved
   * chats refer to and the git objects only they kept, which would otherwise grow without end.
   */
  private async pruneIfDue() {
    const referenced = this.options.referenced
    if (!referenced) return
    const marker = join(this.storeDir, `${shadowRepoName(this.key)}.pruned`)
    const last = await stat(marker).then(
      (info) => info.mtimeMs,
      () => 0,
    )
    if (Date.now() - last < PRUNE_EVERY_MS) return
    const keep = await referenced()
    if (!keep) return
    const pruned = await this.enqueue(async () => {
      const repo = await this.ready()
      const refs = await this.git(
        repo,
        ['for-each-ref', '--format=%(objectname) %(committerdate:unix) %(refname)', KEEP_REF],
        { workTree: false },
      )
      const now = Date.now() / 1000
      const kept = new Set<string>()
      const updates: string[] = []
      for (const line of refs.split('\n').filter(Boolean)) {
        const [sha, at, ref] = line.split(' ')
        if (keep.has(sha) || now - Number(at) < PRUNE_GRACE_S) kept.add(sha)
        else updates.push(`delete ${ref}`)
      }
      // Checkpoints from before each had a ref of its own sat on one branch, which kept every
      // one of them: give those still needed a ref, then let the branch go.
      for (const sha of keep) {
        if (kept.has(sha) || !SHA_RE.test(sha)) continue
        const exists = await this.git(repo, ['cat-file', '-e', `${sha}^{commit}`], {
          workTree: false,
        }).then(
          () => true,
          () => false,
        )
        if (exists) updates.push(`create ${KEEP_REF}${sha} ${sha}`)
      }
      const branches = await this.git(
        repo,
        ['for-each-ref', '--format=%(refname)', 'refs/heads/'],
        {
          workTree: false,
        },
      )
      for (const ref of branches.split('\n').filter(Boolean)) updates.push(`delete ${ref}`)
      if (updates.length === 0) return repo
      await this.git(repo, ['update-ref', '--no-deref', '--stdin'], {
        workTree: false,
        input: `${updates.join('\n')}\n`,
      })
      return repo
    })
    // Outside the queue: it can take a while, and git lets snapshots go on beside it. The
    // grace period spares objects a snapshot is writing right now.
    await this.git(pruned, ['gc', '--quiet', '--prune=1.hour.ago'], { workTree: false })
    await writeFile(marker, '')
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const key = this.key
    const result = (queues.get(key) ?? Promise.resolve()).then(task, task)
    queues.set(key, result)
    const forget = () => {
      if (queues.get(key) === result) queues.delete(key)
    }
    result.then(forget, forget)
    return result
  }

  private async ready(): Promise<Repo> {
    return this.repo ?? this.setup()
  }

  private async setup(): Promise<Repo> {
    const root = await realpath(this.projectRoot)
    const repo: Repo = { root, gitDir: join(this.storeDir, shadowRepoName(root)) }

    await developerTools.requireGit()
    await mkdir(this.storeDir, { recursive: true })
    // Every git call on a project's shadow repo goes through one queue, so a lock left at
    // setup is from a git process that was killed mid-commit; it would block every later
    // snapshot.
    await rm(join(repo.gitDir, 'index.lock'), { force: true })
    await this.git(repo, ['init', '--quiet'], { workTree: false })
    const config: Array<[string, string]> = [
      ['core.quotepath', 'false'],
      ['core.untrackedCache', 'true'],
      ['core.fsmonitor', 'false'],
      // Nonexistent dir: keeps global/template hooks from firing on shadow commits.
      ['core.hooksPath', join(repo.gitDir, 'no-hooks')],
      // Pruning is Gui's: git's own would pack and prune in the middle of a snapshot.
      ['gc.auto', '0'],
    ]
    for (const [key, value] of config) {
      await this.git(repo, ['config', key, value], { workTree: false })
    }
    await mkdir(join(repo.gitDir, 'info'), { recursive: true })
    await writeFile(join(repo.gitDir, 'info', 'exclude'), `${EXCLUDES.join('\n')}\n`)

    this.repo = repo
    // Queued behind whatever asked for the repo, so the turn that did isn't held up.
    void this.pruneIfDue().catch((error: unknown) => {
      console.error('[gui] failed to prune checkpoints', error)
    })
    return repo
  }

  private git(
    repo: Repo,
    args: string[],
    { workTree = true, literal = true, input }: GitOptions = {},
  ): Promise<string> {
    const argv = [`--git-dir=${repo.gitDir}`]
    if (workTree) argv.push(`--work-tree=${repo.root}`)
    if (literal) argv.push('--literal-pathspecs')
    argv.push(
      '-c',
      'user.name=gui',
      '-c',
      'user.email=gui@localhost',
      '-c',
      'core.autocrlf=false',
      '-c',
      'commit.gpgsign=false',
      ...args,
    )
    const options = { cwd: repo.root, env: this.env, maxBuffer: MAX_BUFFER }
    return new Promise((ok, fail) => {
      const child = execFile(
        'git',
        argv,
        { ...options, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (!error) return ok(stdout)
          const detail = stderr.trim() || error.message
          fail(new Error(`git ${args[0] ?? ''} failed: ${detail}`, { cause: error }))
        },
      )
      child.stdin?.end(input ?? '')
    })
  }
}

function realpathOr(path: string) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: '0' }
  for (const key of STRIPPED_ENV) delete out[key]
  return out
}

function assertSha(sha: string): void {
  if (!SHA_RE.test(sha)) throw new Error(`Invalid version ID: ${sha}`)
}

// Normalizes a caller path to a POSIX repo path, rejecting anything outside the project or in .git.
function toRepoPath(root: string, path: string): string {
  if (!path || path.includes('\0') || isAbsolute(path)) throw new Error(`Invalid path: ${path}`)
  const rel = relative(root, resolve(root, path))
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Path escapes project root: ${path}`)
  }
  const parts = rel.split(sep)
  if (parts.some((part) => part.toLowerCase() === '.git')) {
    throw new Error(`Refusing to touch .git path: ${path}`)
  }
  return parts.join('/')
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

async function removeFile(root: string, file: string, keep: ReadonlySet<string>): Promise<void> {
  const abs = join(root, file)
  const parent = await realpathOrNull(dirname(abs))
  if (parent === null) return // parent dir is gone, so the file is too
  if (parent !== root && !isInside(root, parent)) {
    throw new Error(`Path resolves outside project root: ${file}`)
  }
  await rm(abs, { force: true })
  await pruneEmptyDirs(root, dirname(abs), keep)
}

// Mirrors git: drop directories left empty by a deletion, stopping at the project root (and
// at the folders the project keeps, `keepDirs`).
async function pruneEmptyDirs(root: string, dir: string, keep: ReadonlySet<string>): Promise<void> {
  for (
    let current = dir;
    isInside(root, current) && !keep.has(current);
    current = dirname(current)
  ) {
    try {
      await rmdir(current)
    } catch (error) {
      if (hasCode(error, ['ENOTEMPTY', 'EEXIST', 'ENOENT', 'ENOTDIR'])) return
      throw error
    }
  }
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch (error) {
    if (hasCode(error, ['ENOENT', 'ENOTDIR'])) return null
    throw error
  }
}

function hasCode(error: unknown, codes: string[]): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return typeof error.code === 'string' && codes.includes(error.code)
}

function chunk<T>(items: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += PATH_CHUNK) out.push(items.slice(i, i + PATH_CHUNK))
  return out
}

function splitNul(out: string): string[] {
  return out.split('\0').filter(Boolean)
}

// `--name-status -z` emits alternating `<code>\0<path>\0` fields.
function parseNameStatus(out: string): Array<Pick<FileChange, 'path' | 'status'>> {
  const fields = out.split('\0')
  const changes: Array<Pick<FileChange, 'path' | 'status'>> = []
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const code = fields[i]
    const path = fields[i + 1]
    if (!code || !path) continue
    changes.push({ path, status: toStatus(code) })
  }
  return changes
}

function toStatus(code: string): FileChange['status'] {
  if (code === 'A') return 'added'
  if (code === 'D') return 'deleted'
  return 'modified' // M, or T (type change)
}

// `--numstat -z` emits `<add>\t<del>\t<path>\0`; binary files use `-` for both counts.
function parseNumstat(out: string): Map<string, LineCounts> {
  const counts = new Map<string, LineCounts>()
  for (const record of splitNul(out)) {
    const first = record.indexOf('\t')
    const second = record.indexOf('\t', first + 1)
    if (first < 0 || second < 0) throw new Error(`Unexpected numstat record: ${record}`)
    const path = record.slice(second + 1)
    const prev = counts.get(path) ?? { additions: 0, deletions: 0 }
    counts.set(path, {
      additions: prev.additions + toCount(record.slice(0, first)),
      deletions: prev.deletions + toCount(record.slice(first + 1, second)),
    })
  }
  return counts
}

function toCount(value: string): number {
  if (value === '-') return 0
  const count = Number(value)
  if (!Number.isInteger(count)) throw new Error(`Unexpected numstat count: ${value}`)
  return count
}
