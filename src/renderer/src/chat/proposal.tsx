import { type ReactNode, useEffect, useRef, useState } from 'react'
import { fixPrompt } from '../../../shared/review'
import type { Proposal, ProposalPull, ReviewComment, ShipDraft } from '../../../shared/types'
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
  Trash2,
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
import { linkTarget, opensByItself, useShipSheet } from './shipping-state'
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

/** The chat window hands window.open to the system browser. */
function openExternal(url: string) {
  if (/^https:\/\//.test(url)) window.open(url, '_blank', 'noopener')
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
  const finish = useProposal((s) => s.finish)
  if (!proposal) return null

  const bar = barFor(proposal, comments.length, busy, agentBusy, shipBusy, draft)
  return (
    <>
      {bar}
      {finish && <FinishOnHost url={finish} />}
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
  shipBusy: boolean,
  draft: ShipDraft | null,
): ReactNode {
  const { pull, merge } = proposal
  const latest = proposal.defaultBranch ?? 'main'
  const disabled = busy !== null || agentBusy
  // The one button that takes the work forward: commit, and when it's online, push and
  // create or update the pull request, all at once.
  const shareButton = (
    <Button
      size="sm"
      variant="primary"
      disabled={disabled || shipBusy}
      loading={busy === 'share'}
      title={agentBusy ? 'Wait for the agent to finish' : shareHint(proposal, draft)}
      onClick={() => share(draft)}
    >
      {shareLabel(proposal, draft)}
    </Button>
  )

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

  // Done with this one: the next idea starts from the latest, in a new chat. A worktree can't
  // switch to main (it's checked out beside it), so it's removed instead: the branch stays.
  if (pull && (pull.state === 'merged' || pull.state === 'closed')) {
    return (
      <Strip
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
      </Strip>
    )
  }

  // Opened on main: the first message goes on a branch of its own, unless the user stays.
  if (proposal.newBranchFrom) {
    const from = proposal.newBranchFrom
    return (
      <Strip
        icon={GitBranch}
        role="status"
        actions={
          <Button
            size="sm"
            disabled={disabled}
            loading={busy === 'stay'}
            onClick={() => void act('stay', () => gui.stayOnBranch())}
          >
            Stay on {from}
          </Button>
        }
      >
        <span className="text-pretty">
          Your first message starts a new branch, so {from} stays as it is.
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

/** What the bar's button does, in the words the glossary uses for each step. */
function shareLabel(proposal: Proposal, draft: ShipDraft | null) {
  const { pull, remote } = proposal
  if (remote === null || draft?.mode === 'commit') return 'Commit'
  if (pull && (pull.state === 'open' || pull.state === 'draft')) return 'Update pull request'
  if (remote === 'other') return proposal.changes > 0 ? 'Commit and push' : 'Push'
  // Commits made on main by hand: they're pushed there, after Gui asks.
  if (proposal.onDefaultBranch && proposal.changes === 0) return 'Push'
  return 'Create pull request'
}

function shareHint(proposal: Proposal, draft: ShipDraft | null) {
  const files = 'Commits every change except files that may hold secrets'
  if (proposal.remote === null || draft?.mode === 'commit') return `${files}. It stays on this Mac.`
  const branch = proposal.onDefaultBranch && proposal.changes > 0 ? ', on a new branch' : ''
  return `${files}${branch}, then pushes it.`
}

/** Runs the bar's button; a pull request the host can't create here opens on its website. */
function share(draft: ShipDraft | null) {
  void act('share', async () => {
    const result = await gui.share(draft)
    useProposal.setState({ draft: null, finish: null })
    if (result.outcome !== 'compare' || !result.url) return
    if (opensByItself(result)) openExternal(result.url)
    else useProposal.setState({ finish: result.url })
  })
}

/** Pushed, with the pull request still to be created on the host's website. */
function FinishOnHost({ url }: { url: string }) {
  const host = linkTarget(url)?.host ?? 'the website'
  return (
    <Strip
      icon={GitPullRequest}
      role="status"
      actions={
        <>
          <Button size="sm" variant="primary" icon={ExternalLink} onClick={() => openExternal(url)}>
            Open {host}
          </Button>
          <TextButton tone="muted" onClick={() => useProposal.setState({ finish: null })}>
            Dismiss
          </TextButton>
        </>
      }
    >
      <span className="text-pretty">Pushed. Create the pull request on {host} to finish.</span>
    </Strip>
  )
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
