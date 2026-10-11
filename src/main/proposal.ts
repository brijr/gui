import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Proposal, ProposalPull, ReviewComment } from '../shared/types'
import {
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
  type Repo,
  readError,
  run,
  tail,
} from './git'
import { connectedGitHub, fetchGitHub, readGitHub } from './github'

/**
 * Where the project's work stands as a pull request, and the moves around it a designer
 * needs without knowing Git: start the next idea from the latest, bring the latest in,
 * and finish (or cancel) that when it stops on conflicts. Shipping itself is ship.ts.
 */

/** Fetching is the slow part of a status read; at most this often per repository. */
const FETCH_EVERY = 2 * 60_000
const fetchedAt = new Map<string, number>()

const CONFLICT_MARKER = /^(<{7}|>{7})( |$)/m

export async function readProposal(root: string, refresh = false): Promise<Proposal> {
  const repo = await openRepo(root).catch((error) => {
    throw new Error(readError(error))
  })
  const connected = await connectedFor(repo)
  if (refresh) await fetchDefault(repo, connected).catch(() => undefined)
  const [behind, ahead, merge, pull] = await Promise.all([
    behindLatest(repo),
    aheadOfShared(repo),
    mergeState(repo),
    repo.branch && repo.branch !== repo.defaultBranch
      ? findPull(repo, connected, repo.branch).catch(() => null)
      : null,
  ])
  return {
    branch: repo.branch,
    defaultBranch: repo.defaultBranch,
    onDefaultBranch: repo.branch !== null && repo.branch === repo.defaultBranch,
    changes: repo.changes.length,
    ahead,
    behind,
    merge,
    pull,
  }
}

/**
 * The next idea starts from the latest: switch to the default branch and catch it up.
 * Uncommitted work would come along into the new idea, so it has to be shared (or undone) first.
 */
export async function startFresh(root: string): Promise<void> {
  const repo = await openRepo(root)
  if (repo.problem) throw new Error(repo.problem)
  const main = repo.defaultBranch
  if (!main || !isSafeName(main)) throw new Error('Gui couldn’t tell which branch is the latest.')
  if (repo.changes.length > 0) {
    throw new Error(
      'Some changes aren’t in a pull request yet. Update your pull request first, or undo them, then start something new.',
    )
  }
  const connected = await connectedFor(repo)
  await fetchDefault(repo, connected, true)
  if (repo.branch !== main) {
    try {
      await gitAsUser(repo, ['switch', main])
    } catch (error) {
      throw new Error(`Couldn’t switch to ${main}:\n${tailOf(error)}`)
    }
  }
  const tracking = repo.remote && `refs/remotes/${repo.remote.name}/${main}`
  if (!tracking || !(await gitOrNull(repo, ['rev-parse', '--verify', '--quiet', tracking]))) return
  try {
    await gitAsUser(repo, ['merge', '--ff-only', tracking], { timeout: HOOK_TIMEOUT })
  } catch {
    throw new Error(
      `Your copy of ${main} has commits of its own, so Gui left it as it is. You’re on ${main}; new changes will go into a new pull request.`,
    )
  }
}

/**
 * Merges the remote's default branch into this one. Stopping on conflicts is a result,
 * not an error: the merge stays in progress for the agent to resolve (see `merge`).
 */
export async function bringInLatest(root: string): Promise<void> {
  const repo = await openRepo(root)
  if (repo.problem) throw new Error(repo.problem)
  const main = repo.defaultBranch
  if (!repo.remote || !main || !isSafeName(main))
    throw new Error('There’s no shared copy of this project to bring changes in from.')
  const connected = await connectedFor(repo)
  await fetchDefault(repo, connected, true)
  if (connected) await applyConnectedIdentity(repo, connected.profile)
  const tracking = `refs/remotes/${repo.remote.name}/${main}`
  try {
    await gitAsUser(repo, ['merge', '--no-edit', tracking], { timeout: HOOK_TIMEOUT })
  } catch (error) {
    if (await mergeState(repo)) return
    const output = error instanceof CommandError ? error.output : ''
    if (/local changes .* would be overwritten|untracked working tree files/i.test(output)) {
      throw new Error(
        'Your unshared changes touch the same files as the latest. Update your pull request first, then bring in the latest.',
      )
    }
    throw new Error(`Couldn’t bring in the latest:\n${tailOf(error)}`)
  }
}

