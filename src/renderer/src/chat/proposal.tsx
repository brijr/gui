import { type ReactNode, useEffect } from 'react'
import { create } from 'zustand'
import type { Proposal, ProposalPull, ReviewComment } from '../../../shared/types'
import { gui } from '../lib/api'
import { readableError } from '../lib/errors'
import {
  ArrowLeft,
  Check,
  CircleDot,
  ExternalLink,
  GitPullRequest,
  MessageSquare,
  RotateCw,
  SquarePen,
  TriangleAlert,
} from '../lib/icons'
import { Badge } from '../lib/status'
import { Banner, Message, PanelHeader } from '../lib/surface'
import { timeAgo } from '../lib/time'
import { Button, IconButton, TextButton } from '../lib/ui'
import { Markdown } from './markdown'
import { toggleShipSheet, useShipSheet } from './ship-sheet'
import { useChat } from './store'

/**
 * The bar over the chat that says where the work stands on its way into the shared project,
 * in a designer's words: not shared yet, in review, changes requested, merged. It offers the
 * one next move (share, review the comments, bring in the latest, start something new), and
 * the review sheet turns each reviewer comment into a message for the agent.
 */

type Action = 'fresh' | 'bringIn' | 'finish' | 'cancel' | 'resolve'

interface ProposalStore {
  proposal: Proposal | null
  busy: Action | null
  error: string | null
  /** The review sheet has taken over the transcript */
  reviewing: boolean
  /** Comments the user has sent to the agent or put aside, by pull request URL */
  handled: Record<string, string[]>
}

const HANDLED_KEY = 'gui.reviewHandled'

