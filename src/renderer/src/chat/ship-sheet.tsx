import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import type { ShipFile, ShipInfo, ShipRequest } from '../../../shared/types'
import { gui } from '../lib/api'
import { ChangeMark } from '../lib/changed-files'
import { Disclosure } from '../lib/disclosure'
import { readableError } from '../lib/errors'
import { Field, InlineError, Input, Textarea } from '../lib/field'
import { ArrowLeft, Info, RotateCw } from '../lib/icons'
import { PathText } from '../lib/path-text'
import { Message, PanelHeader } from '../lib/surface'
import { Button, Checkbox, Code, IconButton, Skeleton } from '../lib/ui'
import { BranchPicker, CreateBranchDialog, CreateWorktreeDialog } from './branch-picker'
import { GitErrorAction } from './git-actions'
import { useProposal } from './proposal-state'
import {
  acceptShipProposal,
  closeShipSheet,
  loadShipInfo,
  openExternal,
  performSourceControl,
  setCreateBranchOpen,
  setShipDraft,
  shareFromSheet,
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
  const root = useRef<HTMLDivElement>(null)
  // Opening moves the keyboard to Back; closing hands it to the composer, as the chat's
  // morphs do, rather than leaving it on nothing.
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('button[aria-label="Back to chat"]')?.focus()
    return () => {
      requestAnimationFrame(() => {
        const active = document.activeElement
        if (active && active !== document.body) return
        document.querySelector<HTMLElement>('[data-composer]')?.focus({ preventScroll: true })
      })
    }
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh action availability at both agent transitions
  useEffect(() => {
    void loadShipInfo()
  }, [running])
  useEffect(() => {
    // Every few seconds while the window is in use, one read at a time: each read runs several
    // Git commands. Coming back to the window reads at once.
    let reading = false
    const refresh = async () => {
      const { busy, loaded } = useShipSheet.getState()
      if (reading || busy || loaded.kind !== 'ready') return
      reading = true
      try {
        await loadShipInfo()
      } finally {
        reading = false
      }
    }
    const timer = setInterval(() => {
      if (document.hasFocus()) void refresh()
    }, 5000)
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
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
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('keydown', onKey)
    }
  }, [])
  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
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
        <Message
          fill
          icon={Info}
          actions={
            // Declining closed the question quietly; this asks it again.
            loaded.untrusted && <Button onClick={() => void loadShipInfo()}>Trust project…</Button>
          }
        >
          <WithCode text={loaded.message} />
        </Message>
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
  const retry = useShipSheet((state) => state.retry)
  const notice = useShipSheet((state) => state.notice)
  const pendingProposal = useShipSheet((state) => state.pendingProposal)
  const [description, setDescription] = useState(Boolean(draft.body))
  const pull = useProposal((state) =>
    state.proposal?.branch === info.branch ? state.proposal.pull : null,
  )
  const id = useId()
  const workspace = info.workspace
  if (!workspace)
    return (
      <Message icon={Info}>
        Gui couldn’t read this project’s branches. Refresh to try again.
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
      ? 'Create or switch to the branch first.'
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
  const host =
    info.remote?.host === 'github' ? 'GitHub' : info.remote?.host === 'gitlab' ? 'GitLab' : null
  const openPull = pull && (pull.state === 'open' || pull.state === 'draft')
  // The bar's flow: it ends in a pull request only on a host that takes them, and from a
  // branch other than main (from main, Gui makes one first unless the project stays on main).
  const pullBranch = info.suggestion.branch
  const offersPull =
    host !== null && Boolean(destination) && !(pullBranch === info.branch && shared)
  const canShare =
    count > 0 ||
    workspace.ahead > 0 ||
    (workspace.published && destination?.branch !== workspace.defaultBranch)
  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    if (canCommit) void submitShip(info)
  }
  const requested = draft.branch && draft.branch !== info.branch ? draft.branch : ''
  // Nothing to commit: the commit draft would only be in the way.
  const clean = info.files.length === 0 && info.skipped.length === 0
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
                  Pushes to <Code>{destination.branch}</Code>
                  {host && ` on ${host}`}
                </>
              ) : (
                'This project isn’t online yet. Commits stay on this Mac.'
              )}
            </p>
            {shared && (
              <p className="rounded-md bg-warning-soft p-2 text-caption text-warning">
                {info.stayOnBranch
                  ? `Commits go straight to ${info.branch}, which everyone shares. Gui asks before pushing them.`
                  : `You’re on ${info.branch}, which everyone shares. Create pull request puts your changes on a new branch first.`}
              </p>
            )}
            {workspace.worktree && <WorktreeLine path={workspace.worktree.path} busy={busy} />}
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
          {clean ? (
            <section className="flex flex-col gap-0.5" aria-label="Changed files">
              <h3 className="text-small font-medium">No uncommitted changes</h3>
              <p className="text-pretty text-caption text-muted">
                Changes the agent makes show up here to commit.
              </p>
            </section>
          ) : (
            <>
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
                        files:
                          count === info.files.length ? [] : info.files.map((file) => file.path),
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
                  <p className="py-2 text-small text-muted">Nothing here can be committed.</p>
                )}
                {info.files.length > 0 && (
                  <p className="text-caption text-subtle">
                    Each checked file is committed as it is now.
                  </p>
                )}
                {info.skipped.length > 0 && (
                  <p className="text-caption text-subtle">
                    Left out because they may hold secrets: <PathList paths={info.skipped} />
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
            </>
          )}
          {destination && (
            <section className="flex flex-col gap-2 border-t border-line pt-3" aria-label="Push">
              <p className="text-small font-medium">
                {workspace.ahead > 0
                  ? `${workspace.ahead} ${workspace.ahead === 1 ? 'commit' : 'commits'} ready to push`
                  : 'All commits pushed'}
              </p>
              <p className="text-caption text-muted">
                Push sends your commits. Uncommitted changes stay on this Mac.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={disabled || workspace.ahead === 0 || !info.branch}
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
                  offersPull && (
                    <Button
                      variant="ghost"
                      disabled={disabled || !canShare}
                      loading={action === 'share'}
                      title={
                        canShare
                          ? 'Commits the checked files with this message, pushes them and creates the pull request'
                          : 'Check the files to put in the pull request first'
                      }
                      onClick={() => void shareFromSheet()}
                    >
                      Create pull request
                    </Button>
                  )
                )}
              </div>
            </section>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-2 border-t border-line p-3">
          {error && (
            <InlineError className="max-h-24 overflow-y-auto whitespace-pre-wrap">
              <WithCode text={error} />
            </InlineError>
          )}
          {error && (
            <div className="flex flex-wrap gap-2 empty:hidden">
              <GitErrorAction
                error={error}
                retry={retry}
                onDone={() => useShipSheet.setState({ error: null, retry: null })}
              />
            </div>
          )}
          {notice && (
            <p role="status" className="text-caption text-muted">
              {notice}
            </p>
          )}
          {!clean && reason && <p className="text-caption text-muted">{reason}</p>}
          {!clean && (
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
          )}
        </div>
      </form>
      <CreateBranchDialog
        workspace={{ ...workspace, writeBlocked: restriction }}
        suggested={requested}
      />
      <CreateWorktreeDialog
        branch={info.branch}
        uncommitted={info.files.length + info.skipped.length}
      />
    </>
  )
}

