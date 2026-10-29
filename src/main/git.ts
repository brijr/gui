import { constants } from 'node:fs'
import { access, lstat, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { GitHubProfile } from '../shared/github'
import { GIT_MESSAGES, type SourceControlWorkspace } from '../shared/source-control'
import type { ShipFile, ShipInfo } from '../shared/types'
import { developerTools, GIT_TOOLS_MISSING } from './developer-tools'
import { execFile } from './process'
import { mayHoldSecrets } from './secret-files'
import { getShellEnv } from './shell-env'

/** Git commands and repository inspection, shared by shipping and review workflows. */
const NOTHING_TO_SHIP = 'No changes to share yet.'
const NOT_A_REPO = 'This project isn’t a Git repository yet, so there’s nothing to commit to.'
const GIT_MISSING = GIT_TOOLS_MISSING

type Host = NonNullable<ShipInfo['remote']>['host']

export interface Remote {
  /** Git's name for it, usually `origin` */
  name: string
  host: Host
  /** `owner/name`; a GitLab project keeps its full group path */
  repo: string
  /** Host of the web UI, e.g. `github.com`; null for a remote on this disk */
  web: string | null
}

export interface Change {
  file: ShipFile
  /** Paths the commit takes: both sides of a rename */
  paths: string[]
  untracked: boolean
}

export interface Repo {
  /** Root of the work tree; may be above the project root in a monorepo */
  top: string
  env: NodeJS.ProcessEnv
  /** Null when HEAD is detached */
  branch: string | null
  /** False on a branch with no commits yet */
  hasHead: boolean
  head: string | null
  defaultBranch: string | null
  /** Local branches and remote-tracking refs, e.g. `refs/heads/main` */
  refs: Set<string>
  remote: Remote | null
  changes: Change[]
  skipped: string[]
  /** Paths of skipped files that are in the index, so a plain `git commit` would take them */
  stagedSecrets: string[]
  /** Why git can't commit right now (conflicts, a merge or rebase in progress) */
  problem: string | null
}

const QUICK_TIMEOUT = 30_000
/** Commit and push run the project's git hooks, which may lint or test for a while. */
export const HOOK_TIMEOUT = 3 * 60_000
export const GH_TIMEOUT = 60_000
const MAX_BUFFER = 32 * 1024 * 1024

// Inherited vars that would point git at a different repo (mirrors checkpoints.ts).
const STRIPPED_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]

// Files that may hold secrets never go into a commit, even when the project doesn't
// ignore them: env files, keys and keystores, credentials, infrastructure state.
// Git state files that mean an operation is half done.
const IN_PROGRESS = [
  'MERGE_HEAD',
  'rebase-merge',
  'rebase-apply',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
]

/**
 * The name and email every commit on this Mac is made with, as the user typed them in Gui
 * (Add name and email…). Writes the user's global Git config, so Gui asks only once.
 */
export async function saveIdentity(name: string, email: string) {
  const env = await commandEnv()
  const home = env.HOME || process.env.HOME || '/'
  await runGit(home, env, ['config', '--global', 'user.name', name])
  await runGit(home, env, ['config', '--global', 'user.email', email])
}

/** Beginners can commit without global git setup. Existing identity always wins. */
export async function applyConnectedIdentity(repo: At, profile: GitHubProfile) {
  const name = profile.name ?? profile.login
  const email = `${profile.login}@users.noreply.github.com`
  if (!(await gitOrNull(repo, ['var', 'GIT_AUTHOR_IDENT']))) {
    repo.env.GIT_AUTHOR_NAME = name
    repo.env.GIT_AUTHOR_EMAIL = email
  }
  if (!(await gitOrNull(repo, ['var', 'GIT_COMMITTER_IDENT']))) {
    repo.env.GIT_COMMITTER_NAME = name
    repo.env.GIT_COMMITTER_EMAIL = email
  }
}

// Reading the repository

