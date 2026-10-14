import {
  applyConnectedIdentity,
  type Change,
  CommandError,
  commitError,
  GH_TIMEOUT,
  git,
  gitAsUser,
  gitOrNull,
  HOOK_TIMEOUT,
  hasHook,
  isSafeName,
  openRepo,
  outgoingCount,
  parseRemoteUrl,
  pushDestination,
  type Remote,
  type Repo,
  readChanges,
  readError,
  readWorkspace,
  run,
  tail,
  withGitMutation,
} from './git'
import { findLeak, leakMessage, localEnvValues, secretIn } from './ship-secrets'

export {
  type At,
  applyConnectedIdentity,
  CommandError,
  commitError,
  GH_TIMEOUT,
  git,
  gitAsUser,
  gitOrNull,
  HOOK_TIMEOUT,
  isSafeName,
  openRepo,
  parseRemoteUrl,
  type Remote,
  type Repo,
  readChanges,
  readError,
  run,
  tail,
} from './git'

import type { ShipFile, ShipInfo, ShipRequest, ShipResult } from '../shared/types'
import { CredentialUnavailable, connectedGitHub, pullGitHub, pushGitHub } from './github'

/**
 * Turning the project's uncommitted changes into a pull request: what would be
 * committed, then commit, push, and open the PR. Runs the user's own git (and gh,
 * when it's signed in) with their shell environment, never interactively.
 */

const NOTHING_TO_SHIP = 'No changes to share yet.'

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

export async function shipInfo(root: string, prompts: string[]): Promise<ShipInfo> {
  let repo: Repo
  try {
    repo = await openRepo(root)
  } catch (error) {
    return blockedInfo(readError(error))
  }

  const files = repo.changes.map((change) => change.file)
  const newBranch = startsNewBranch(repo)
  const workspace = await readWorkspace(repo)
  const pendingCommits = workspace.ahead > 0

  const fresh = await unshippedPrompts(repo, prompts)
  const cleaned = fresh.map(cleanPrompt).filter(Boolean)
  const title = cleaned[0]
    ? cap(cleaned[0], 72)
    : files.length > 0
      ? filesTitle(files)
      : ((await gitOrNull(repo, ['log', '-1', '--format=%s'])) ?? 'Update')
  const branch =
    (newBranch && (files.length > 0 || !pendingCommits)) || repo.branch === null
      ? uniqueBranch(`gui/${slugify(title)}`, repo)
      : repo.branch

  return {
    blocked: null,
    workspace,
    branch: repo.branch,
    onDefaultBranch: repo.branch !== null && repo.branch === repo.defaultBranch,
    pendingCommits,
    files,
    skipped: repo.skipped,
    remote: repo.remote && { host: repo.remote.host, repo: repo.remote.repo },
    suggestion: { branch, title, body: bulletList(cleaned, title) },
  }
}

export async function ship(
  root: string,
  request: ShipRequest,
  actions?: ShipActions,
): Promise<ShipResult> {
  return withGitMutation(root, () => shipUnlocked(root, request, actions))
}