/** Commits the merge once no conflicted file still has markers in it. */
export async function finishMerge(root: string): Promise<void> {
  const repo = await openRepo(root).catch((error) => {
    throw new Error(readError(error))
  })
  const merge = await mergeState(repo)
  if (!merge) return
  if (merge.marked.length > 0) {
    throw new Error(`These files still have conflicts: ${merge.marked.join(', ')}`)
  }
  const connected = await connectedFor(repo)
  if (connected) await applyConnectedIdentity(repo, connected.profile)
  await git(repo, ['add', '--', ...merge.files])
  try {
    await gitAsUser(repo, ['commit', '--no-edit'], { timeout: HOOK_TIMEOUT })
  } catch (error) {
    throw new Error(await commitError(repo, error))
  }
}

export async function cancelMerge(root: string): Promise<void> {
  const repo = await openRepo(root).catch((error) => {
    throw new Error(readError(error))
  })
  try {
    await gitAsUser(repo, ['merge', '--abort'])
  } catch (error) {
    throw new Error(`Couldn’t cancel:\n${tailOf(error)}`)
  }
}

/** How Gui's own conflict message starts, so it never becomes a commit or PR title. */
export const CONFLICT_PROMPT_START = 'I brought in the latest changes from'

/** What the agent is asked when bringing in the latest stopped on conflicts. */
export function conflictPrompt(merge: NonNullable<Proposal['merge']>, main: string): string {
  const files = merge.files.map((file) => `- ${file}`).join('\n')
  return `${CONFLICT_PROMPT_START} ${main}, and some files conflict with the work here:

${files}

Resolve every conflict in those files: remove the <<<<<<<, ======= and >>>>>>> markers and keep what both sides meant, the latest from ${main} together with the changes made here. Don't run git commands; Gui finishes the merge once the markers are gone.`
}

// Reading

async function connectedFor(repo: Repo) {
  const remote = repo.remote
  if (remote?.host !== 'github' || remote.web !== 'github.com') return null
  return connectedGitHub(remote.repo).catch(() => null)
}

async function fetchDefault(
  repo: Repo,
  connected: Awaited<ReturnType<typeof connectedFor>>,
  force = false,
) {
  const remote = repo.remote
  const main = repo.defaultBranch
  if (!remote || !main || !isSafeName(main)) return
  const last = fetchedAt.get(repo.top) ?? 0
  if (!force && Date.now() - last < FETCH_EVERY) return
  fetchedAt.set(repo.top, Date.now())
  try {
    if (connected) {
      await fetchGitHub(connected.repository.id, remote.repo, repo.top, remote.name, main)
    } else {
      const env = { ...repo.env }
      // Never wait on an ssh passphrase or host-key prompt nobody can see (as push does).
      if (!env.GIT_SSH_COMMAND && !env.GIT_SSH) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
      await git({ top: repo.top, env }, ['fetch', '--no-tags', '--', remote.name, main], {
        timeout: GH_TIMEOUT,
      })
    }
  } catch (error) {
    if (force) throw new Error(`Couldn’t get the latest from ${hostOf(repo)}:\n${tailOf(error)}`)
  }
}

async function behindLatest(repo: Repo): Promise<number | null> {
  if (!repo.remote || !repo.defaultBranch || !repo.hasHead) return null
  const tracking = `refs/remotes/${repo.remote.name}/${repo.defaultBranch}`
  const count = await gitOrNull(repo, ['rev-list', '--count', `HEAD..${tracking}`, '--'])
  return count === null ? null : Number(count)
}

async function aheadOfShared(repo: Repo): Promise<number> {
  if (!repo.remote || !repo.branch || !repo.hasHead) return 0
  const tracking = `refs/remotes/${repo.remote.name}/${repo.branch}`
  const shared = repo.defaultBranch && `refs/remotes/${repo.remote.name}/${repo.defaultBranch}`
  // A local commit on a newly created branch has no upstream yet. Compare with the
  // shared branch so it stays visible until the first push sets up tracking.
  const base = repo.refs.has(tracking) ? tracking : shared && repo.refs.has(shared) ? shared : null
  const count = await gitOrNull(repo, [
    'rev-list',
    '--count',
    base ? `${base}..HEAD` : 'HEAD',
    '--',
  ])
  return Number(count) || 0
}

async function mergeState(repo: Repo): Promise<Proposal['merge']> {
  const head = await gitOrNull(repo, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])
  if (!head) return null
  const out = await gitOrNull(repo, ['diff', '--name-only', '-z', '--diff-filter=U'])
  const files = (out ?? '').split('\0').filter(Boolean)
  const marked: string[] = []
  for (const file of files) {
    const text = await readFile(join(repo.top, file), 'utf8').catch(() => null)
    if (text !== null && CONFLICT_MARKER.test(text)) marked.push(file)
  }
  return { files, marked }
}