/** Whether `root` is inside a repository, without running Git (which waits for trust). */
export async function inRepository(root: string): Promise<boolean> {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    if (
      await lstat(join(dir, '.git')).then(
        () => true,
        () => false,
      )
    )
      return true
    if (dirname(dir) === dir) return false
  }
}

const NO_CHANGES = { changes: [], skipped: [], stagedSecrets: [], conflicts: false }

/**
 * The repository as Gui acts on it. `status: false` leaves out the uncommitted changes (a
 * scan of the whole work tree) for a read that only needs branches and the remote.
 */
export async function openRepo(root: string, { status = true } = {}): Promise<Repo> {
  const env = await commandEnv()
  const top = (await git({ top: root, env }, ['rev-parse', '--show-toplevel'])).trim()
  const at = { top, env }
  const [branch, head, refs, remote, changes, busy] = await Promise.all([
    gitOrNull(at, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    gitOrNull(at, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    git(at, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']),
    readRemote(at),
    status ? readChanges(at) : NO_CHANGES,
    operationInProgress(at),
  ])
  const refSet = new Set(refs.split('\n').filter(Boolean))
  const defaultBranch = await findDefaultBranch(at, remote, refSet, branch)
  const problem = busy
    ? 'Git is in the middle of a merge or rebase. Finish or cancel it from the bar above the chat first.'
    : changes.conflicts
      ? 'Some files have merge conflicts. Resolve them first.'
      : null
  return {
    top,
    env,
    branch,
    hasHead: head !== null,
    head,
    defaultBranch,
    refs: refSet,
    remote,
    changes: changes.changes,
    skipped: changes.skipped,
    stagedSecrets: changes.stagedSecrets,
    problem,
  }
}

/**
 * Where the repository stands, without reading its changes or remote: what an action checks
 * again just before it writes, to be sure nothing moved since it looked.
 */
export async function readContext(
  root: string,
): Promise<Pick<Repo, 'top' | 'branch' | 'head' | 'problem'>> {
  const env = await commandEnv()
  const top = (await git({ top: root, env }, ['rev-parse', '--show-toplevel'])).trim()
  const at = { top, env }
  const [branch, head, busy] = await Promise.all([
    gitOrNull(at, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    gitOrNull(at, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    operationInProgress(at),
  ])
  return {
    top,
    branch,
    head,
    problem: busy
      ? 'Git is in the middle of a merge or rebase. Finish or cancel it from the bar above the chat first.'
      : null,
  }
}

const mutations = new Set<string>()

/** All app-owned repository writes share the common Git directory, including worktrees. */
export async function withGitMutation<T>(root: string, action: (repo: Repo) => Promise<T>) {
  // The lock's key alone, without reading the repository: `action` gets the one full read.
  const common = (
    await git({ top: root, env: await commandEnv() }, ['rev-parse', '--git-common-dir'])
  ).trim()
  const key = await realpath(resolve(root, common))
  if (mutations.has(key)) throw new Error('Another Git action is running. Wait for it to finish.')
  mutations.add(key)
  try {
    return await action(await openRepo(root))
  } finally {
    mutations.delete(key)
  }
}

export interface At {
  top: string
  env: NodeJS.ProcessEnv
}

/** Explicit push refspecs use the upstream branch on this remote, otherwise the local name. */
export async function pushDestination(repo: Repo, branch: string) {
  const remote = repo.remote
  if (!remote) return null
  const [trackingRemote, merge] = await Promise.all([
    gitOrNull(repo, ['config', '--get', `branch.${branch}.remote`]),
    gitOrNull(repo, ['config', '--get', `branch.${branch}.merge`]),
  ])
  return {
    remote: remote.name,
    branch:
      trackingRemote === remote.name && merge?.startsWith('refs/heads/')
        ? merge.slice('refs/heads/'.length)
        : branch,
  }
}

export async function outgoingCount(
  repo: Repo,
  destination: { remote: string; branch: string } | null,
) {
  if (!destination || !repo.hasHead) return 0
  const tracking = `refs/remotes/${destination.remote}/${destination.branch}`
  const defaultRef = `refs/remotes/${destination.remote}/${repo.defaultBranch}`
  const against = repo.refs.has(tracking) ? tracking : repo.refs.has(defaultRef) ? defaultRef : null
  const args = against ? [`${against}..HEAD`] : ['HEAD']
  const count = await gitOrNull(repo, ['rev-list', '--count', ...args, '--'])
  return Number(count) || 0
}

export interface WorktreeEntry {
  /** The work tree's folder */
  path: string
  /** Null when detached */
  branch: string | null
  /** The repository's main checkout, listed first */
  main: boolean
  /** Its folder is gone; `git worktree prune` drops it */
  prunable: boolean
}

/** `git worktree list --porcelain -z`: one record per work tree, the main checkout first. */
export function parseWorktrees(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  for (const field of out.split('\0')) {
    if (field.startsWith('worktree '))
      entries.push({
        path: field.slice('worktree '.length),
        branch: null,
        main: entries.length === 0,
        prunable: false,
      })
    const entry = entries.at(-1)
    if (!entry) continue
    if (field.startsWith('branch refs/heads/'))
      entry.branch = field.slice('branch refs/heads/'.length)
    if (field === 'prunable' || field.startsWith('prunable ')) entry.prunable = true
  }
  return entries
}

export async function listWorktrees(at: At): Promise<WorktreeEntry[]> {
  return parseWorktrees(await git(at, ['worktree', 'list', '--porcelain', '-z']))
}

export async function readWorkspace(repo: Repo): Promise<SourceControlWorkspace> {
  const [worktrees, remoteNames, destination] = await Promise.all([
    listWorktrees(repo),
    git(repo, ['remote']),
    repo.branch ? pushDestination(repo, repo.branch) : null,
  ])
  // Branches checked out in another worktree, and where (none when its folder is gone).
  const occupied = new Map<string, string | null>()
  for (const tree of worktrees)
    if (tree.branch && resolve(tree.path) !== resolve(repo.top))
      occupied.set(tree.branch, tree.prunable ? null : tree.path)
  const main = worktrees[0]
  const worktree =
    main && resolve(main.path) !== resolve(repo.top) ? { path: repo.top, main: main.path } : null
  const names = remoteNames
    .split('\n')
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
  const branches: SourceControlWorkspace['branches'] = []
  for (const ref of repo.refs) {
    if (ref.startsWith('refs/heads/')) {
      const name = ref.slice('refs/heads/'.length)
      branches.push({
        name,
        remote: null,
        checkedOutElsewhere: occupied.has(name),
        worktree: occupied.get(name) ?? null,
      })
    } else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) {
      const path = ref.slice('refs/remotes/'.length)
      const remote = names.find((name) => path.startsWith(`${name}/`))
      if (remote)
        branches.push({
          name: path.slice(remote.length + 1),
          remote,
          checkedOutElsewhere: false,
          worktree: null,
        })
    }
  }
  if (
    repo.branch &&
    !branches.some((branch) => branch.remote === null && branch.name === repo.branch)
  )
    branches.push({ name: repo.branch, remote: null, checkedOutElsewhere: false, worktree: null })
  branches.sort(
    (a, b) => Number(a.remote !== null) - Number(b.remote !== null) || a.name.localeCompare(b.name),
  )
  return {
    root: repo.top,
    branch: repo.branch,
    head: repo.head,
    defaultBranch: repo.defaultBranch,
    branches,
    destination,
    ahead: await outgoingCount(repo, destination),
    published: Boolean(
      destination && repo.refs.has(`refs/remotes/${destination.remote}/${destination.branch}`),
    ),
    writeBlocked: repo.problem,
    worktree,
  }
}

async function readRemote(at: At): Promise<Remote | null> {
  const names = (await git(at, ['remote'])).split('\n').filter(Boolean)
  const branch = await gitOrNull(at, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const [pushRemote, pushDefault, upstream] = await Promise.all([
    branch ? gitOrNull(at, ['config', '--get', `branch.${branch}.pushRemote`]) : null,
    gitOrNull(at, ['config', '--get', 'remote.pushDefault']),
    branch ? gitOrNull(at, ['config', '--get', `branch.${branch}.remote`]) : null,
  ])
  const configured = [pushRemote, pushDefault, upstream].find(
    (name) => name && names.includes(name),
  )
  const name =
    configured ?? (names.includes('origin') ? 'origin' : names.length === 1 ? names[0] : null)
  // Push would read a name like `--receive-pack=…` (only hand-edited config has one) as an option.
  if (!name || !isSafeName(name)) return null
  // get-url applies `insteadOf` shorthands, so `gh:owner/repo` style remotes resolve too.
  const url = await gitOrNull(at, ['remote', 'get-url', '--', name])
  return url ? { name, ...parseRemoteUrl(url) } : null
}

async function findDefaultBranch(
  at: At,
  remote: Remote | null,
  refs: Set<string>,
  branch: string | null,
): Promise<string | null> {
  if (remote) {
    const prefix = `refs/remotes/${remote.name}/`
    const head = await gitOrNull(at, ['symbolic-ref', '--quiet', '--', `${prefix}HEAD`])
    if (head?.startsWith(prefix)) return head.slice(prefix.length)
  }
  for (const name of ['main', 'master']) {
    if (refs.has(`refs/heads/${name}`)) return name
    if (remote && refs.has(`refs/remotes/${remote.name}/${name}`)) return name
  }
  // A repository with a single branch (or none yet): that one is the default.
  const heads = [...refs].filter((ref) => ref.startsWith('refs/heads/'))
  if (heads.length === 0 || (heads.length === 1 && heads[0] === `refs/heads/${branch}`)) {
    return branch
  }
  return null
}

export async function readChanges(at: At) {
  const out = await git(at, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=dirty',
  ])
  const changes: Change[] = []
  const skipped: string[] = []
  const stagedSecrets: string[] = []
  let conflicts = false
  // `XY path\0`, and for renames and copies `XY new\0old\0`.
  const fields = out.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    if (!field || field.length < 4) continue
    const xy = field.slice(0, 2)
    const path = field.slice(3)
    const from = /[RC]/.test(xy) ? (fields[++i] ?? null) : null
    if (/U|AA|DD/.test(xy)) {
      conflicts = true
      continue
    }
    const status = changeStatus(xy)
    const paths = from && xy.includes('R') ? [path, from] : [path]
    if (paths.some(mayHoldSecrets)) {
      // Staged (an agent's `git add -A`), it would go out with the user's next commit.
      if (/[AMRCT]/.test(xy[0] ?? '')) stagedSecrets.push(...paths)
      if (status) skipped.push(path)
      continue
    }
    if (!status) continue
    changes.push({ file: { path, status }, paths, untracked: xy === '??' })
  }
  return { changes, skipped, stagedSecrets, conflicts }
}

function changeStatus(xy: string): ShipFile['status'] | null {
  if (xy === '??') return 'added'
  if (xy === 'AD') return null // added, then deleted again: nothing to commit
  if (xy[1] === 'D' || xy[0] === 'D') return 'deleted'
  if (xy.includes('R')) return 'renamed'
  if (xy.includes('A') || xy.includes('C')) return 'added'
  return 'modified'
}

async function operationInProgress(at: At): Promise<boolean> {
  const out = await git(at, ['rev-parse', ...IN_PROGRESS.flatMap((name) => ['--git-path', name])])
  const paths = out.split('\n').filter(Boolean)
  const found = await Promise.all(paths.map((path) => exists(resolve(at.top, path))))
  return found.some(Boolean)
}

/**
 * Remote URLs in https, ssh (`ssh://` or `git@host:path`) and local-path forms.
 * Exported for tests.
 */
export function parseRemoteUrl(url: string): Omit<Remote, 'name'> {
  const raw = url.trim()
  let hostname: string | null = null
  let web: string | null = null
  let path = raw
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw)
      if (parsed.protocol !== 'file:' && parsed.hostname) {
        hostname = parsed.hostname
        web = parsed.protocol.startsWith('http') ? parsed.host : parsed.hostname
      }
      path = decodeURIComponent(parsed.pathname)
    } catch {
      // Unparseable: treat as a path.
    }
  } else {
    // scp-like `[user@]host:path`: a colon before any slash. The host has no `@`, so
    // `x@github.com@evil.com:…` doesn't pass for github.com.
    const scp = /^(?:[^@/]+@)?([^:/@]+):(.+)$/.exec(raw)
    if (scp?.[1] && scp[2]) {
      hostname = scp[1]
      web = scp[1]
      path = scp[2]
    }
  }

  const segments = path
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean)
  const kind = hostname ? classifyHost(hostname, web ?? hostname) : null
  if (kind?.host === 'github' && segments.length === 2) {
    return { host: 'github', repo: segments.join('/'), web: kind.web }
  }
  if (kind?.host === 'gitlab' && segments.length >= 2) {
    return { host: 'gitlab', repo: segments.join('/'), web: kind.web }
  }
  return { host: 'other', repo: segments.slice(-2).join('/'), web: kind ? kind.web : null }
}