const FILE_LIMIT = 100

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
          <Checkbox
            checked={selected.has(file.path)}
            disabled={busy}
            aria-label={`Include ${file.path}`}
            onChange={() => onToggle(file.path)}
            className="min-h-0 min-w-0 cursor-pointer rounded-sm px-1 py-1 hover:bg-hover [&>span:last-child]:flex [&>span:last-child]:flex-1 [&>span:last-child]:items-center [&>span:last-child]:gap-2"
            label={
              <>
                <ChangeMark status={file.status} />
                <PathText path={file.path} className="flex-1" />
              </>
            }
          />
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

/**
 * This is a worktree: where its folder is, and the way to remove it once it's done. Removing
 * refuses while anything is uncommitted, and the branch and its commits stay.
 */
function WorktreeLine({ path, busy }: { path: string; busy: boolean }) {
  const [removing, setRemoving] = useState(false)
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-surface p-2 text-caption">
      <p className="text-muted">
        Worktree: a separate copy of your project on its own branch, in{' '}
        <span className="font-mono break-all text-fg" title={path}>
          {path}
        </span>
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={() => gui.revealProject()}>
          Reveal in Finder
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          loading={removing}
          onClick={async () => {
            setRemoving(true)
            try {
              await gui.removeWorktree()
            } catch (error) {
              useShipSheet.setState({ error: readableError(error) })
            } finally {
              setRemoving(false)
            }
          }}
        >
          Remove worktree…
        </Button>
      </div>
    </div>
  )
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
