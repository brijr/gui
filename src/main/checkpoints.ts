import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, realpath, rm, rmdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

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
  // Never copy secrets into the shadow repo, even if the project doesn't ignore them.
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

/** Name of a project's shadow repo inside the checkpoint store, from its real path. */
export function shadowRepoName(realRoot: string) {
  return `${createHash('sha1').update(realRoot).digest('hex').slice(0, 16)}.git`
}

export class Checkpoints {
  private readonly projectRoot: string
  private readonly storeDir: string
  private readonly env: NodeJS.ProcessEnv
  private repo: Repo | null = null
  private tail: Promise<unknown> = Promise.resolve()

  constructor(projectRoot: string, storeDir: string, env: NodeJS.ProcessEnv = process.env) {
    this.projectRoot = resolve(projectRoot)
    this.storeDir = resolve(storeDir)
    this.env = gitEnv(env)
  }

  init(): Promise<void> {
    return this.enqueue(async () => {
      await this.setup()
    })
  }

  snapshot(message: string): Promise<string> {
    return this.enqueue(async () => {
      const repo = await this.ready()
      await this.git(repo, ['add', '-A'])
      await this.git(repo, [
        'commit',
        '--allow-empty',
        '--allow-empty-message',
        '--no-verify',
        '--quiet',
        '-m',
        message,
      ])
      return (await this.git(repo, ['rev-parse', 'HEAD'])).trim()
    })
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

  restore(sha: string, paths: string[]): Promise<void> {
    return this.enqueue(async () => {
      assertSha(sha)
      const repo = await this.ready()
      const files = [...new Set(paths.map((path) => toRepoPath(repo.root, path)))]
      if (files.length === 0) return

      const present = new Set<string>()
      for (const batch of chunk(files)) {
        const args = ['ls-tree', '-r', '--name-only', '-z', sha, '--', ...batch]
        const out = await this.git(repo, args)
        for (const name of splitNul(out)) present.add(name)
      }

      // Delete first so a path that flipped between file and directory can be checked out.
      for (const file of files) {
        if (!present.has(file)) await removeFile(repo.root, file)
      }
      for (const batch of chunk(files.filter((file) => present.has(file)))) {
        await this.git(repo, ['checkout', sha, '--', ...batch])
      }
    })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task)
    this.tail = result
    return result
  }

  private async ready(): Promise<Repo> {
    return this.repo ?? this.setup()
  }

  private async setup(): Promise<Repo> {
    const root = await realpath(this.projectRoot)
    const repo: Repo = { root, gitDir: join(this.storeDir, shadowRepoName(root)) }

    await mkdir(this.storeDir, { recursive: true })
    // One window owns a project's shadow repo and serializes its git calls, so a lock
    // left at setup is from a git process that was killed mid-commit; it would block
    // every later snapshot.
    await rm(join(repo.gitDir, 'index.lock'), { force: true })
    await this.git(repo, ['init', '--quiet'], false)
    const config: Array<[string, string]> = [
      ['core.quotepath', 'false'],
      ['core.untrackedCache', 'true'],
      ['core.fsmonitor', 'false'],
      // Nonexistent dir: keeps global/template hooks from firing on shadow commits.
      ['core.hooksPath', join(repo.gitDir, 'no-hooks')],
    ]
    for (const [key, value] of config) await this.git(repo, ['config', key, value], false)
    await mkdir(join(repo.gitDir, 'info'), { recursive: true })
    await writeFile(join(repo.gitDir, 'info', 'exclude'), `${EXCLUDES.join('\n')}\n`)

    this.repo = repo
    return repo
  }

  private git(repo: Repo, args: string[], withWorkTree = true): Promise<string> {
    const argv = [`--git-dir=${repo.gitDir}`]
    if (withWorkTree) argv.push(`--work-tree=${repo.root}`)
    argv.push(
      '--literal-pathspecs',
      '-c',
      'user.name=grat',
      '-c',
      'user.email=grat@localhost',
      '-c',
      'core.autocrlf=false',
      '-c',
      'commit.gpgsign=false',
      ...args,
    )
    const options = { cwd: repo.root, env: this.env, maxBuffer: MAX_BUFFER }
    return new Promise((ok, fail) => {
      execFile('git', argv, { ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (!error) return ok(stdout)
        const detail = stderr.trim() || error.message
        fail(new Error(`git ${args[0] ?? ''} failed: ${detail}`, { cause: error }))
      })
    })
  }
}

function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: '0' }
  for (const key of STRIPPED_ENV) delete out[key]
  return out
}

function assertSha(sha: string): void {
  if (!SHA_RE.test(sha)) throw new Error(`Invalid checkpoint sha: ${sha}`)
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

async function removeFile(root: string, file: string): Promise<void> {
  const abs = join(root, file)
  const parent = await realpathOrNull(dirname(abs))
  if (parent === null) return // parent dir is gone, so the file is too
  if (parent !== root && !isInside(root, parent)) {
    throw new Error(`Path resolves outside project root: ${file}`)
  }
  await rm(abs, { force: true })
  await pruneEmptyDirs(root, dirname(abs))
}

// Mirrors git: drop directories left empty by a deletion, stopping at the project root.
async function pruneEmptyDirs(root: string, dir: string): Promise<void> {
  for (let current = dir; isInside(root, current); current = dirname(current)) {
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