function classifyHost(hostname: string, web: string): { host: Host; web: string } {
  const name = hostname.toLowerCase()
  for (const host of ['github', 'gitlab'] as const) {
    if (
      [`${host}.com`, `www.${host}.com`, `ssh.${host}.com`, `altssh.${host}.com`].includes(name)
    ) {
      return { host, web: `${host}.com` }
    }
    // An ~/.ssh/config alias for a second account, e.g. `git@github-work:owner/repo`.
    if (!name.includes('.') && new RegExp(`^${host}\\b`).test(name)) {
      return { host, web: `${host}.com` }
    }
    // Self-hosted: GitHub Enterprise (github.acme.com) or GitLab (gitlab.acme.com).
    if (name.startsWith(`${host}.`)) return { host, web }
  }
  return { host: 'other', web }
}

/**
 * Names Gui hands git as a remote or branch argument: nothing it could read as an
 * option (`-x`, `--upload-pack=…`) or a revision expression (`@{-1}`, `a..b`, `x^`).
 */
export function isSafeName(name: string): boolean {
  return /^[\p{L}\p{N}_][\p{L}\p{N}_./+-]*$/u.test(name) && !/\.\.|\/\/|\/$|\.$|\.lock$/.test(name)
}

// Errors in plain language

export function readError(error: unknown): string {
  if (!(error instanceof CommandError))
    return error instanceof Error ? error.message : String(error)
  if (error.missing || /xcrun: error|xcode-select/i.test(error.output)) return GIT_MISSING
  if (/not a git repository|must be run in a work tree/i.test(error.output)) return NOT_A_REPO
  if (/dubious ownership/i.test(error.output)) {
    return 'Git won’t work in this folder because another user on this Mac owns it.'
  }
  return `Couldn’t read the project’s Git status: ${tail(error.output, 3)}`
}

