import { type ReactNode, useEffect, useRef, useState } from 'react'
import { TOOLBAR_HEIGHT } from '../../../shared/layout'
import { fixPrompt } from '../../../shared/review'
import type { Proposal, ProposalPull, ReviewComment } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import {
  ArrowLeft,
  Check,
  CircleDot,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  type IconComponent,
  MessageSquare,
  RotateCw,
  SquarePen,
  TriangleAlert,
} from '../lib/icons'
import { Badge } from '../lib/status'
import { Banner, Card, Message, PanelHeader } from '../lib/surface'
import { timeAgo } from '../lib/time'
import { Button, IconButton, TextButton } from '../lib/ui'
import { Markdown } from './markdown'
import {
  type Action,
  act,
  markHandled,
  openReview,
  refreshProposal,
  useProposal,
} from './proposal-state'
import { toggleShipSheet, useShipSheet } from './shipping-state'
import { useVersions } from './versions-state'

export { refreshProposal, useProposal } from './proposal-state'

import { useChat } from './store'

/**
 * The bar over the chat that says where the work stands on its way into the shared project,
 * in a designer's words: not shared yet, in review, changes requested, merged. It offers the
 * one next move (share, review the comments, bring in the latest, start something new), and
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
      // The first read can come before the project is open, which reads as none: read again
      // as the chat changes, until there's something to show.
      if (chat.meta !== before.meta && !useProposal.getState().proposal) void refreshProposal()
      const running = chat.turns.some((turn) => turn.status === 'running')
      const was = before.turns.some((turn) => turn.status === 'running')
      if (was && !running) void refreshProposal()
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

/** The chat window hands window.open to the system browser. */
function openExternal(url: string) {
  if (/^https:\/\//.test(url)) window.open(url, '_blank', 'noopener')
}

/** Over the transcript; absent when there's nothing to say (no repo, nothing changed). */
export function ProposalBar() {
  const proposal = useProposal((s) => s.proposal)
  const busy = useProposal((s) => s.busy)
  const error = useProposal((s) => s.error)
  const comments = useOpenComments()
  const agentBusy = useChat((s) => s.turns.some((turn) => turn.status === 'running'))
  // Under a header as tall as the tab row, as tall as the toolbar: both edges line up.
  const tabRow = useChat((s) => s.meta?.tabRow ?? false)
  if (!proposal) return null

  const bar =
    proposal.pull || proposal.merge || (proposal.behind ?? 0) > 0
      ? barFor(proposal, comments.length, busy, agentBusy)
      : null
  return (
    <>
      <Banner
        icon={GitBranch}
        style={tabRow ? { height: TOOLBAR_HEIGHT } : undefined}
        actions={
          <Button size="sm" variant="ghost" onClick={toggleShipSheet}>
            Source control
          </Button>
        }
      >
        <Button
          size="sm"
          variant="ghost"
          // `!`: flush with the icon; the sm size's padding would win otherwise (cn doesn't merge).
          className="min-w-0 justify-start pl-0!"
          title={proposal.branch ?? 'Detached HEAD'}
          onClick={toggleShipSheet}
        >
          <span className="truncate font-mono">{proposal.branch ?? 'Detached HEAD'}</span>
        </Button>
        <span className="shrink-0 text-caption text-muted">
          {proposal.changes > 0
            ? `${proposal.changes} changed`
            : proposal.ahead > 0
              ? `${proposal.ahead} to push`
              : 'Clean'}
        </span>
      </Banner>
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
      <Strip
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
      </Strip>
    )
  }

  // Done with this one: the next idea starts from the latest, in a new chat.
  if (pull && (pull.state === 'merged' || pull.state === 'closed')) {
    return (
      <Strip
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
      </Strip>
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
      <Strip
        icon={GitPullRequest}
        role="status"
        actions={
          <>
            {behind > 0 && bringIn('Bring in latest')}
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
            {(changes > 0 || proposal.ahead > 0) && (
              <Button
                size="sm"
                variant={openComments > 0 ? 'secondary' : 'primary'}
                disabled={useShipSheet.getState().busy}
                onClick={toggleShipSheet}
              >
                Update
              </Button>
            )}
          </>
        }
      >
        <PullTitle pull={pull} />
        {pullBadge(pull)}
      </Strip>
    )
  }

  // Not shared yet.
  if (proposal.changes > 0 || proposal.ahead > 0) {
    return (
      <Strip
        icon={CircleDot}
        role="status"
        actions={
          <>
            {behind > 0 && !proposal.onDefaultBranch && bringIn('Bring in latest')}
            <Button size="sm" variant="primary" onClick={toggleShipSheet}>
              {proposal.changes > 0 ? 'Review changes' : 'Share for review'}
            </Button>
          </>
        }
      >
        <span className="truncate" title={proposal.branch ?? undefined}>
          {proposal.changes > 0
            ? `${plural(proposal.changes, 'uncommitted file')}`
            : `${plural(proposal.ahead, 'commit')} ready to share`}
          {proposal.branch && ` on ${proposal.branch}`}
        </span>
      </Strip>
    )
  }

  // Nothing of its own: the only news is that the latest moved on.
  if (behind > 0) {
    return (
      <Strip icon={RotateCw} role="status" actions={bringIn('Get latest')}>
        <span className="truncate">
          {plural(behind, 'new update')} on {latest}
        </span>
      </Strip>
    )
  }
  return null
}

/**
 * The bar's layout: what's going on (icon, words, a state badge) on the first line, and the
 * next moves under it, so a narrow sidebar never cuts the title or the buttons short.
 */
function Strip({
  icon: Icon,
  tone = 'neutral',
  role,
  actions,
  children,
}: {
  icon: IconComponent
  tone?: 'neutral' | 'warning'
  role?: 'status'
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div
      role={role}
      className={cn(
        'flex shrink-0 flex-col gap-2 border-b border-line px-3 py-2 text-small',
        tone === 'warning' ? 'bg-warning-soft text-warning' : 'bg-surface text-muted',
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon className="size-3.5 shrink-0" aria-hidden="true" />
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-1">{actions}</div>}
    </div>
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
              <li key={comment.id}>
                <Card tone="inset" className="flex flex-col gap-2 p-3">
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