// The pull request, on github.com: through the connection, else the user's gh

interface ApiPull {
  number: number
  title: string
  html_url: string
  state: 'open' | 'closed'
  draft?: boolean
  merged_at: string | null
  user: { login: string } | null
}
interface ApiUser {
  login: string
  type?: string
}
interface ApiReview {
  id: number
  user: ApiUser | null
  body: string | null
  state: string
  html_url: string
  submitted_at: string | null
}
interface ApiComment {
  id: number
  user: ApiUser | null
  body: string
  html_url: string
  created_at: string
  path?: string
  line?: number | null
  original_line?: number | null
}

async function findPull(
  repo: Repo,
  connected: Awaited<ReturnType<typeof connectedFor>>,
  branch: string,
): Promise<ProposalPull | null> {
  const remote = repo.remote
  if (remote?.host !== 'github' || remote.web !== 'github.com') return null
  const read = connected
    ? <T>(path: string) => readGitHub<T>(connected.repository.id, remote.repo, path)
    : <T>(path: string) => readWithGh<T>(repo, remote.repo, path)
  const owner = remote.repo.split('/')[0]
  const query = new URLSearchParams({ state: 'all', head: `${owner}:${branch}`, per_page: '5' })
  const pulls = await read<ApiPull[]>(`/pulls?${query}`)
  const pull = pulls[0]
  if (!pull) return null
  const n = pull.number
  const [reviews, codeComments, comments] = await Promise.all([
    read<ApiReview[]>(`/pulls/${n}/reviews?per_page=100`),
    read<ApiComment[]>(`/pulls/${n}/comments?per_page=100`),
    read<ApiComment[]>(`/issues/${n}/comments?per_page=100`),
  ])
  // People only: preview deploy and CI bots post status, not feedback.
  const byReviewer = (user: ApiUser | null) =>
    !!user && user.type !== 'Bot' && !user.login.endsWith('[bot]')

  // Each reviewer's latest approving or blocking review is their verdict.
  const verdicts = new Map<string, string>()
  for (const review of reviews) {
    if (review.user && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state))
      verdicts.set(review.user.login, review.state)
  }
  const states = [...verdicts.values()]
  const review = states.includes('CHANGES_REQUESTED')
    ? 'changes'
    : states.includes('APPROVED')
      ? 'approved'
      : null

  const all: ReviewComment[] = [
    ...reviews
      .filter((item) => byReviewer(item.user) && item.body?.trim())
      .map((item) => ({
        id: `review-${item.id}`,
        author: item.user?.login ?? '',
        body: item.body?.trim() ?? '',
        path: null,
        line: null,
        url: item.html_url,
        createdAt: item.submitted_at ?? '',
      })),
    ...codeComments.filter((item) => byReviewer(item.user)).map((item) => toComment('code', item)),
    ...comments.filter((item) => byReviewer(item.user)).map((item) => toComment('issue', item)),
  ]
  all.sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  return {
    number: n,
    title: pull.title,
    url: pull.html_url,
    state: pull.merged_at
      ? 'merged'
      : pull.state === 'closed'
        ? 'closed'
        : pull.draft
          ? 'draft'
          : 'open',
    review,
    comments: all,
  }
}

function toComment(kind: 'code' | 'issue', item: ApiComment): ReviewComment {
  return {
    id: `${kind}-${item.id}`,
    author: item.user?.login ?? '',
    body: item.body.trim(),
    path: item.path ?? null,
    line: item.line ?? item.original_line ?? null,
    url: item.html_url,
    createdAt: item.created_at,
  }
}

async function readWithGh<T>(repo: Repo, fullName: string, path: string): Promise<T> {
  const { stdout } = await run(
    'gh',
    ['api', '--hostname', 'github.com', `repos/${fullName}${path}`],
    {
      cwd: repo.top,
      env: repo.env,
      timeout: GH_TIMEOUT,
    },
  )
  return JSON.parse(stdout) as T
}

function hostOf(repo: Repo) {
  return repo.remote?.web ?? 'the remote'
}

function tailOf(error: unknown) {
  return error instanceof CommandError
    ? tail(error.output, 4)
    : error instanceof Error
      ? error.message
      : String(error)
}
