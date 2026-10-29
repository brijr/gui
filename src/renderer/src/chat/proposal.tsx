import { type ReactNode, useEffect, useRef, useState } from 'react'
import { fixPrompt } from '../../../shared/review'
import type { Proposal, ProposalPull, ReviewComment, ShipDraft } from '../../../shared/types'
import { gui } from '../lib/api'
import {
  ArrowLeft,
  Check,
  CircleDot,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  MessageSquare,
  RotateCw,
  Shield,
  SquarePen,
  Trash2,
  TriangleAlert,
} from '../lib/icons'
import { Badge } from '../lib/status'
import { Banner, Card, Message, PanelHeader } from '../lib/surface'
import { timeAgo } from '../lib/time'
import { Button, IconButton, TextButton } from '../lib/ui'
import { GitErrorAction } from './git-actions'
import { Markdown } from './markdown'
import {
  type Action,
  act,
  linkTarget,
  markHandled,
  openExternal,
  openReview,
  refreshProposal,
  type ShareDone,
  share,
  useProposal,
} from './proposal-state'
import { useShipSheet } from './shipping-state'
import { useVersions } from './versions-state'

export { refreshProposal, useProposal } from './proposal-state'

import { useChat } from './store'

/**
 * The bar over the chat that says where the work stands on its way into the shared project,
 * in a designer's words: not shared yet, in review, changes requested, merged. It offers the
 * one next move (share, review the comments, get the latest, start something new), and
 * the review sheet turns each reviewer comment into a message for the agent.
 */

/** The comments not sent to the agent or put aside yet. */
export function useOpenComments(): ReviewComment[] {
  const pull = useProposal((s) => s.proposal?.pull ?? null)
  const handled = useProposal((s) => (pull ? s.handled[pull.url] : undefined))
  if (!pull || pull.state === 'merged' || pull.state === 'closed') return []
  return pull.comments.filter((comment) => !handled?.includes(comment.id))
}

/**
 * Keeps the bar current: on open, every minute while its tab is in front (main fetches at most
 * every two), when the tab or the window comes back, when the agent finishes a turn, and when
 * the PR sheet closes. A tab behind another doesn't check its pull request.
 */