async function shipUnlocked(
  root: string,
  request: ShipRequest,
  actions?: ShipActions,
): Promise<ShipResult> {
  let repo: Repo
  try {
    repo = await openRepo(root)
  } catch (error) {
    throw new Error(readError(error))
  }
  if (repo.problem) throw new Error(repo.problem)
  actions?.assertAvailable()
  if (request.mode === 'commit' && repo.changes.length === 0) {
    throw new Error('No changes to commit. Choose Share for review to push saved commits.')
  }
  // Validate the selection before switching branches or changing the index.
  const pushOnly =
    request.mode !== 'commit' &&
    request.branch.trim() === repo.branch &&
    (await aheadOfRemote(repo, request.branch.trim()))
  selectChanges(repo.changes, request.files, pushOnly)

  const connected =
    repo.remote?.host === 'github' && repo.remote.web === 'github.com'
      ? // Gui accounts being down mustn't stop a push the user's own git or gh can make.
        await connectedGitHub(repo.remote.repo).catch((error: unknown) => {
          console.error('[gui] GitHub connection unavailable; pushing without it', error)
          return null
        })
      : null
  if (connected) await applyConnectedIdentity(repo, connected.profile)

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
  const undo = () => (switched ? undoSwitch(repo, branch, switched, start, startCommit) : null)
  let changes: Change[]
  try {
    changes = selectChanges(status.changes, request.files, pushOnly)
  } catch (error) {
    await undo()
    throw error
  }
  const { stagedSecrets } = status

  if (changes.length > 0) {
    const leak = await findLeak(repo, changes, env)
    if (leak) {
      await undo()
      throw new Error(leak)
    }
    await unstage(repo, stagedSecrets)
    try {
      actions?.assertAvailable()
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
  if (!remote || request.mode === 'commit')
    return { branch, commit, outcome: 'committed', url: null }

  const base = pullRequestBase(repo, remote, start, branch)
  const current = await openRepo(root)
  const output = await pushSavedCommits(current, branch, branch, actions)
  return openPullRequest(current, branch, base, title, body, output)
}

export async function connectedFor(repo: Repo) {
  return repo.remote?.host === 'github' && repo.remote.web === 'github.com'
    ? connectedGitHub(repo.remote.repo).catch(() => null)
    : null
}

export interface PushWarning {
  remote: string
  branch: string
  count: number
}

export interface ShipActions {
  assertAvailable(): void
  confirmPush(warning: PushWarning): Promise<'push' | 'cancel' | 'branch'>
}

export class PushCancelled extends Error {
  constructor(readonly choice: 'cancel' | 'branch') {
    super(choice === 'branch' ? 'Create a branch before pushing.' : 'Push cancelled.')
  }
}

export function isSharedBranch(branch: string, defaultBranch: string | null) {
  return branch === 'main' || branch === 'master' || branch === defaultBranch
}

/** One gate for legacy Share, independent Push, and connected-account pushes. */
export async function pushSavedCommits(
  repo: Repo,
  branch: string,
  destination: string,
  actions?: ShipActions,
) {
  const remote = repo.remote
  if (!remote) throw new Error('This project has no remote configured.')
  if (!repo.head) throw new Error('There are no saved commits to push.')
  await assertBranchName(repo, destination)
  const snapshot = async () => {
    const fresh = await openRepo(repo.top)
    const urls = await git(fresh, ['remote', 'get-url', '--push', '--all', '--', remote.name])
    const tracking = await pushDestination(fresh, branch)
    return {
      fresh,
      urls,
      key: JSON.stringify([
        fresh.branch,
        fresh.head,
        fresh.defaultBranch,
        fresh.remote,
        urls,
        tracking,
      ]),
    }
  }
  const before = await snapshot()
  if (before.fresh.branch !== branch || before.fresh.head !== repo.head)
    throw new Error('The branch changed. Refresh Source control before pushing.')
  const connected = await connectedFor(repo)
  if (isSharedBranch(destination, repo.defaultBranch)) {
    if (!actions) throw new Error('Pushing to the shared branch requires confirmation in Gui.')
    const count = await outgoingCount(repo, { remote: remote.name, branch: destination })
    const choice = await actions.confirmPush({ remote: remote.name, branch: destination, count })
    if (choice !== 'push') throw new PushCancelled(choice)
  }
  const after = await snapshot()
  if (before.key !== after.key)
    throw new Error('The repository changed while preparing the push. Refresh and confirm again.')
  actions?.assertAvailable()
  const matchingUrls = after.urls
    .trim()
    .split('\n')
    .every((url) => {
      const target = parseRemoteUrl(url)
      return (
        target.host === 'github' &&
        target.web === remote.web &&
        target.repo.toLowerCase() === remote.repo.toLowerCase()
      )
    })
  try {
    const pushedConnected =
      connected &&
      matchingUrls &&
      branch === destination &&
      (await pushGitHub(connected.repository.id, remote.repo, repo.top, branch, repo.head).then(
        () => true,
        (error: unknown) => {
          if (error instanceof CredentialUnavailable) return false
          throw error
        },
      ))
    if (pushedConnected) {
      await gitAsUser(repo, ['update-ref', `refs/remotes/${remote.name}/${branch}`, repo.head])
      await gitAsUser(repo, ['branch', `--set-upstream-to=${remote.name}/${branch}`, '--', branch])
      return ''
    }
    const output = await push(repo, remote, branch, destination)
    await gitAsUser(repo, [
      'branch',
      `--set-upstream-to=${remote.name}/${destination}`,
      '--',
      branch,
    ])
    return output
  } catch (error) {
    throw new Error(await pushError(repo, remote, destination, error))
  }
}

export async function openPullRequest(
  repo: Repo,
  branch: string,
  base: string | null,
  title: string,
  body: string,
  pushOutput = '',
): Promise<ShipResult> {
  const remote = repo.remote
  if (!remote) throw new Error('This project has no remote configured.')
  const commit = repo.head?.slice(0, 8) ?? ''
  const connected = await connectedFor(repo)
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

/** Takes secret files back out of the index, so the user's next commit leaves them out too. */
export async function unstage(repo: Repo, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  // Before the first commit there's no HEAD to restore from; dropping them is the same.
  const args = repo.hasHead
    ? ['restore', '--staged', '--', ...paths]
    : ['rm', '--cached', '--quiet', '-f', '--', ...paths]
  // Best effort: `commit --only` keeps them out of Gui's commit either way.
  await git(repo, args).catch(() => undefined)
}

// Branch, commit, push

export async function assertBranchName(repo: Repo, branch: string): Promise<void> {
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

export function selectChanges(
  changes: Change[],
  files: string[] | undefined,
  allowEmpty = false,
): Change[] {
  if (files === undefined) return changes
  if (files.length === 0 && !allowEmpty) throw new Error('Choose at least one file to commit.')
  const paths = new Set(files)
  const selected = changes.filter((change) => paths.has(change.file.path))
  if (selected.length !== paths.size) {
    throw new Error(
      'The selected files changed. Reopen Source control to review the current files.',
    )
  }
  return selected
}

export async function commitChanges(repo: Repo, changes: Change[], title: string, body: string) {
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

async function push(
  repo: Repo,
  remote: Remote,
  branch: string,
  destination = branch,
): Promise<string> {
  const env = { ...repo.env }
  // Never wait on an ssh passphrase or host-key prompt nobody can see. A user's own
  // GIT_SSH_COMMAND or core.sshCommand is how they push from Terminal, so it's kept.
  if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) {
    const configured = await gitOrNull(repo, ['config', '--get', 'core.sshCommand'])
    if (!configured) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  }
  const ref = repo.head ?? `refs/heads/${branch}`
  const { stdout, stderr } = await run(
    'git',
    ['push', '--no-follow-tags', '--', remote.name, `${ref}:refs/heads/${destination}`],
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