function loadHandled(): Record<string, string[]> {
  try {
    const value = JSON.parse(localStorage.getItem(HANDLED_KEY) ?? '{}')
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

export const useProposal = create<ProposalStore>(() => ({
  proposal: null,
  busy: null,
  error: null,
  reviewing: false,
  handled: loadHandled(),
}))

/** Bumped per read, so a slow one can't overwrite a newer answer. */
let reads = 0

export async function refreshProposal(fromRemote = false) {
  const current = ++reads
  const proposal = await gui.getProposal(fromRemote).catch(() => null)
  if (current === reads) useProposal.setState({ proposal })
}

async function act(action: Action, run: () => Promise<void>) {
  if (useProposal.getState().busy) return
  useProposal.setState({ busy: action, error: null })
  try {
    await run()
  } catch (error) {
    useProposal.setState({ error: readableError(error) })
  } finally {
    useProposal.setState({ busy: null })
    await refreshProposal()
  }
}

function markHandled(pull: ProposalPull, ids: string[]) {
  useProposal.setState(({ handled }) => {
    const next = {
      ...handled,
      [pull.url]: [...new Set([...(handled[pull.url] ?? []), ...ids])],
    }
    try {
      localStorage.setItem(HANDLED_KEY, JSON.stringify(next))
    } catch {
      // Remembering is a convenience; the comments just show again next time.
    }
    return { handled: next }
  })
}

function openReview(open: boolean) {
  useProposal.setState({ reviewing: open, error: null })
}

/** The comments not sent to the agent or put aside yet. */
export function useOpenComments(): ReviewComment[] {
  const pull = useProposal((s) => s.proposal?.pull ?? null)
  const handled = useProposal((s) => (pull ? s.handled[pull.url] : undefined))
  if (!pull || pull.state === 'merged' || pull.state === 'closed') return []
  return pull.comments.filter((comment) => !handled?.includes(comment.id))
}

/**
 * Keeps the bar current: on open, every minute (main fetches at most every two), when the
 * window comes back, when the agent finishes a turn, and when the PR sheet closes.
 */
export function useProposalUpdates() {
  useEffect(() => {
    void refreshProposal(true)
    const timer = setInterval(() => void refreshProposal(true), 60_000)
    const onFocus = () => void refreshProposal(true)
    window.addEventListener('focus', onFocus)
    const offTurns = useChat.subscribe((chat, before) => {
      const running = chat.turns.some((turn) => turn.status === 'running')
      const was = before.turns.some((turn) => turn.status === 'running')
      if (was && !running) void refreshProposal()
    })
    const offSheet = useShipSheet.subscribe((sheet, before) => {
      if (before.open && !sheet.open) void refreshProposal()
    })
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      offTurns()
      offSheet()
    }
  }, [])
}

const STATE_BADGE: Record<
  ProposalPull['state'],
  { label: string; tone: 'neutral' | 'accent' | 'success' | 'danger' }
> = {
  draft: { label: 'Draft', tone: 'neutral' },
  open: { label: 'In review', tone: 'accent' },
  merged: { label: 'Merged', tone: 'success' },
  closed: { label: 'Closed', tone: 'neutral' },
}

function pullBadge(pull: ProposalPull) {
  if (pull.state === 'open' && pull.review === 'changes')
    return <Badge tone="warning">Changes requested</Badge>
  if (pull.state === 'open' && pull.review === 'approved')
    return <Badge tone="success">Approved</Badge>
  const { label, tone } = STATE_BADGE[pull.state]
  return <Badge tone={tone}>{label}</Badge>
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`
}

/** The chat window hands window.open to the system browser. */
function openExternal(url: string) {
  if (/^https:\/\//.test(url)) window.open(url, '_blank', 'noopener')
}

/** One line over the transcript; absent when there's nothing to say (no repo, nothing changed). */
export function ProposalBar() {
  const proposal = useProposal((s) => s.proposal)
  const busy = useProposal((s) => s.busy)
  const error = useProposal((s) => s.error)
  const comments = useOpenComments()
  const agentBusy = useChat((s) => s.turns.some((turn) => turn.status === 'running'))
  if (!proposal) return null

  const bar = barFor(proposal, comments.length, busy, agentBusy)
  return (
    <>
      {bar}
      {error && (
        <Banner
          tone="danger"
          icon={TriangleAlert}
          role="alert"
          className="h-auto min-h-9 py-1.5 [&>div]:whitespace-normal"
          actions={
            <TextButton tone="muted" onClick={() => useProposal.setState({ error: null })}>
              Dismiss
            </TextButton>
          }
        >
          {error}
        </Banner>
      )}
    </>
  )
}

function barFor(
  proposal: Proposal,
  openComments: number,
  busy: Action | null,
  agentBusy: boolean,
): ReactNode {
  const { pull, merge } = proposal
  const latest = proposal.defaultBranch ?? 'main'
  const disabled = busy !== null || agentBusy

  // Bringing in the latest stopped on conflicts: the agent resolves them, Gui finishes.
  if (merge) {
    const left = merge.marked.length
    return (
      <Banner
        tone="warning"
        icon={TriangleAlert}
        role="status"
        actions={
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              loading={busy === 'cancel'}
              onClick={() => void act('cancel', () => gui.cancelMerge())}
            >
              Cancel
            </Button>
            {left > 0 ? (
              <Button
                size="sm"
                variant="primary"
                disabled={disabled}
                loading={busy === 'resolve' || agentBusy}
                onClick={() => void act('resolve', () => gui.resolveConflicts())}
              >
                Ask agent to fix
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                disabled={disabled}
                loading={busy === 'finish'}
                onClick={() => void act('finish', () => gui.finishMerge())}
              >
                Finish
              </Button>
            )}
          </>
        }
      >
        <span className="truncate">
          {left > 0
            ? `${plural(left, 'file')} conflict with the latest ${latest}`
            : 'Conflicts fixed. Finish bringing in the latest.'}
        </span>
      </Banner>
    )
  }

  // Done with this one: the next idea starts from the latest, in a new chat.
  if (pull && (pull.state === 'merged' || pull.state === 'closed')) {
    return (
      <Banner
        icon={pull.state === 'merged' ? Check : GitPullRequest}
        role="status"
        actions={
          <Button
            size="sm"
            variant="primary"
            icon={SquarePen}
            disabled={disabled}
            loading={busy === 'fresh'}
            onClick={() => void act('fresh', () => gui.startFresh())}
          >
            Start something new
          </Button>
        }
      >
        <PullTitle pull={pull} />
        {pullBadge(pull)}
      </Banner>
    )
  }

  const behind = proposal.behind ?? 0
  const bringIn = (label: string) => (
    <Button
      size="sm"
      icon={RotateCw}
      disabled={disabled}
      loading={busy === 'bringIn'}
      title={`Bring the newest changes from ${latest} into this work`}
      onClick={() => void act('bringIn', () => gui.bringInLatest())}
    >
      {label}
    </Button>
  )

  if (pull) {
    const changes = proposal.changes
    return (
      <Banner
        icon={GitPullRequest}
        role="status"
        actions={
          <>
            {behind > 0 && bringIn('Bring in latest')}
            {openComments > 0 ? (
              <Button
                size="sm"
                variant="primary"
                icon={MessageSquare}
                onClick={() => openReview(true)}
              >
                {plural(openComments, 'comment')}
              </Button>
            ) : (
              changes > 0 && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={useShipSheet.getState().busy}
                  onClick={toggleShipSheet}
                >
                  Update
                </Button>
              )
            )}
          </>
        }
      >
        <PullTitle pull={pull} />
        {pullBadge(pull)}
      </Banner>
    )
  }

  // Not shared yet.
  if (proposal.changes > 0) {
    return (
      <Banner
        icon={CircleDot}
        role="status"
        actions={
          <>
            {behind > 0 && !proposal.onDefaultBranch && bringIn('Bring in latest')}
            <Button size="sm" variant="primary" onClick={toggleShipSheet}>
              Share for review
            </Button>
          </>
        }
      >
        <span className="truncate">{plural(proposal.changes, 'change')} not shared yet</span>
      </Banner>
    )
  }

  // Nothing of its own: the only news is that the latest moved on.
  if (behind > 0) {
    return (
      <Banner icon={RotateCw} role="status" actions={bringIn('Get latest')}>
        <span className="truncate">
          {plural(behind, 'new update')} on {latest}
        </span>
      </Banner>
    )
  }
  return null
}

function PullTitle({ pull }: { pull: ProposalPull }) {
  return (
    <button
      type="button"
      title={`Open #${pull.number} on GitHub`}
      onClick={() => openExternal(pull.url)}
      className="no-drag min-w-0 truncate text-fg hover:underline"
    >
      {pull.title}
    </button>
  )
}