export function useProposalUpdates() {
  useEffect(() => {
    let active = true
    void refreshProposal(true)
    const timer = setInterval(() => {
      if (active) void refreshProposal(true)
    }, 60_000)
    const onFocus = () => void refreshProposal(true)
    window.addEventListener('focus', onFocus)
    const offActive = gui.onTabActive((now) => {
      if (now && !active) void refreshProposal(true)
      active = now
    })
    const offTurns = useChat.subscribe((chat, before) => {
      // The first read can come before the project is open, which reads as none: read again
      // as the chat changes, until there's something to show.
      if (chat.meta !== before.meta && !useProposal.getState().proposal) void refreshProposal()
      const running = chat.turns.some((turn) => turn.status === 'running')
      const was = before.turns.some((turn) => turn.status === 'running')
      if (was && !running) void refreshProposal()
      // A message went in: on main, its branch was made first, and the bar says so.
      else if (chat.turns.length > before.turns.length) void refreshProposal()
    })
    const offSheet = useShipSheet.subscribe((sheet, before) => {
      if (before.open && !sheet.open) void refreshProposal()
    })
    // Restoring a version rewrites files, so the uncommitted count changes with it.
    const offVersions = useVersions.subscribe((sheet, before) => {
      if (before.open && !sheet.open) void refreshProposal()
    })
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      offActive()
      offTurns()
      offSheet()
      offVersions()
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
    return (
      <Badge tone="warning" className="shrink-0">
        Changes requested
      </Badge>
    )
  if (pull.state === 'open' && pull.review === 'approved')
    return (
      <Badge tone="success" className="shrink-0">
        Approved
      </Badge>
    )
  const { label, tone } = STATE_BADGE[pull.state]
  return (
    <Badge tone={tone} className="shrink-0">
      {label}
    </Badge>
  )
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * Over the transcript; absent when there's nothing to say (no repo, nothing changed). The
 * branch itself is in the toolbar, whose branch menu opens Source Control.
 */
export function ProposalBar() {
  const proposal = useProposal((s) => s.proposal)
  const busy = useProposal((s) => s.busy)
  const error = useProposal((s) => s.error)
  const shipBusy = useShipSheet((s) => s.busy)
  const comments = useOpenComments()
  const agentBusy = useChat((s) => s.turns.some((turn) => turn.status === 'running'))
  const draft = useProposal((s) => s.draft)
  const done = useProposal((s) => s.done)
  const retry = useProposal((s) => s.retry)
  if (!proposal) return null

  const bar = barFor(proposal, comments.length, busy, agentBusy, shipBusy, draft)
  const dismiss = () => useProposal.setState({ error: null, retry: null })
  return (
    <>
      {bar}
      {done && <Done done={done} />}
      {error && (
        <Banner
          tone="danger"
          icon={TriangleAlert}
          role="alert"
          wrap
          actions={
            <>
              <GitErrorAction error={error} retry={retry} onDone={dismiss} />
              <TextButton tone="muted" onClick={dismiss}>
                Dismiss
              </TextButton>
            </>
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
  shipBusy: boolean,
  draft: ShipDraft | null,
): ReactNode {
  const { pull, merge } = proposal
  const latest = proposal.defaultBranch ?? 'main'
  const disabled = busy !== null || agentBusy

  // Gui doesn't run Git until the project is trusted: no branch, no commits, until it is.
  if (!proposal.trusted) {
    return (
      <Banner
        wrap
        icon={Shield}
        role="status"
        actions={
          <Button
            size="sm"
            disabled={busy !== null}
            loading={busy === 'trust'}
            onClick={() =>
              void act('trust', async () => {
                await gui.trustProject()
              })
            }
          >
            Trust project…
          </Button>
        }
      >
        <span className="text-pretty">
          Gui needs your OK to use Git in this project, to keep your work on its own branch.
        </span>
      </Banner>
    )
  }
  // The one button that takes the work forward: commit, and when it's online, push and
  // create or update the pull request, all at once.
  const shareButton = (
    <Button
      size="sm"
      variant="primary"
      disabled={disabled || shipBusy}
      loading={busy === 'share'}
      title={agentBusy ? 'Wait for the agent to finish' : shareHint(proposal, draft)}
      onClick={() =>
        void act('share', async () => {
          await share(() => gui.share(draft))
        })
      }
    >
      {shareLabel(proposal, draft)}
    </Button>
  )

  // Getting the latest stopped on conflicts: the agent resolves them, Gui finishes.
  if (merge) {
    const left = merge.marked.length
    return (
      <Banner
        wrap
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
              title={`Go back to how this branch was before getting the latest from ${latest}`}
              onClick={() => void act('cancel', () => gui.cancelMerge())}
            >
              Undo get latest
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
            : 'Conflicts fixed. Finish getting the latest.'}
        </span>
      </Banner>
    )
  }

  // Done with this one: the next idea starts from the latest, in a new chat. A worktree can't
  // switch to main (it's checked out beside it), so it's removed instead: the branch stays.
  if (pull && (pull.state === 'merged' || pull.state === 'closed')) {
    return (
      <Banner
        wrap
        icon={pull.state === 'merged' ? Check : GitPullRequest}
        role="status"
        actions={
          proposal.worktree ? (
            <Button
              size="sm"
              variant="primary"
              icon={Trash2}
              disabled={disabled}
              loading={busy === 'removeWorktree'}
              onClick={() => void act('removeWorktree', () => gui.removeWorktree())}
            >
              Remove worktree
            </Button>
          ) : (
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
          )
        }
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <PullTitle pull={pull} />
          {pullBadge(pull)}
        </span>
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
      title={`Get the newest commits from ${latest} into this work`}
      onClick={() => void act('bringIn', () => gui.bringInLatest())}
    >
      {label}
    </Button>
  )

  if (pull) {
    const changes = proposal.changes
    return (
      <Banner
        wrap
        icon={GitPullRequest}
        role="status"
        actions={
          <>
            {behind > 0 && bringIn('Get latest')}
            {openComments > 0 && (
              <Button
                size="sm"
                variant="primary"
                icon={MessageSquare}
                onClick={() => openReview(true)}
              >
                {plural(openComments, 'comment')}
              </Button>
            )}
            {/* Work here the pull request doesn't have yet; the comments come first when both. */}
            {(changes > 0 || proposal.ahead > 0) && shareButton}
          </>
        }
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <PullTitle pull={pull} />
          {pullBadge(pull)}
        </span>
      </Banner>
    )
  }

  // Not shared yet.
  if (proposal.changes > 0 || proposal.ahead > 0) {
    return (
      <Banner
        wrap
        icon={CircleDot}
        role="status"
        actions={
          <>
            {behind > 0 && !proposal.onDefaultBranch && bringIn('Get latest')}
            {shareButton}
          </>
        }
      >
        <span className="truncate" title={draft?.title ?? proposal.branch ?? undefined}>
          {proposal.changes > 0
            ? plural(proposal.changes, 'uncommitted change')
            : `${plural(proposal.ahead, 'commit')} ready to push`}
          {proposal.branch && ` on ${proposal.branch}`}
          {draft && ` · ${draft.title}`}
        </span>
      </Banner>
    )
  }

  // Opened on main: the first message goes on a branch of its own, unless the user stays.
  if (proposal.newBranchFrom) {
    const from = proposal.newBranchFrom
    return (
      <Banner
        wrap
        icon={GitBranch}
        role="status"
        actions={
          <Button
            size="sm"
            disabled={disabled}
            loading={busy === 'stay'}
            title={`Work on ${from} directly, without a new branch`}
            onClick={() => void act('stay', () => gui.stayOnBranch())}
          >
            Stay on {from}
          </Button>
        }
      >
        <span className="text-pretty">
          Your first message starts a new branch, so {from} stays as it is.
        </span>
      </Banner>
    )
  }

  // Nothing of its own: the only news is that the latest moved on.
  if (behind > 0) {
    return (
      <Banner wrap icon={RotateCw} role="status" actions={bringIn('Get latest')}>
        <span className="truncate">
          {latest} has {plural(behind, 'new commit')}
        </span>
      </Banner>
    )
  }
  return null
}

/**
 * Main, when the work lands right on it (Stay on main, or commits made there by hand). The
 * button names it then, since that's where everyone else gets the work from.
 */
function landsOn(proposal: Proposal) {
  if (!proposal.onDefaultBranch || !proposal.branch) return null
  return proposal.stayOnBranch || proposal.changes === 0 ? proposal.branch : null
}

/** What the bar's button does, in the words the glossary uses for each step. */
function shareLabel(proposal: Proposal, draft: ShipDraft | null) {
  const { pull, remote } = proposal
  const main = landsOn(proposal)
  if (remote === null || draft?.mode === 'commit') return main ? `Commit to ${main}` : 'Commit'
  if (pull && (pull.state === 'open' || pull.state === 'draft')) return 'Update pull request'
  // Gui asks before pushing to main.
  if (main) return proposal.changes > 0 ? `Commit and push to ${main}` : `Push to ${main}`
  if (remote === 'other') return proposal.changes > 0 ? 'Commit and push' : 'Push'
  return 'Create pull request'
}

function shareHint(proposal: Proposal, draft: ShipDraft | null) {
  const files = 'Commits every change except files that may hold secrets'
  const main = landsOn(proposal)
  const where = main
    ? ` to ${main}`
    : proposal.onDefaultBranch && proposal.changes > 0
      ? ', on a new branch'
      : ''
  if (proposal.remote === null || draft?.mode === 'commit')
    return `${files}${where}. It stays on this Mac.`
  if (main && proposal.changes === 0) return `Pushes your commits to ${main}, after Gui asks.`
  if (main) return `${files}${where}, then pushes it after Gui asks.`
  return `${files}${where}, then pushes it.`
}

/** What sharing did, until the next change: a commit kept here, a push, a pull request to finish. */
function Done({ done }: { done: ShareDone }) {
  const host = done.url ? (linkTarget(done.url)?.host ?? 'the website') : null
  return (
    <Banner
      wrap
      icon={done.url ? GitPullRequest : Check}
      role="status"
      actions={
        <>
          {done.url && (
            <Button
              size="sm"
              variant="primary"
              icon={ExternalLink}
              onClick={() => done.url && openExternal(done.url)}
            >
              Open {host}
            </Button>
          )}
          <TextButton tone="muted" onClick={() => useProposal.setState({ done: null })}>
            Dismiss
          </TextButton>
        </>
      }
    >
      <span className="text-pretty">{done.text}</span>
    </Banner>
  )
}

function PullTitle({ pull }: { pull: ProposalPull }) {
  return (
    <button
      type="button"
      title={`Open #${pull.number} on GitHub`}
      onClick={() => openExternal(pull.url)}
      className="no-drag min-w-0 truncate font-medium text-fg hover:underline"
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

  /** The comments being sent ('all' for Fix all), until main answers. */
  const [sending, setSending] = useState<string | null>(null)
  // A ref as well, so a second click before the rerender can't send them twice.
  const inFlight = useRef(false)
  const fix = async (picked: ReviewComment[], which: string) => {
    if (!pull || picked.length === 0 || inFlight.current) return
    inFlight.current = true
    setSending(which)
    try {
      // Not taken: the user cancelled the branch question (or main already said why, as
      // when a branch can't be created). The comments stay here to try again, as a draft
      // stays in the composer, with no error of its own.
      if (!(await gui.send(fixPrompt(pull, picked)))) return
      markHandled(
        pull,
        picked.map((comment) => comment.id),
      )
      openReview(false)
    } finally {
      inFlight.current = false
      setSending(null)
    }
  }
  const busyReason = agentBusy ? 'Wait for the agent to finish' : undefined
  // One primary: Fix all when there's more than one comment, otherwise the comment's own Fix this.
  const several = comments.length > 1

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
        <Message
          fill
          icon={Check}
          tone="accent"
          title="All caught up"
          actions={<Button onClick={() => openReview(false)}>Back to chat</Button>}
        >
          Every comment has gone to the agent or been put aside.
        </Message>
      ) : (
        <>
          <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto scroll-stable p-3">
            {comments.map((comment) => (
              <li key={comment.id}>
                <Card tone="inset" className="flex flex-col gap-2">
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
                      variant={several ? 'secondary' : 'primary'}
                      disabled={agentBusy || (sending !== null && sending !== comment.id)}
                      loading={sending === comment.id}
                      title={busyReason}
                      aria-label={`Fix this: ${comment.author}’s comment`}
                      onClick={() => void fix([comment], comment.id)}
                    >
                      Fix this
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={sending !== null}
                      aria-label={`Put aside: ${comment.author}’s comment`}
                      onClick={() => markHandled(pull, [comment.id])}
                    >
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
                </Card>
              </li>
            ))}
          </ul>
          {several && (
            <div className="flex shrink-0 items-center gap-2 border-t border-line p-2">
              <Button
                variant="primary"
                disabled={agentBusy || (sending !== null && sending !== 'all')}
                loading={sending === 'all'}
                title={busyReason}
                onClick={() => void fix(comments, 'all')}
              >
                Fix all {comments.length}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
