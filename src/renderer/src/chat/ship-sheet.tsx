import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react'
import type { ShipFile, ShipInfo, ShipRequest } from '../../../shared/types'
import { cn } from '../lib/cn'
import { Dialog } from '../lib/dialog'
import { Disclosure } from '../lib/disclosure'
import { Field, InlineError, Input, Textarea } from '../lib/field'
import { ArrowLeft, Info, RotateCw } from '../lib/icons'
import { PathText } from '../lib/path-text'
import { Message, PanelHeader } from '../lib/surface'
import { Button, Code, IconButton, Skeleton } from '../lib/ui'
import { BranchPicker, CreateBranchDialog } from './branch-picker'
import { useProposal } from './proposal-state'
import {
  acceptShipProposal,
  closeShipSheet,
  loadShipInfo,
  openExternal,
  performSourceControl,
  setCreateBranchOpen,
  setShipDraft,
  submitShip,
  useShipSheet,
} from './shipping-state'
import { useChat } from './store'

export {
  closeShipSheet,
  linkTarget,
  openShipSheet,
  opensByItself,
  toggleShipSheet,
  useShipSheet,
} from './shipping-state'

/** Repository context remains readable and the draft stays editable during an agent run. */
export function ShipSheet() {
  const loaded = useShipSheet((state) => state.loaded)
  const draft = useShipSheet((state) => state.draft)
  const busy = useShipSheet((state) => state.busy)
  const running = useChat((state) => state.turns.some((turn) => turn.status === 'running'))
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh action availability at both agent transitions
  useEffect(() => {
    void loadShipInfo()
  }, [running])
  useEffect(() => {
    const refresh = () => {
      const { busy, loaded } = useShipSheet.getState()
      if (!busy && loaded.kind === 'ready') void loadShipInfo()
    }
    const timer = setInterval(refresh, 5000)
    window.addEventListener('focus', refresh)
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !document.querySelector('dialog[open]')
      )
        closeShipSheet()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('keydown', onKey)
    }
  }, [])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title="Source control"
        leading={
          <IconButton
            size="sm"
            label="Back to chat"
            icon={ArrowLeft}
            disabled={busy}
            onClick={closeShipSheet}
          />
        }
        actions={
          <IconButton
            size="sm"
            icon={RotateCw}
            label="Refresh source control"
            disabled={busy}
            onClick={() => void loadShipInfo()}
          />
        }
      />
      {loaded.kind === 'loading' ? (
        <div className="flex flex-col gap-3 p-3" role="status" aria-label="Loading source control">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-7 w-full" />
        </div>
      ) : loaded.kind === 'blocked' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center p-3">
          <Message icon={<Info className="size-4" aria-hidden="true" />}>
            <WithCode text={loaded.message} />
          </Message>
        </div>
      ) : (
        draft && <Workspace info={loaded.info} draft={draft} running={running} />
      )}
    </div>
  )
}