/** Replaces the transcript and composer with the reviewers' comments, each one a fix away. */
export function ReviewSheet() {
  const pull = useProposal((s) => s.proposal?.pull ?? null)
  const comments = useOpenComments()
  const agentBusy = useChat((s) => s.turns.some((turn) => turn.status === 'running'))

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) openReview(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const fix = async (picked: ReviewComment[]) => {
    if (!pull || picked.length === 0) return
    const accepted = await gui.send(fixPrompt(pull, picked))
    if (!accepted) {
      useProposal.setState({ error: 'The agent couldn’t take this. Try again.' })
      return
    }
    markHandled(
      pull,
      picked.map((comment) => comment.id),
    )
    openReview(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title="Review comments"
        leading={
          <IconButton
            size="sm"
            label="Back to chat"
            icon={ArrowLeft}
            onClick={() => openReview(false)}
          />
        }
        actions={
          pull && (
            <IconButton
              size="sm"
              label="Open on GitHub"
              icon={ExternalLink}
              onClick={() => openExternal(pull.url)}
            />
          )
        }
      />
      {!pull || comments.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center px-8">
          <Message
            icon={<Check className="size-4" aria-hidden="true" />}
            tone="accent"
            title="All caught up"
            actions={<Button onClick={() => openReview(false)}>Back to chat</Button>}
          >
            Every comment has gone to the agent or been put aside.
          </Message>
        </div>
      ) : (
        <>
          <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto scroll-stable p-3">
            {comments.map((comment) => (
              <li
                key={comment.id}
                className="flex flex-col gap-2 rounded-lg border border-line p-3"
              >
                <div className="flex min-w-0 items-center gap-1.5 text-small">
                  <span className="font-medium">{comment.author}</span>
                  {comment.path && (
                    <Badge mono title={comment.path}>
                      <span className="truncate">
                        {comment.path.split('/').at(-1)}
                        {comment.line ? `:${comment.line}` : ''}
                      </span>
                    </Badge>
                  )}
                  <span className="ml-auto shrink-0 text-caption text-subtle">
                    {timeAgo(Date.parse(comment.createdAt))}
                  </span>
                </div>
                <div className="text-small">
                  <Markdown text={comment.body} />
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={agentBusy}
                    onClick={() => void fix([comment])}
                  >
                    Fix this
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => markHandled(pull, [comment.id])}>
                    Put aside
                  </Button>
                  <TextButton
                    tone="muted"
                    className="ml-auto text-caption"
                    onClick={() => openExternal(comment.url)}
                  >
                    Reply on GitHub
                  </TextButton>
                </div>
              </li>
            ))}
          </ul>
          {comments.length > 1 && (
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line p-2">
              <Button variant="primary" disabled={agentBusy} onClick={() => void fix(comments)}>
                Fix all {comments.length}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** The message the agent gets for one or more reviewer comments. Exported for tests. */
export function fixPrompt(pull: ProposalPull, comments: ReviewComment[]): string {
  const quoted = comments
    .map((comment) => {
      const where = comment.path
        ? ` on ${comment.path}${comment.line ? ` line ${comment.line}` : ''}`
        : ''
      const body = comment.body
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')
      return `@${comment.author}${where}:\n${body}`
    })
    .join('\n\n')
  const what = comments.length === 1 ? 'this review comment' : 'these review comments'
  return `Address ${what} on the pull request “${pull.title}”:

${quoted}

Make the changes asked for. If a comment is a question rather than a request, answer it here instead of changing code.`
}