export async function commitError(repo: Repo, error: unknown): Promise<string> {
  if (!(error instanceof CommandError))
    return error instanceof Error ? error.message : String(error)
  const output = error.output
  if (error.missing) return GIT_MISSING
  if (error.timedOut) {
    return 'Committing took too long, so Gui stopped it. A check that runs before each commit may be stuck.'
  }
  if (isIdentityError(output)) return GIT_MESSAGES.identity
  if (/nothing (added )?to commit|no changes added to commit/i.test(output)) return NOTHING_TO_SHIP
  if (/index\.lock|another git process/i.test(output)) {
    return 'Another Git app is working in this project right now. Wait a moment, then try again.'
  }
  if (
    /gpg failed|cannot run gpg|failed to sign|signing failed|couldn[’']t load public key|ssh-keygen/i.test(
      output,
    )
  ) {
    return `Git couldn’t sign the commit (commit signing is turned on for this project):\n${tail(output)}`
  }
  if (await hasHook(repo, ['pre-commit', 'prepare-commit-msg', 'commit-msg'])) {
    return `A check in this project stopped the commit:\n${tail(output)}`
  }
  return `Couldn’t commit:\n${tail(output)}`
}

/** Git refused to commit (or merge) for want of a name and email. */
export function isIdentityError(output: string) {
  return /Author identity unknown|Committer identity unknown|tell me who you are|unable to auto-detect email|empty ident name/i.test(
    output,
  )
}