function Workspace({
  info,
  draft,
  running,
}: {
  info: ShipInfo
  draft: ShipRequest
  running: boolean
}) {
  const busy = useShipSheet((state) => state.busy)
  const action = useShipSheet((state) => state.action)
  const error = useShipSheet((state) => state.error)
  const notice = useShipSheet((state) => state.notice)
  const reviewDraft = useShipSheet((state) => state.reviewDraft)
  const pendingProposal = useShipSheet((state) => state.pendingProposal)
  const [description, setDescription] = useState(Boolean(draft.body))
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewTitle, setReviewTitle] = useState('')
  const [reviewBody, setReviewBody] = useState('')
  const pull = useProposal((state) =>
    state.proposal?.branch === info.branch ? state.proposal.pull : null,
  )
  const id = useId()
  const workspace = info.workspace
  if (!workspace)
    return (
      <Message icon={<Info className="size-4" aria-hidden="true" />}>
        Refresh Source control to load repository details.
      </Message>
    )
  const restriction = running ? 'Wait for the agent to finish first.' : workspace.writeBlocked
  const disabled = busy || Boolean(restriction)
  const selected = new Set(draft.files ?? [])
  const count = info.files.filter((file) => selected.has(file.path)).length
  const branchReady = Boolean(info.branch) && draft.branch === info.branch
  const reason =
    restriction ||
    (!branchReady
      ? 'Create or select the branch before committing.'
      : info.files.length === 0
        ? 'No changes to commit.'
        : count === 0
          ? 'Select at least one file to commit.'
          : !draft.title.trim()
            ? 'Add a commit message.'
            : null)
  const canCommit = !busy && !reason
  const shared =
    info.branch === 'main' || info.branch === 'master' || info.branch === workspace.defaultBranch
  const destination = workspace.destination
  const openPull = pull && (pull.state === 'open' || pull.state === 'draft')
  const canPull = Boolean(
    destination &&
      info.remote?.host !== 'other' &&
      destination.branch !== workspace.defaultBranch &&
      workspace.published &&
      workspace.ahead === 0,
  )
  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    if (canCommit) void submitShip(info)
  }
  const requested = draft.branch && draft.branch !== info.branch ? draft.branch : ''
  const proposedTarget = workspace.branches.find((branch) => branch.name === requested)
  return (
    <>
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto scroll-stable scroll-fade p-3">
          {pendingProposal && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface p-2 text-small">
              <span>The agent proposed another commit. Your draft is kept.</span>
              <Button size="sm" disabled={busy} onClick={acceptShipProposal}>
                Use agent proposal
              </Button>
            </div>
          )}
          <section className="flex flex-col gap-2" aria-label="Branch">
            <div className="flex min-w-0 flex-wrap gap-2">
              <BranchPicker workspace={workspace} disabled={disabled} />
            </div>
            <p className="text-caption text-muted">
              {destination ? (
                <>
                  Push destination{' '}
                  <Code>
                    {destination.remote}/{destination.branch}
                  </Code>
                </>
              ) : (
                'No remote configured. Commits stay on this computer.'
              )}
            </p>
            {shared && (
              <p className="rounded-md bg-warning-soft p-2 text-caption text-warning">
                You're on the shared branch. Create a branch to keep changes separate.
              </p>
            )}
            {requested && (
              <div className="flex flex-col gap-2 rounded-md bg-surface p-2 text-small">
                <p>
                  {info.branch ? 'Proposed branch' : 'Create a branch to commit'}:{' '}
                  <Code>{requested}</Code>
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={disabled}
                    onClick={() => {
                      if (proposedTarget)
                        void performSourceControl({
                          kind: 'switch',
                          branch: requested,
                          remote: proposedTarget.remote,
                        })
                      else setCreateBranchOpen(true)
                    }}
                  >
                    {proposedTarget ? 'Switch to branch' : 'Create proposed branch'}
                  </Button>
                  {info.branch && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setShipDraft({ branch: info.branch ?? '' })}
                    >
                      Use current branch
                    </Button>
                  )}
                </div>
              </div>
            )}
          </section>
          <section className="flex flex-col gap-2" aria-label="Changed files">
            <div className="flex flex-wrap items-center justify-between gap-1 text-small">
              <h3 className="font-medium">
                Changes{' '}
                <span className="text-caption text-muted">
                  {count} of {info.files.length} selected
                </span>
              </h3>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || info.files.length === 0}
                onClick={() =>
                  setShipDraft({
                    files: count === info.files.length ? [] : info.files.map((file) => file.path),
                  })
                }
              >
                {count === info.files.length && count > 0 ? 'Clear selection' : 'Select all'}
              </Button>
            </div>
            {info.files.length > 0 ? (
              <FileList
                files={info.files}
                selected={selected}
                busy={busy}
                onToggle={(path) => {
                  const next = new Set(selected)
                  if (next.has(path)) next.delete(path)
                  else next.add(path)
                  setShipDraft({ files: [...next] })
                }}
              />
            ) : (
              <p className="py-2 text-small text-muted">
                Working tree clean. You can still switch or create a branch.
              </p>
            )}
            {info.files.length > 0 && (
              <p className="text-caption text-subtle">
                Checked files include their current contents, including unstaged edits.
              </p>
            )}
            {info.skipped.length > 0 && (
              <p className="text-caption text-subtle">
                Excluded as possible secrets: <PathList paths={info.skipped} />
              </p>
            )}
          </section>
          <section className="flex flex-col gap-2" aria-label="Commit draft">
            <Field
              label="Commit message"
              htmlFor={`${id}-message`}
              hint={
                draft.title && draft.title === info.suggestion.title
                  ? 'Suggested message. Edit it before committing.'
                  : undefined
              }
            >
              <Input
                id={`${id}-message`}
                value={draft.title}
                disabled={busy}
                maxLength={500}
                placeholder="Describe this change"
                onChange={(event) => setShipDraft({ title: event.target.value })}
                aria-describedby={
                  draft.title && draft.title === info.suggestion.title
                    ? `${id}-message-hint`
                    : undefined
                }
              />
            </Field>
            <Disclosure
              open={description}
              onOpenChange={setDescription}
              title="Description (optional)"
            >
              Description (optional)
            </Disclosure>
            {description && (
              <Textarea
                aria-label="Commit description"
                value={draft.body}
                disabled={busy}
                maxLength={20_000}
                rows={3}
                placeholder="What changed, and why"
                onChange={(event) => setShipDraft({ body: event.target.value })}
                onKeyDown={(event) => {
                  if (event.metaKey && event.key === 'Enter') submit(event)
                }}
              />
            )}
          </section>
          <section
            className="flex flex-col gap-2 border-t border-line pt-3"
            aria-label="Remote actions"
          >
            <p className="text-small font-medium">
              {destination
                ? workspace.ahead > 0
                  ? `${workspace.ahead} ${workspace.ahead === 1 ? 'commit' : 'commits'} ready to push`
                  : 'All commits pushed'
                : 'No remote configured'}
            </p>
            {destination && (
              <p className="text-caption text-muted">
                Only saved commits are pushed. Uncommitted edits stay here.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={disabled || !destination || workspace.ahead === 0 || !info.branch}
                loading={action === 'push'}
                onClick={() => void performSourceControl({ kind: 'push' })}
              >
                Push
              </Button>
              {openPull ? (
                <Button variant="ghost" onClick={() => openExternal(pull.url)}>
                  Open pull request
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  disabled={disabled || !canPull}
                  loading={action === 'pull'}
                  onClick={() => {
                    setReviewTitle(reviewDraft?.title || info.suggestion.title)
                    setReviewBody(reviewDraft?.body ?? info.suggestion.body)
                    setReviewOpen(true)
                  }}
                >
                  Create pull request
                </Button>
              )}
            </div>
            {destination && !openPull && !canPull && (
              <p className="text-caption text-subtle">
                {info.remote?.host === 'other'
                  ? 'This remote has no supported pull request page.'
                  : destination.branch === workspace.defaultBranch
                    ? 'Use a separate branch for a pull request.'
                    : 'Push the saved commits first.'}
              </p>
            )}
          </section>
        </div>
        <div className="flex shrink-0 flex-col gap-2 border-t border-line p-3">
          {error && (
            <InlineError className="max-h-24 overflow-y-auto whitespace-pre-wrap">
              <WithCode text={error} />
            </InlineError>
          )}
          {notice && (
            <p role="status" className="text-caption text-muted">
              {notice}
            </p>
          )}
          {reason && <p className="text-caption text-muted">{reason}</p>}
          <Button
            type="submit"
            variant="primary"
            disabled={!canCommit}
            loading={action === 'commit'}
            className="w-full"
          >
            {action === 'commit'
              ? 'Committing…'
              : `Commit ${count} ${count === 1 ? 'file' : 'files'}`}
          </Button>
        </div>
      </form>
      <CreateBranchDialog
        workspace={{ ...workspace, writeBlocked: restriction }}
        suggested={requested}
      />
      <Dialog
        open={reviewOpen}
        onClose={() => {
          if (!busy) setReviewOpen(false)
        }}
        title="Create pull request"
        className="flex flex-col gap-3 p-3"
        footer={
          <>
            <Button disabled={busy} onClick={() => setReviewOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={disabled || !reviewTitle.trim()}
              loading={action === 'pull'}
              onClick={() => {
                void performSourceControl({ kind: 'pull', title: reviewTitle, body: reviewBody })
                setReviewOpen(false)
              }}
            >
              Create pull request
            </Button>
          </>
        }
      >
        <Field label="Title" htmlFor={`${id}-review-title`}>
          <Input
            id={`${id}-review-title`}
            value={reviewTitle}
            maxLength={500}
            disabled={busy}
            onChange={(event) => setReviewTitle(event.target.value)}
          />
        </Field>
        <Field label="Description (optional)" htmlFor={`${id}-review-body`}>
          <Textarea
            id={`${id}-review-body`}
            value={reviewBody}
            rows={4}
            maxLength={20_000}
            disabled={busy}
            onChange={(event) => setReviewBody(event.target.value)}
          />
        </Field>
      </Dialog>
    </>
  )
}

const FILE_LIMIT = 100
const STATUS_COLOR: Record<ShipFile['status'], string> = {
  added: 'text-success',
  modified: 'text-warning',
  deleted: 'text-danger',
  renamed: 'text-accent-text',
}

function FileList({
  files,
  selected,
  busy,
  onToggle,
}: {
  files: ShipFile[]
  selected: Set<string>
  busy: boolean
  onToggle: (path: string) => void
}) {
  const [limit, setLimit] = useState(FILE_LIMIT)
  const more = files.length - limit
  return (
    <ul
      aria-label="Files to commit"
      className="flex max-h-40 flex-col gap-0.5 overflow-y-auto scroll-stable rounded-md border border-line p-1.5 text-caption"
    >
      {files.slice(0, limit).map((file) => (
        <li key={file.path}>
          <label className="flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1 py-1 hover:bg-hover">
            <input
              type="checkbox"
              checked={selected.has(file.path)}
              disabled={busy}
              aria-label={`Include ${file.path}`}
              onChange={() => onToggle(file.path)}
              className="shrink-0 accent-accent"
            />
            <span
              className={cn('w-3 shrink-0 font-mono', STATUS_COLOR[file.status])}
              aria-hidden="true"
              title={file.status}
            >
              {file.status[0]?.toUpperCase()}
            </span>
            <span className="sr-only">{file.status}</span>
            <PathText path={file.path} className="flex-1" />
          </label>
        </li>
      ))}
      {more > 0 && (
        <li>
          <Button size="sm" variant="ghost" onClick={() => setLimit(limit + FILE_LIMIT)}>
            Show more ({more} remaining)
          </Button>
        </li>
      )}
    </ul>
  )
}

function PathList({ paths }: { paths: string[] }) {
  const shown = paths.slice(0, 3)
  const nodes: ReactNode[] = []
  for (const [index, path] of shown.entries()) {
    if (index > 0) nodes.push(<span key={`${path}-sep`}>, </span>)
    nodes.push(
      <code key={path} className="font-mono text-muted">
        {path}
      </code>,
    )
  }
  if (paths.length > shown.length) {
    nodes.push(
      <span key="more" className="tabular-nums">
        {` and ${paths.length - shown.length} more`}
      </span>,
    )
  }
  return <>{nodes}</>
}

/** Renders `backticked` parts of a message as code. */
function WithCode({ text }: { text: string }) {
  const nodes: ReactNode[] = []
  let offset = 0
  for (const [index, part] of text.split('`').entries()) {
    nodes.push(
      index % 2 === 1 ? <Code key={offset}>{part}</Code> : <span key={offset}>{part}</span>,
    )
    offset += part.length + 1
  }
  return <>{nodes}</>
}
