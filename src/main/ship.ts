import { execFile } from 'node:child_process'
import { constants, type Dirent } from 'node:fs'
import { access, type FileHandle, lstat, open, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ShipFile, ShipInfo, ShipRequest, ShipResult } from '../shared/types'
import { connectedGitHub, pullGitHub, pushGitHub } from './github'
import { getShellEnv } from './shell-env'

/**
 * Turning the project's uncommitted changes into a pull request: what would be
 * committed, then commit, push, and open the PR. Runs the user's own git (and gh,
 * when it's signed in) with their shell environment, never interactively.
 */

type Host = NonNullable<ShipInfo['remote']>['host']

interface Remote {
  /** Git's name for it, usually `origin` */
  name: string
  host: Host
  /** `owner/name`; a GitLab project keeps its full group path */
  repo: string
  /** Host of the web UI, e.g. `github.com`; null for a remote on this disk */
  web: string | null
}

interface Change {
  file: ShipFile
  /** Paths the commit takes: both sides of a rename */
  paths: string[]
  untracked: boolean
}

interface Repo {
  /** Root of the work tree; may be above the project root in a monorepo */
  top: string
  env: NodeJS.ProcessEnv
  /** Null when HEAD is detached */
  branch: string | null
  /** False on a branch with no commits yet */
  hasHead: boolean
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

const NOTHING_TO_SHIP = 'No changes to share yet.'
const NOT_A_REPO = 'This project isn’t a Git repository yet, so there’s nothing to commit to.'
const GIT_MISSING =
  'Git isn’t set up on this Mac yet. Install Apple’s Command Line Tools (macOS offers them the first time Git runs), then try again.'

const QUICK_TIMEOUT = 30_000
/** Commit and push run the project's git hooks, which may lint or test for a while. */
const HOOK_TIMEOUT = 3 * 60_000
const GH_TIMEOUT = 60_000
const MAX_BUFFER = 32 * 1024 * 1024

/**
 * Branches a team shares or deploys from. Shipping from one starts a new branch, so
 * Gui never commits straight onto them unless the user explicitly picks the branch
 * they're already on.
 */
const SHARED_BRANCHES = new Set([
  'main',
  'master',
  'develop',
  'development',
  'dev',
  'staging',
  'stage',
  'production',
  'prod',
  'trunk',
  'gh-pages',
])

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
// Mirrors the secret excludes of checkpoints.ts, and goes further.
const SAFE_ENV_FILE = /^(?:\.env|\.dev\.vars)(?:\..+)?\.(?:example|sample|template)$/i
const SECRET_FILES = [
  /^\.env(\..*)?$/i,
  /^\.envrc$/i,
  /^\.dev\.vars(\..*)?$/i,
  /^.+\.env$/i,
  /\.(pem|key|p8|p12|pfx|jks|keystore|ppk)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.(npmrc|netrc|pypirc|git-credentials|yarnrc\.yml|pgpass)$/i,
  /^credentials(\.(json|ya?ml|toml|ini))?$/i,
  // Config-style only: `secrets.ts` is usually code the agent edited.
  /^secrets\.(json|ya?ml|toml|ini|env|txt)$/i,
  /\.(tfvars(\.json)?|tfstate(\.backup)?)$/i,
  /^serviceAccountKey.*\.json$/i,
  /firebase-adminsdk.*\.json$/i,
  /^client_secret.*\.json$/i,
]
/** Folders (a path, for gcloud) where everything is a credential or key. */
const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.config/gcloud']

// Git state files that mean an operation is half done.
const IN_PROGRESS = [
  'MERGE_HEAD',
  'rebase-merge',
  'rebase-apply',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'BISECT_LOG',
]

export async function shipInfo(root: string, prompts: string[]): Promise<ShipInfo> {
  let repo: Repo
  try {
    repo = await openRepo(root)
  } catch (error) {
    return blockedInfo(readError(error))
  }

  const files = repo.changes.map((change) => change.file)
  const newBranch = startsNewBranch(repo)
  let blocked = repo.problem
  if (!blocked && files.length === 0) {
    // Committed earlier but the push failed: shipping again just pushes.
    const pending = !newBranch && repo.branch !== null && (await aheadOfRemote(repo, repo.branch))
    if (!pending) blocked = NOTHING_TO_SHIP
  }
  // Said up front rather than after the user writes a title; ship() checks again.
  if (!blocked && files.length > 0) {
    blocked = await findLeak(repo, repo.changes, await localEnvValues(repo))
  }

  const fresh = await unshippedPrompts(repo, prompts)
  const cleaned = fresh.map(cleanPrompt).filter(Boolean)
  const title = cleaned[0]
    ? cap(cleaned[0], 72)
    : files.length > 0
      ? filesTitle(files)
      : ((await gitOrNull(repo, ['log', '-1', '--format=%s'])) ?? 'Update')
  const branch =
    newBranch || repo.branch === null ? uniqueBranch(`gui/${slugify(title)}`, repo) : repo.branch

  return {
    blocked,
    branch: repo.branch,
    onDefaultBranch: repo.branch !== null && repo.branch === repo.defaultBranch,
    files,
    skipped: repo.skipped,
    remote: repo.remote && { host: repo.remote.host, repo: repo.remote.repo },
    suggestion: { branch, title, body: bulletList(cleaned, title) },
  }
}

export async function ship(root: string, request: ShipRequest): Promise<ShipResult> {
  let repo: Repo
  try {
    repo = await openRepo(root)
  } catch (error) {
    throw new Error(readError(error))
  }
  if (repo.problem) throw new Error(repo.problem)

  const connected =
    repo.remote?.host === 'github' && repo.remote.web === 'github.com'
      ? await connectedGitHub(repo.remote.repo)
      : null
  // Beginners can commit without global git setup. Existing identity always wins.
  if (connected) {
    if (!(await gitOrNull(repo, ['var', 'GIT_AUTHOR_IDENT']))) {
      repo.env.GIT_AUTHOR_NAME = connected.profile.name ?? connected.profile.login
      repo.env.GIT_AUTHOR_EMAIL = `${connected.profile.login}@users.noreply.github.com`
    }
    if (!(await gitOrNull(repo, ['var', 'GIT_COMMITTER_IDENT']))) {
      repo.env.GIT_COMMITTER_NAME = connected.profile.name ?? connected.profile.login
      repo.env.GIT_COMMITTER_EMAIL = `${connected.profile.login}@users.noreply.github.com`
    }
  }

  const title = request.title.replace(/\s+/g, ' ').trim()
  const body = request.body.trim()
  const branch = request.branch.trim()
  if (!title) throw new Error('Add a title first.')
  await assertBranchName(repo, branch)

  // The title and description go to the host too, and the branch name with the push.
  const env = await localEnvValues(repo)
  const fields: Array<[string, string]> = [
    ['The title', title],
    ['The description', body],
    ['The branch name', branch],
  ]
  for (const [field, text] of fields) {
    const kind = secretIn(text, env)
    if (kind) throw new Error(leakMessage(field, kind))
  }

  const start = repo.branch
  const startCommit = repo.hasHead ? await gitOrNull(repo, ['rev-parse', 'HEAD']) : null
  let status: Pick<Repo, 'changes' | 'stagedSecrets'> = repo
  let switched: 'created' | 'existing' | null = null
  if (branch !== start) {
    switched = await switchBranch(repo, branch)
    status = await readChanges(repo)
  }
  const { changes, stagedSecrets } = status
  const undo = () => (switched ? undoSwitch(repo, branch, switched, start, startCommit) : null)

  if (changes.length > 0) {
    const leak = await findLeak(repo, changes, env)
    if (leak) {
      await undo()
      throw new Error(leak)
    }
    await unstage(repo, stagedSecrets)
    try {
      await commitChanges(repo, changes, title, body)
    } catch (error) {
      await undo()
      throw new Error(await commitError(repo, error))
    }
  } else if (!(await aheadOfRemote(repo, branch))) {
    await undo()
    throw new Error(NOTHING_TO_SHIP)
  }
  const commit = (await git(repo, ['rev-parse', '--short', 'HEAD'])).trim()

  const remote = repo.remote
  if (!remote) return { branch, commit, outcome: 'committed', url: null }

  let pushOutput: string
  try {
    if (connected) {
      await pushGitHub(connected.repository.id, remote.repo, repo.top, branch)
      await gitAsUser(repo, [
        'update-ref',
        `refs/remotes/${remote.name}/${branch}`,
        `refs/heads/${branch}`,
      ])
      await gitAsUser(repo, ['branch', `--set-upstream-to=${remote.name}/${branch}`, '--', branch])
      pushOutput = ''
    } else pushOutput = await push(repo, remote, branch)
  } catch (error) {
    throw new Error(await pushError(repo, remote, branch, error))
  }

  const base = pullRequestBase(repo, remote, start, branch)
  // Committed straight onto the base branch: there's nothing to review.
  if (base === branch) return { branch, commit, outcome: 'pushed', url: null }

  // gh signs in to whatever host it's pointed at, so it's only ever pointed at github.com.
  if (remote.host === 'github' && remote.web === 'github.com') {
    if (connected && base) {
      const url = await pullGitHub(connected.repository.id, branch, base, title, body).catch(
        () => null,
      )
      if (url) return { branch, commit, outcome: 'created', url }
    }
    const url = await createWithGh(repo, remote, branch, base, title, body)
    if (url) return { branch, commit, outcome: 'created', url }
  }
  const url = newPullRequestUrl(remote, branch, base, title, body) ?? pushHintUrl(pushOutput)
  return url
    ? { branch, commit, outcome: 'compare', url }
    : { branch, commit, outcome: 'pushed', url: null }
}

// Reading the repository

async function openRepo(root: string): Promise<Repo> {
  const env = await commandEnv()
  const top = (await git({ top: root, env }, ['rev-parse', '--show-toplevel'])).trim()
  const at = { top, env }
  const [branch, head, refs, remote, status, busy] = await Promise.all([
    gitOrNull(at, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    gitOrNull(at, ['rev-parse', '--verify', '--quiet', 'HEAD']),
    git(at, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']),
    readRemote(at),
    readChanges(at),
    operationInProgress(at),
  ])
  const refSet = new Set(refs.split('\n').filter(Boolean))
  const defaultBranch = await findDefaultBranch(at, remote, refSet, branch)
  const problem = busy
    ? 'Git is in the middle of a merge or rebase. Finish it in your Git app first.'
    : status.conflicts
      ? 'Some files have merge conflicts. Resolve them first.'
      : null
  return {
    top,
    env,
    branch,
    hasHead: head !== null,
    defaultBranch,
    refs: refSet,
    remote,
    changes: status.changes,
    skipped: status.skipped,
    stagedSecrets: status.stagedSecrets,
    problem,
  }
}

interface At {
  top: string
  env: NodeJS.ProcessEnv
}

async function readRemote(at: At): Promise<Remote | null> {
  const names = (await git(at, ['remote'])).split('\n').filter(Boolean)
  const name = names.includes('origin') ? 'origin' : names.length === 1 ? names[0] : null
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

async function readChanges(at: At) {
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

/** Whether a changed file may hold secrets (`.env.local`, keys, credentials). */
export function mayHoldSecrets(path: string): boolean {
  const parts = path.split('/')
  const name = parts.at(-1) ?? ''
  const dirs = `/${parts.slice(0, -1).join('/').toLowerCase()}/`
  if (SECRET_DIRS.some((dir) => dirs.includes(`/${dir}/`))) return true
  if (SAFE_ENV_FILE.test(name)) return false
  return SECRET_FILES.some((pattern) => pattern.test(name))
}

async function operationInProgress(at: At): Promise<boolean> {
  const out = await git(at, ['rev-parse', ...IN_PROGRESS.flatMap((name) => ['--git-path', name])])
  const paths = out.split('\n').filter(Boolean)
  const found = await Promise.all(paths.map((path) => exists(resolve(at.top, path))))
  return found.some(Boolean)
}

/** Whether `branch` has commits the remote doesn't, as far as this clone knows. */
async function aheadOfRemote(repo: Repo, branch: string): Promise<boolean> {
  const remote = repo.remote
  if (!remote || !repo.hasHead) return false
  const tracking = `refs/remotes/${remote.name}/${branch}`
  const base = repo.defaultBranch && `refs/remotes/${remote.name}/${repo.defaultBranch}`
  const against = repo.refs.has(tracking) ? tracking : base && repo.refs.has(base) ? base : null
  if (!against) return true
  const count = await gitOrNull(repo, ['rev-list', '--count', `${against}..HEAD`, '--'])
  return Number(count) > 0
}

function startsNewBranch(repo: Repo): boolean {
  if (repo.branch === null) return true
  if (!repo.hasHead) return false // the repository's first commit
  return repo.branch === repo.defaultBranch || SHARED_BRANCHES.has(repo.branch)
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
function isSafeName(name: string): boolean {
  return /^[\p{L}\p{N}_][\p{L}\p{N}_./+-]*$/u.test(name) && !/\.\.|\/\/|\/$|\.$|\.lock$/.test(name)
}

// Suggestions

const FILLER_START =
  /^(?:(?:hey|hi|hello|ok(?:ay)?|so|now|also|and|then|please|pls|plz|can you|could you|would you|will you|can we|could we|let[’']?s|i want you to|i[’']d like you to|i would like you to|i need you to|i want to|i[’']d like to)\b[\s,!.:]*)+/i
/**
 * Polite endings, stripped one at a time from the end. As one regex, a run of them
 * followed by anything else ("please please … now") backtracks exponentially.
 */
const FILLER_END = ['please', 'pls', 'plz', 'thanks', 'thank you', 'thx', 'ty']

/** One line, without "can you…please" padding, capitalized and unpunctuated. Exported for tests. */
export function cleanPrompt(prompt: string): string {
  const text = trimEnd(
    stripFillerEnd(prompt.replace(/\s+/g, ' ').trim().replace(FILLER_START, '')),
    /[\s.!?…,;:]/,
  ).trim()
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** "make it blue, thanks!" → "make it blue": each filler word with the punctuation around it. */
function stripFillerEnd(text: string): string {
  let kept = text
  for (;;) {
    const rest = trimEnd(kept, /[\s.!]/)
    const word = FILLER_END.find(
      (filler) =>
        rest.slice(-filler.length).toLowerCase() === filler &&
        !/\w/.test(rest.charAt(rest.length - filler.length - 1)),
    )
    if (!word) return kept
    kept = trimEnd(rest.slice(0, -word.length), /[\s,;:-]/)
  }
}

/** `text` without the trailing characters that match `char`, a one-character pattern. */
function trimEnd(text: string, char: RegExp): string {
  let end = text.length
  while (end > 0 && char.test(text.charAt(end - 1))) end--
  return text.slice(0, end)
}

/** Cuts at a word boundary near `max` characters (code points, so emoji stay whole). */
function cap(text: string, max: number): string {
  const chars = Array.from(text)
  if (chars.length <= max) return text
  const cut = chars.slice(0, max - 1).join('')
  const space = cut.lastIndexOf(' ')
  const kept = space > max * 0.6 ? cut.slice(0, space) : cut
  return `${kept.replace(/[\s.,;:!?-]+$/, '')}…`
}

function filesTitle(files: ShipFile[]): string {
  const only = files.length === 1 ? files[0] : undefined
  if (!only) return `Update ${files.length} files`
  const name = only.path.split('/').at(-1) ?? only.path
  const verb = { added: 'Add', modified: 'Update', deleted: 'Remove', renamed: 'Rename' }
  return `${verb[only.status]} ${name}`
}

/** The prompts as a short bullet list; empty when the title already says it all. */
function bulletList(cleaned: string[], title: string): string {
  const items = [...new Set(cleaned)].map((prompt) => cap(prompt, 200))
  if (items.length === 0 || (items.length === 1 && items[0] === title)) return ''
  const shown = items.slice(0, 20).map((item) => `- ${item}`)
  if (items.length > 20) shown.push(`- …and ${items.length - 20} more`)
  return shown.join('\n')
}

/**
 * Drops prompts an earlier ship already put in a commit on this branch, so a second
 * pull request from the same chat is titled after the new requests.
 */
async function unshippedPrompts(repo: Repo, prompts: string[]): Promise<string[]> {
  if (prompts.length === 0 || !repo.hasHead || startsNewBranch(repo)) return prompts
  const remoteBase = repo.remote && `refs/remotes/${repo.remote.name}/${repo.defaultBranch}`
  const base =
    repo.defaultBranch === null
      ? null
      : remoteBase && repo.refs.has(remoteBase)
        ? remoteBase
        : repo.refs.has(`refs/heads/${repo.defaultBranch}`)
          ? `refs/heads/${repo.defaultBranch}`
          : null
  if (!base) return prompts
  const log = await gitOrNull(repo, ['log', '--format=%B', '-n', '100', `${base}..HEAD`, '--'])
  if (!log) return prompts
  const fresh = prompts.filter((prompt) => {
    const cleaned = cleanPrompt(prompt)
    return !cleaned || !(log.includes(cap(cleaned, 200)) || log.includes(cap(cleaned, 72)))
  })
  return fresh.length > 0 ? fresh : prompts
}

function slugify(text: string): string {
  const words = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  let slug = ''
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word
    if (next.length > 40) break
    slug = next
  }
  return slug || words[0]?.slice(0, 40) || 'changes'
}

/** `name`, or `name-2`, `name-3`… if a local or remote branch already has it. */
function uniqueBranch(name: string, repo: Repo): string {
  const taken = (candidate: string) =>
    repo.refs.has(`refs/heads/${candidate}`) ||
    (repo.remote !== null && repo.refs.has(`refs/remotes/${repo.remote.name}/${candidate}`))
  if (!taken(name)) return name
  for (let n = 2; ; n++) {
    if (!taken(`${name}-${n}`)) return `${name}-${n}`
  }
}

function blockedInfo(message: string): ShipInfo {
  return {
    blocked: message,
    branch: null,
    onDefaultBranch: false,
    files: [],
    skipped: [],
    remote: null,
    suggestion: { branch: '', title: '', body: '' },
  }
}

// Secrets in what would be shared

/** Formats real credentials have, looked for in what a commit or pull request adds. */
const SECRET_FORMATS: Array<[RegExp, string]> = [
  [/\bAKIA[0-9A-Z]{16}\b/g, 'an AWS access key'],
  [/\b[rs]k_live_[0-9A-Za-z]{16,}/g, 'a Stripe live key'],
  [/\b(?:gh[oprsu]_[0-9A-Za-z]{30,}|github_pat_\w{30,})/g, 'a GitHub token'],
  [/\bxox[abposr]-[0-9A-Za-z-]{10,}/g, 'a Slack token'],
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/g, 'a private key'],
  [/\bAIza[\w-]{35}/g, 'a Google API key'],
  [/\bsk-ant-[\w-]{20,}/g, 'an Anthropic API key'],
  [/\bsk-(?:proj-[\w-]{20,}|[0-9A-Za-z]{32,})/g, 'an OpenAI API key'],
]
/** Docs' sample credentials (AWS's `AKIAIOSFODNN7EXAMPLE`) aren't secret. */
const EXAMPLE_SECRET = /example/i

/** Bigger files are left unscanned, as are files past the total. */
const SCAN_FILE_BYTES = 1024 * 1024
const SCAN_TOTAL_BYTES = 8 * 1024 * 1024
// Plain unified diffs whatever the user's config: no external diff programs or textconv
// filters (repo config can name both), fixed prefixes, and only the changed lines.
const DIFF_OPTIONS = [
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '--unified=0',
  '--find-renames',
  '--src-prefix=a/',
  '--dst-prefix=b/',
]

/** `.env`, `.env.local`, `.env.development.local`… */
const LOCAL_ENV_FILE = /^\.env(?:\.[^.]+)?\.local$|^\.env$/i
const ENV_SEARCH_DEPTH = 3
const ENV_SEARCH_DIRS = 2000
const ENV_SKIPPED_DIRS = new Set(['node_modules', '.git'])
const ENV_FILE_BYTES = 256 * 1024
/** Frameworks build these into every page, so they're public by design. */
const PUBLIC_ENV_KEY = /^(?:NEXT_PUBLIC|VITE|PUBLIC|EXPO_PUBLIC|REACT_APP|GATSBY|NUXT_PUBLIC)_/i

interface EnvValue {
  value: string
  /** The env file it's from, relative to the work tree, e.g. `apps/web/.env.local` */
  file: string
}

function leakMessage(where: string, kind: string): string {
  return `${where} looks like it contains a secret (${kind}). Remove it, then try again.`
}

/** The kind of secret in `text`, e.g. "an AWS access key"; null when there's none. */
function secretIn(text: string, env: EnvValue[]): string | null {
  for (const [pattern, kind] of SECRET_FORMATS) {
    for (const match of text.matchAll(pattern)) {
      if (!EXAMPLE_SECRET.test(match[0])) return kind
    }
  }
  const found = env.find(({ value }) => text.includes(value))
  return found ? `a value from \`${found.file}\`` : null
}

/**
 * Why committing `changes` would share a secret, naming the file but never the secret;
 * null when it wouldn't. Only what the commit adds counts, so a key already in the
 * repository doesn't block every later change to its file.
 */
async function findLeak(repo: Repo, changes: Change[], env: EnvValue[]): Promise<string | null> {
  let added: Map<string, string>
  try {
    added = await addedText(repo, changes)
  } catch (error) {
    const output = error instanceof CommandError ? error.output : String(error)
    return `Couldn’t check the changes for secrets:\n${tail(output)}`
  }
  for (const [path, text] of added) {
    const kind = secretIn(text, env)
    if (kind) return leakMessage(`\`${path}\``, kind)
  }
  return null
}

/**
 * What each change adds: a new file's whole text, or the added lines of its diff from
 * HEAD (the working tree is what `commit --only` takes). Binary files aren't read, nor
 * files past the size caps.
 */
async function addedText(repo: Repo, changes: Change[]): Promise<Map<string, string>> {
  const added = new Map<string, string>()
  const kept = changes.filter((change) => change.file.status !== 'deleted')
  const sizes = await Promise.all(
    kept.map((change) => fileSize(resolve(repo.top, change.paths[0] ?? ''))),
  )
  const diffed: string[][] = []
  let budget = SCAN_TOTAL_BYTES
  for (const [index, change] of kept.entries()) {
    const path = change.paths[0]
    const size = sizes[index] ?? null
    if (!path || size === null || size > SCAN_FILE_BYTES || size > budget) continue
    budget -= size
    if (change.untracked || !repo.hasHead) {
      const text = await readText(resolve(repo.top, path), size, false)
      if (text !== null) added.set(path, text)
    } else {
      diffed.push(change.paths)
    }
  }
  for (const paths of pathChunks(diffed)) {
    const args = ['-c', 'core.quotePath=false', 'diff', 'HEAD', ...DIFF_OPTIONS, '--', ...paths]
    collectAdded(await git(repo, args), added)
  }
  return added
}

/** Each file's `+` lines from a `git diff`, appended to `into`. */
function collectAdded(diff: string, into: Map<string, string>) {
  // Hunk lines start with `+`, `-`, a space or `\`, so a line of content can't pass for
  // a `diff --git` header, and a `+++ ` line is a header only before the first `@@`.
  let path: string | null = null
  let header = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      header = true
      path = null
    } else if (header) {
      if (line.startsWith('+++ ')) path = diffPath(line.slice(4))
      else if (line.startsWith('@@')) header = false
    } else if (path !== null && line.startsWith('+')) {
      into.set(path, `${into.get(path) ?? ''}${line.slice(1)}\n`)
    }
  }
}

/** The file a `+++ b/<path>` header names; null for `/dev/null`. */
function diffPath(name: string): string | null {
  // Git ends a name that has spaces with a tab, and C-quotes unusual ones.
  const path = unquote(name.replace(/\t$/, ''))
  return path.startsWith('b/') ? path.slice(2) : null
}

const C_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
}

/** A path as git prints it: as is, or `"…"` with C escapes and octal bytes. */
function unquote(text: string): string {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text
  const parts: Buffer[] = []
  for (const [part, code] of text.slice(1, -1).matchAll(/\\([0-7]{3}|.)|[^\\]+/g)) {
    if (code === undefined) parts.push(Buffer.from(part))
    else if (/^[0-7]{3}$/.test(code)) parts.push(Buffer.from([Number.parseInt(code, 8)]))
    else parts.push(Buffer.from([C_ESCAPES[code] ?? code.charCodeAt(0)]))
  }
  return Buffer.concat(parts).toString('utf8')
}

/** Paths for git's command line in batches, keeping both sides of a rename together. */
function pathChunks(groups: string[][], max = 200): string[][] {
  const chunks: string[][] = []
  let chunk: string[] = []
  for (const group of groups) {
    if (chunk.length > 0 && chunk.length + group.length > max) {
      chunks.push(chunk)
      chunk = []
    }
    chunk.push(...group)
  }
  if (chunk.length > 0) chunks.push(chunk)
  return chunks
}

/**
 * Long, credential-looking values from env files git doesn't track (`.env.local`), at
 * the top of the work tree and a few folders down. A tracked env file's values are
 * already in the repository.
 */
async function localEnvValues(repo: Repo): Promise<EnvValue[]> {
  const files = await localEnvFiles(repo.top)
  if (files.length === 0) return []
  const tracked = new Set(
    ((await gitOrNull(repo, ['ls-files', '-z', '--', ...files])) ?? '').split('\0'),
  )
  const values = new Map<string, string>()
  for (const file of files) {
    if (tracked.has(file)) continue
    const text = await readText(join(repo.top, file), ENV_FILE_BYTES, true)
    for (const [key, value] of parseEnv(text ?? '')) {
      if (!values.has(value) && credentialLike(key, value)) values.set(value, file)
    }
  }
  return [...values].map(([value, file]) => ({ value, file }))
}

async function localEnvFiles(top: string): Promise<string[]> {
  const found: string[] = []
  let level = ['']
  let budget = ENV_SEARCH_DIRS
  for (let depth = 0; depth <= ENV_SEARCH_DEPTH && level.length > 0; depth++) {
    const dirs = level.slice(0, budget)
    budget -= dirs.length
    const listings = await Promise.all(
      dirs.map((dir) => readdir(join(top, dir), { withFileTypes: true }).catch((): Dirent[] => [])),
    )
    level = []
    for (const [index, entries] of listings.entries()) {
      const dir = dirs[index]
      for (const entry of entries) {
        const path = dir ? `${dir}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (!ENV_SKIPPED_DIRS.has(entry.name)) level.push(path)
        } else if (LOCAL_ENV_FILE.test(entry.name) && (entry.isFile() || entry.isSymbolicLink())) {
          found.push(path)
        }
      }
    }
  }
  return found
}

/** `KEY=value` lines, read the way dotenv does: `export`, quotes, trailing comments. */
function parseEnv(text: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([\w.-]+)\s*=(.*)$/.exec(line)
    if (!match?.[1] || match[2] === undefined) continue
    let value = match[2].trim()
    const quote = value.charAt(0)
    if (quote === '"' || quote === "'" || quote === '`') {
      const end = value.indexOf(quote, 1)
      value = end === -1 ? value.slice(1) : value.slice(1, end)
    } else {
      const comment = value.search(/\s#/)
      if (comment !== -1) value = value.slice(0, comment).trimEnd()
    }
    pairs.push([match[1], value])
  }
  return pairs
}

/**
 * Whether an env value is worth looking for. Plain settings like `http://localhost:3000`,
 * an email address or a project name turn up in code for good reasons; credentials are
 * 12+ characters of letters and digits, or a URL with a password or a token in it.
 */
function credentialLike(key: string, value: string): boolean {
  if (value.length < 12 || /\s/.test(value) || PUBLIC_ENV_KEY.test(key)) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      return url.password !== '' || /[A-Za-z0-9]{16,}/.test(`${url.pathname}${url.search}`)
    } catch {
      return false
    }
  }
  return /[A-Za-z]/.test(value) && /\d/.test(value)
}

/** Size of a regular file; null for anything else (gone, a symlink, a submodule). */
async function fileSize(path: string): Promise<number | null> {
  try {
    const stats = await lstat(path)
    return stats.isFile() ? stats.size : null
  } catch {
    return null
  }
}

/**
 * Up to `max` bytes of a regular file as text; null for binary files (a NUL early on,
 * as git decides) and anything that isn't a file. Never blocks on a FIFO.
 */
async function readText(path: string, max: number, follow: boolean): Promise<string | null> {
  let file: FileHandle | undefined
  try {
    const flags = constants.O_RDONLY | constants.O_NONBLOCK | (follow ? 0 : constants.O_NOFOLLOW)
    file = await open(path, flags)
    if (!(await file.stat()).isFile()) return null
    const buffer = Buffer.alloc(max)
    const { bytesRead } = await file.read(buffer, 0, max, 0)
    const data = buffer.subarray(0, bytesRead)
    return data.subarray(0, 8000).includes(0) ? null : data.toString('utf8')
  } catch {
    return null
  } finally {
    await file?.close()
  }
}

/** Takes secret files back out of the index, so the user's next commit leaves them out too. */
async function unstage(repo: Repo, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  // Before the first commit there's no HEAD to restore from; dropping them is the same.
  const args = repo.hasHead
    ? ['restore', '--staged', '--', ...paths]
    : ['rm', '--cached', '--quiet', '-f', '--', ...paths]
  // Best effort: `commit --only` keeps them out of Gui's commit either way.
  await git(repo, args).catch(() => undefined)
}

// Branch, commit, push

async function assertBranchName(repo: Repo, branch: string): Promise<void> {
  const invalid = `“${branch}” can’t be used as a branch name. Try letters, numbers, dashes and slashes.`
  if (!branch) throw new Error('Add a branch name first.')
  if (branch.startsWith('-') || branch === 'HEAD' || branch.includes('@{')) {
    throw new Error(invalid)
  }
  // `--branch` would expand `@{-1}`-style names; anything it rewrites is rejected above.
  const checked = await gitOrNull(repo, ['check-ref-format', '--branch', branch])
  if (checked !== branch) throw new Error(invalid)
}

async function switchBranch(repo: Repo, branch: string): Promise<'created' | 'existing'> {
  const exists = repo.refs.has(`refs/heads/${branch}`)
  if (exists && (branch === repo.defaultBranch || SHARED_BRANCHES.has(branch))) {
    throw new Error(
      `Pick a new branch name. Gui only commits to \`${branch}\` when you’re already on it.`,
    )
  }
  try {
    // Uncommitted changes come along; git refuses rather than overwrite any of them.
    await gitAsUser(
      repo,
      exists ? ['switch', '--quiet', '--', branch] : ['switch', '--quiet', `--create=${branch}`],
    )
  } catch (error) {
    const output = error instanceof CommandError ? error.output : ''
    if (/overwritten|would be lost/i.test(output)) {
      throw new Error(
        `Couldn’t use \`${branch}\`: it has different versions of the files you changed. Pick a new branch name.`,
      )
    }
    throw new Error(`Couldn’t create the branch \`${branch}\`: ${tail(output, 3)}`)
  }
  return exists ? 'existing' : 'created'
}

/** After a failed commit: back to where shipping started, so a retry starts clean. */
async function undoSwitch(
  repo: Repo,
  branch: string,
  switched: 'created' | 'existing',
  start: string | null,
  startCommit: string | null,
): Promise<void> {
  try {
    if (start) {
      // A name git could misread (only hand-made refs have one) is left alone; staying
      // on the new branch loses nothing.
      if (!isSafeName(start)) return
      await gitAsUser(repo, ['switch', '--quiet', '--', start])
    } else if (startCommit) {
      await gitAsUser(repo, ['switch', '--quiet', '--detach', '--', startCommit])
    } else {
      return
    }
    // Still pointing at the start commit, so `-d` deletes nothing that isn't elsewhere.
    if (switched === 'created') await git(repo, ['branch', '--quiet', '-d', '--', branch])
  } catch {
    // Best effort: the changes are still in the working tree either way.
  }
}

async function commitChanges(repo: Repo, changes: Change[], title: string, body: string) {
  const list = (paths: string[]) => paths.map((path) => `${path}\0`).join('')
  const untracked = changes.filter((change) => change.untracked).flatMap((change) => change.paths)
  const fromStdin = ['--pathspec-from-file=-', '--pathspec-file-nul']
  if (untracked.length > 0) {
    await gitAsUser(repo, ['add', ...fromStdin], { input: list(untracked) })
  }
  // `--only` commits exactly these paths from the working tree, whatever else is staged
  // (a staged `.env` stays out of the commit).
  const message = body ? ['-m', title, '-m', body] : ['-m', title]
  await gitAsUser(repo, ['commit', '--only', '--quiet', ...message, ...fromStdin], {
    input: list(changes.flatMap((change) => change.paths)),
    timeout: HOOK_TIMEOUT,
  })
}

async function push(repo: Repo, remote: Remote, branch: string): Promise<string> {
  const env = { ...repo.env }
  // Never wait on an ssh passphrase or host-key prompt nobody can see. A user's own
  // GIT_SSH_COMMAND or core.sshCommand is how they push from Terminal, so it's kept.
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) {
    const configured = await gitOrNull(repo, ['config', '--get', 'core.sshCommand'])
    if (!configured) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  }
  const ref = `refs/heads/${branch}`
  const { stdout, stderr } = await run(
    'git',
    ['push', '--set-upstream', '--no-follow-tags', '--', remote.name, `${ref}:${ref}`],
    { cwd: repo.top, env, timeout: HOOK_TIMEOUT },
  )
  return `${stderr}\n${stdout}`
}

/**
 * Where the pull request lands: the default branch, or the shared branch shipping
 * started from (e.g. `develop`) when that's on the remote too.
 */
function pullRequestBase(
  repo: Repo,
  remote: Remote,
  start: string | null,
  branch: string,
): string | null {
  const fromShared =
    start !== null &&
    start !== branch &&
    start !== repo.defaultBranch &&
    SHARED_BRANCHES.has(start) &&
    repo.refs.has(`refs/remotes/${remote.name}/${start}`)
  return fromShared ? start : repo.defaultBranch
}

// Opening the pull request

/** Hosts whose pull request links the sheet opens without a click (ship-sheet.tsx). */
const AUTO_OPEN_HOSTS = new Set(['github.com', 'gitlab.com'])

/** For a remote on github.com only. */
async function createWithGh(
  repo: Repo,
  remote: Remote,
  branch: string,
  base: string | null,
  title: string,
  body: string,
): Promise<string | null> {
  const gh = (args: string[]) =>
    run('gh', args, { cwd: repo.top, env: repo.env, timeout: GH_TIMEOUT })

  try {
    await gh(['auth', 'status', '--hostname', 'github.com'])
  } catch {
    return null // Not installed or not signed in: finish on the website instead.
  }
  const args = ['pr', 'create', '--repo', remote.repo, '--head', branch, '--title', title]
  args.push('--body', body)
  if (base) args.push('--base', base)
  try {
    return lastUrl((await gh(args)).stdout)
  } catch (error) {
    // Already open for this branch: gh names it in the error.
    const named =
      error instanceof CommandError ? /https?:\/\/\S+\/pull\/\d+/.exec(error.output) : null
    if (named) return named[0]
  }
  try {
    const open = 'select(.state == "OPEN") | .url'
    const { stdout } = await gh([
      'pr',
      'view',
      '--repo',
      remote.repo,
      '--json',
      'url,state',
      '--jq',
      open,
      '--',
      branch,
    ])
    return lastUrl(stdout)
  } catch {
    return null
  }
}

/**
 * The host's "new pull request" page, prefilled; null for hosts Gui can't link. Pages
 * on a self-hosted GitHub or GitLab are linked but, unlike github.com and gitlab.com,
 * not opened without a click.
 */
function newPullRequestUrl(
  remote: Remote,
  branch: string,
  base: string | null,
  title: string,
  body: string,
): string | null {
  if (!remote.web || remote.host === 'other') return null
  const ref = (name: string) => encodeURIComponent(name).replace(/%2F/g, '/')
  const description = cap(body, 4000)
  if (remote.host === 'github') {
    const query = new URLSearchParams({ expand: '1', title, body: description })
    const page = base ? `compare/${ref(base)}...${ref(branch)}` : `pull/new/${ref(branch)}`
    return `https://${remote.web}/${remote.repo}/${page}?${query}`
  }
  const query = new URLSearchParams({
    'merge_request[source_branch]': branch,
    'merge_request[title]': title,
    'merge_request[description]': description,
  })
  if (base) query.set('merge_request[target_branch]', base)
  return `https://${remote.web}/${remote.repo}/-/merge_requests/new?${query}`
}

/**
 * Hosts like Bitbucket and Gitea print a "create a pull request" link when pushing. The
 * sheet shows it with its host rather than opening it; a link to github.com or
 * gitlab.com, which it would open, can't be the pushed-to host's own and is dropped.
 */
function pushHintUrl(output: string): string | null {
  for (const line of output.split('\n')) {
    if (!line.startsWith('remote:') || !/pull|merge/i.test(line)) continue
    const url = /https?:\/\/\S+/.exec(line)?.[0]
    if (url && !AUTO_OPEN_HOSTS.has(hostnameOf(url))) return url
  }
  return null
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function lastUrl(text: string): string | null {
  return text.match(/https?:\/\/\S+/g)?.at(-1) ?? null
}

// Errors in plain language

function readError(error: unknown): string {
  if (!(error instanceof CommandError))
    return error instanceof Error ? error.message : String(error)
  if (error.missing || /xcrun: error|xcode-select/i.test(error.output)) return GIT_MISSING
  if (/not a git repository|must be run in a work tree/i.test(error.output)) return NOT_A_REPO
  if (/dubious ownership/i.test(error.output)) {
    return 'Git won’t work in this folder because another user on this Mac owns it.'
  }
  return `Couldn’t read the project’s Git status: ${tail(error.output, 3)}`
}

async function commitError(repo: Repo, error: unknown): Promise<string> {
  if (!(error instanceof CommandError))
    return error instanceof Error ? error.message : String(error)
  const output = error.output
  if (error.missing) return GIT_MISSING
  if (error.timedOut) {
    return 'Saving the commit took too long, so Gui stopped it. A check that runs before each commit may be stuck.'
  }
  if (
    /Author identity unknown|Committer identity unknown|tell me who you are|unable to auto-detect email|empty ident name/i.test(
      output,
    )
  ) {
    return 'Git needs your name and email before it can commit. Add them in GitHub Desktop (Settings → Git), or run `git config --global user.name "Your Name"` and `git config --global user.email you@example.com`, then try again.'
  }
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

async function pushError(repo: Repo, remote: Remote, branch: string, error: unknown) {
  if (!(error instanceof CommandError))
    return error instanceof Error ? error.message : String(error)
  const output = error.output
  const where = hostLabel(remote)
  if (error.timedOut) {
    return `Couldn’t push: ${where} didn’t answer in time. Check your connection and try again.`
  }
  if (
    /Permission to .+ denied to|Write access to repository not granted|not allowed to push|You are not allowed to push/i.test(
      output,
    )
  ) {
    return `Couldn’t push: your ${where} account doesn’t have permission to change ${remote.repo}.`
  }
  if (
    /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(|Host key verification failed|returned error: 40[13]|Invalid username or password|HTTP Basic: Access denied|Repository not found|could not be found or you don't have permission/i.test(
      output,
    )
  ) {
    return remote.host === 'github'
      ? 'Couldn’t push: Gui couldn’t sign in to GitHub. Sign in with GitHub Desktop or `gh auth login`, then try again.'
      : `Couldn’t push: Gui couldn’t sign in to ${where}. Check that you can push from your Git app, then try again.`
  }
  if (/\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i.test(output)) {
    return `Couldn’t push: \`${branch}\` on ${where} has changes that aren’t on this computer. Use a different branch name and try again.`
  }
  if (/\[remote rejected\]|pre-receive hook declined|GH0\d\d|protected branch/i.test(output)) {
    const said = tail(
      output
        .split('\n')
        .filter((line) => line.startsWith('remote:'))
        .join('\n') || output,
    )
    return `Couldn’t push: ${where} turned it down:\n${said}`
  }
  if (
    /Could not resolve host|Failed to connect|Connection (timed out|refused|reset)|Network is unreachable|Operation timed out|Couldn't connect to server|unable to access/i.test(
      output,
    )
  ) {
    return `Couldn’t reach ${where}. Check your internet connection and try again.`
  }
  if (await hasHook(repo, ['pre-push']))
    return `A check in this project stopped the push:\n${tail(output)}`
  return `Couldn’t push:\n${tail(output)}`
}

function hostLabel(remote: Remote): string {
  if (remote.host === 'github') return 'GitHub'
  if (remote.host === 'gitlab') return 'GitLab'
  return remote.web ?? 'the remote'
}

async function hasHook(repo: Repo, names: string[]): Promise<boolean> {
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
function tail(output: string, lines = 12): string {
  const kept = output
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !line.startsWith('hint:'))
  const text = kept.slice(-lines).join('\n')
  return text.length > 1200 ? `…${text.slice(-1200)}` : text || 'Git gave no details.'
}

// Running commands

class CommandError extends Error {
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

function run(file: string, args: string[], options: RunOptions) {
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

function runGit(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  options?: Partial<RunOptions>,
) {
  return run('git', ['--literal-pathspecs', ...args], { cwd, env, ...options }).then(
    (result) => result.stdout,
  )
}

/** Reads, and writes that run no hooks; see SAFE_READ. */
function git(at: At, args: string[], options?: Partial<RunOptions>): Promise<string> {
  return runGit(at.top, at.env, [...SAFE_READ, ...args], options)
}

/** What the user asked for runs as it would in Terminal: hooks, fsmonitor and all. */
function gitAsUser(at: At, args: string[], options?: Partial<RunOptions>): Promise<string> {
  return runGit(at.top, at.env, args, options)
}

/** Trimmed stdout, or null when the command fails (e.g. `symbolic-ref` on a detached HEAD). */
async function gitOrNull(at: At, args: string[]): Promise<string | null> {
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