export async function hasHook(repo: Repo, names: string[]): Promise<boolean> {
  // `--git-path hooks/…` follows core.hooksPath, so this read keeps the project's own
  // setting (rev-parse runs nothing).
  const paths = names.flatMap((name) => ['--git-path', `hooks/${name}`])
  let out: string
  try {
    out = (await runGit(repo.top, repo.env, ['rev-parse', ...paths])).trim()
  } catch {
    return false
  }
  if (!out) return false
  const found = await Promise.all(
    out.split('\n').map((path) => executable(resolve(repo.top, path.trim()))),
  )
  return found.some(Boolean)
}

/** The end of git's output, without hints and with any credentials in URLs removed. */
export function tail(output: string, lines = 12): string {
  const kept = output
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !line.startsWith('hint:'))
  const text = kept.slice(-lines).join('\n')
  return text.length > 1200 ? `…${text.slice(-1200)}` : text || 'Git gave no details.'
}

// Running commands

export class CommandError extends Error {
  /** stderr then stdout: git and hooks print to either */
  readonly output: string
  /** The program isn't installed */
  readonly missing: boolean
  readonly timedOut: boolean

  constructor(command: string, output: string, missing: boolean, timedOut: boolean) {
    super(`${command} failed: ${output.trim() || 'no output'}`)
    this.output = output
    this.missing = missing
    this.timedOut = timedOut
  }
}

interface RunOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  timeout?: number
  /** Written to stdin, which is then closed so nothing can wait on input */
  input?: string
}

export function run(file: string, args: string[], options: RunOptions) {
  return new Promise<{ stdout: string; stderr: string }>((done, fail) => {
    const child = execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeout ?? QUICK_TIMEOUT,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (!error) return done({ stdout, stderr })
        const output = [stderr, stdout].filter((text) => text.trim()).join('\n')
        const timedOut = error.killed === true && error.signal !== null
        fail(
          new CommandError(`${file} ${args[0] ?? ''}`, output, error.code === 'ENOENT', timedOut),
        )
      },
    )
    // A command that exits before reading stdin makes the write fail; that's fine.
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(options.input ?? '')
  })
}

/**
 * Repo config can name programs for git to run: core.fsmonitor on every status, hooks,
 * gpg for log.showSignature. Everything but what the user asked for (switch, commit,
 * push) turns those off, so looking at a project never runs its code.
 */
const SAFE_READ = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'log.showSignature=false',
]

async function runGit(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  options?: Partial<RunOptions>,
) {
  await developerTools.requireGit()
  const result = await run('git', ['--literal-pathspecs', ...args], { cwd, env, ...options })
  return result.stdout
}

/** Reads, and writes that run no hooks; see SAFE_READ. */
export function git(at: At, args: string[], options?: Partial<RunOptions>): Promise<string> {
  return runGit(at.top, at.env, [...SAFE_READ, ...args], options)
}

/** What the user asked for runs as it would in Terminal: hooks, fsmonitor and all. */
export function gitAsUser(at: At, args: string[], options?: Partial<RunOptions>): Promise<string> {
  return runGit(at.top, at.env, args, options)
}

/** Trimmed stdout, or null when the command fails (e.g. `symbolic-ref` on a detached HEAD). */
export async function gitOrNull(at: At, args: string[]): Promise<string | null> {
  try {
    return (await git(at, args)).trim()
  } catch {
    return null
  }
}

async function commandEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...(await getShellEnv()) }
  for (const key of STRIPPED_ENV) delete env[key]
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    // A commit never needs an editor here; this keeps one from ever opening.
    GIT_EDITOR: 'true',
    // English messages whatever the user's locale, so errors can be explained.
    LANGUAGE: 'en',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    NO_COLOR: '1',
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
