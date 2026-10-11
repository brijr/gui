import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import type { ShipFile, ShipInfo, ShipRequest, ShipResult } from '../../../shared/types'
import { cn } from '../lib/cn'
import { Disclosure, REVEAL } from '../lib/disclosure'
import { Field, InlineError, Input, Textarea } from '../lib/field'
import { ArrowLeft, Check, ExternalLink, GitBranch, Info, TriangleAlert } from '../lib/icons'
import { PathText } from '../lib/path-text'
import { Message, PanelHeader } from '../lib/surface'
import { Button, Code, IconButton, Skeleton } from '../lib/ui'
import { useProposal } from './proposal-state'
import {
  closeShipSheet,
  linkTarget,
  loadShipInfo,
  openExternal,
  setShipDraft,
  submitShip,
  useShipSheet,
} from './shipping-state'

export {
  closeShipSheet,
  linkTarget,
  opensByItself,
  toggleShipSheet,
  useShipSheet,
} from './shipping-state'

const HOSTS = { github: 'GitHub', gitlab: 'GitLab' } as const

function hostName(info: ShipInfo) {
  const host = info.remote?.host
  return host === 'github' || host === 'gitlab' ? HOSTS[host] : null
}

/** What the primary button does for this branch. */
function actionFor(
  info: ShipInfo,
  branch: string,
  mode?: ShipRequest['mode'],
  count = info.files.length,
) {
  if (!info.remote || mode === 'commit') return { label: 'Save commit', running: 'Committing…' }
  // Committing straight onto the default branch leaves nothing to review.
  const direct = info.onDefaultBranch && branch === info.branch
  // More work for a pull request that's already open: it goes into that one.
  const pull = useProposal.getState().proposal?.pull
  const open = pull && (pull.state === 'open' || pull.state === 'draft')
  if (open && !direct && branch === info.branch && hostName(info))
    return { label: 'Update pull request', running: 'Updating…' }
  if (hostName(info) && !direct) return { label: 'Create pull request', running: 'Creating…' }
  return count > 0
    ? { label: 'Commit and push', running: 'Pushing…' }
    : { label: 'Push', running: 'Pushing…' }
}

/** Replaces the transcript and composer while the designer turns their changes into a PR. */
export function ShipSheet() {
  const loaded = useShipSheet((s) => s.loaded)
  const draft = useShipSheet((s) => s.draft)
  const busy = useShipSheet((s) => s.busy)
  const done = useShipSheet((s) => s.done)

  // Also on remount (docking, minimizing), so the file list is current; drafts are kept.
  useEffect(() => {
    void loadShipInfo()
  }, [])

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) closeShipSheet()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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
      />
      {done ? (
        <Done result={done.result} info={done.info} />
      ) : loaded.kind === 'loading' ? (
        // The form's shape while it loads (a second or so for git), in place of a spinner.
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
          <span role="status" className="sr-only">
            Loading
          </span>
          <ShipFormSkeleton />
        </div>
      ) : loaded.kind === 'blocked' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-8">
          <Message
            icon={<Info className="size-4" aria-hidden="true" />}
            actions={<Button onClick={closeShipSheet}>Back to chat</Button>}
          >
            <WithCode text={loaded.message} />
          </Message>
        </div>
      ) : (
        draft && <ShipForm info={loaded.info} draft={draft} busy={busy} />
      )}
    </div>
  )
}

function ShipForm({ info, draft, busy }: { info: ShipInfo; draft: ShipRequest; busy: boolean }) {
  const error = useShipSheet((s) => s.error)
  const id = useId()
  const titleInput = useRef<HTMLInputElement>(null)
  const [expanded, setExpanded] = useState(false)

  // Focused with the caret at the start, so a long suggested title shows its beginning rather
  // than being scrolled to its end.
  useEffect(() => {
    const input = titleInput.current
    if (!input) return
    input.focus()
    input.setSelectionRange(0, 0)
    input.scrollLeft = 0
  }, [])

  const branch = draft.branch.trim()
  const mode = info.remote ? (draft.mode ?? 'share') : 'commit'
  const selected = new Set(draft.files ?? info.files.map((file) => file.path))
  const count = info.files.filter((file) => selected.has(file.path)).length
  const action = actionFor(info, branch, mode, count)
  const ready =
    draft.title.trim() !== '' &&
    branch !== '' &&
    !busy &&
    (count > 0 || (mode === 'share' && Boolean(info.pendingCommits) && branch === info.branch))
  // A branch problem needs the branch field, which is otherwise tucked away.
  const showBranch = expanded || /branch/i.test(error ?? '')

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    if (ready) void submitShip(info)
  }
  // ⌘↵ sends from the description, where ↵ is a new line.
  const onBodyKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && event.metaKey) submit(event)
  }

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto scroll-stable scroll-fade p-3">
        {info.remote && (
          <fieldset className="flex flex-col gap-1.5" disabled={busy}>
            <legend className="mb-1 text-small font-medium text-muted">
              What would you like to do?
            </legend>
            {(
              [
                [
                  'share',
                  'Share for review',
                  'Push saved commits and selected files, then open or update a review.',
                ],
                [
                  'commit',
                  'Save a commit',
                  'Save a version on this computer. Share it when you’re ready.',
                ],
              ] as const
            ).map(([value, label, hint]) => (
              <label
                key={value}
                className={cn(
                  'flex cursor-pointer items-start gap-2 rounded-md border p-2 text-small',
                  mode === value ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover',
                  busy && 'pointer-events-none opacity-40',
                )}
              >
                <input
                  type="radio"
                  name={`${id}-mode`}
                  value={value}
                  checked={mode === value}
                  disabled={value === 'commit' && info.files.length === 0}
                  onChange={() => setShipDraft({ mode: value })}
                  className="mt-0.5 shrink-0 accent-accent"
                />
                <span className="min-w-0">
                  <span className="block font-medium">{label}</span>
                  <span className="block text-caption text-muted">
                    {value === 'commit' && info.files.length === 0
                      ? 'All changes are already committed.'
                      : hint}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <Field
          label={mode === 'commit' ? 'Commit message' : 'Title'}
          htmlFor={`${id}-title`}
          hint={mode === 'commit' ? 'A short summary of what changed.' : undefined}
        >
          <Input
            ref={titleInput}
            id={`${id}-title`}
            value={draft.title}
            maxLength={500}
            disabled={busy}
            aria-describedby={mode === 'commit' ? `${id}-title-hint` : undefined}
            onChange={(event) => setShipDraft({ title: event.target.value })}
          />
        </Field>
        <Field label="Description (optional)" htmlFor={`${id}-body`}>
          <Textarea
            id={`${id}-body`}
            value={draft.body}
            rows={4}
            maxLength={20_000}
            disabled={busy}
            placeholder="What changed, and why"
            onChange={(event) => setShipDraft({ body: event.target.value })}
            onKeyDown={onBodyKeyDown}
          />
        </Field>

        <div className="flex flex-col gap-2">
          <Disclosure
            open={showBranch}
            onOpenChange={setExpanded}
            title="Change the destination branch"
            className="self-start"
          >
            <GitBranch className="size-3 shrink-0" aria-hidden="true" />
            <BranchSummary info={info} branch={branch} count={count} />
          </Disclosure>
          {showBranch && (
            <div className={cn(REVEAL, 'flex flex-col gap-2 pl-4')}>
              <Field
                label="Branch"
                htmlFor={`${id}-branch`}
                hint="Use a new name to create a branch, or an existing name to switch to it."
              >
                <Input
                  id={`${id}-branch`}
                  mono
                  value={draft.branch}
                  maxLength={200}
                  disabled={busy}
                  aria-describedby={`${id}-branch-hint`}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(event) => setShipDraft({ branch: event.target.value })}
                />
              </Field>
            </div>
          )}
          <p className="text-caption text-muted">
            {branch !== info.branch ? 'Switch to this branch, then ' : ''}
            {mode === 'commit'
              ? 'save the selected files locally.'
              : info.onDefaultBranch && branch === info.branch
                ? `push directly to ${branch} in ${info.remote?.repo}.`
                : `push to ${info.remote?.repo} for review.`}
          </p>
        </div>

        {info.files.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center justify-between gap-1 text-small">
              <span className="font-medium text-muted">
                Files to commit · {count} of {info.files.length}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  setShipDraft({ files: count === info.files.length ? [] : undefined })
                }
              >
                {count === info.files.length ? 'Clear selection' : 'Select all'}
              </Button>
            </div>
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
            <p className="text-caption text-subtle">
              Selected files use their current contents, including any unstaged edits.
            </p>
            {count === 0 && mode === 'share' && info.pendingCommits && branch === info.branch && (
              <p className="text-caption text-muted">
                Only saved commits will be pushed. Unselected edits stay here.
              </p>
            )}
          </div>
        ) : (
          <p className="text-small text-muted">
            Your changes are committed locally and ready to push.
          </p>
        )}

        {info.skipped.length > 0 && (
          <p
            className="text-caption text-subtle"
            title="Files that may hold secrets stay on this computer"
          >
            Not included: <PathList paths={info.skipped} />
          </p>
        )}
        {!info.remote && (
          <p className="text-caption text-subtle">
            This project has no remote, so the commit stays on this computer.
          </p>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-line p-2">
        {error && (
          <InlineError className="flex max-h-40 gap-1.5 overflow-y-auto scroll-stable px-1">
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 whitespace-pre-wrap break-words">
              <WithCode text={error} />
            </span>
          </InlineError>
        )}
        <Button type="submit" variant="primary" disabled={!ready} loading={busy} className="w-full">
          {busy ? action.running : action.label}
        </Button>
      </div>
    </form>
  )
}

/** The form's fields as placeholders: Title, Description, the branch line. */
function ShipFormSkeleton() {
  return (
    <>
      <div className="flex flex-col gap-1">
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-7 w-full" />
      </div>
      <div className="flex flex-col gap-1">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-24 w-full" />
      </div>
      <Skeleton className="h-4 w-40" />
    </>
  )
}

/** "Commits to <branch> · 2 files", with the branch kept readable however long it is. */
function BranchSummary({ info, branch, count }: { info: ShipInfo; branch: string; count: number }) {
  const files = `${count} ${count === 1 ? 'file' : 'files'}`
  // Committed earlier, but the push didn't go through.
  const [before, after] =
    info.files.length === 0
      ? ['Saved on', '· ready to push']
      : branch === info.branch
        ? ['Commits to', `· ${files}`]
        : ['On branch', `· ${files}`]
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="shrink-0">{before}</span>
      <PathText path={branch || '…'} className="text-fg" />
      <span className="shrink-0 tabular-nums">{after}</span>
    </span>
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

function Done({ result, info }: { result: ShipResult; info: ShipInfo }) {
  // The bar knew of an open pull request for this branch before shipping.
  const pull = useProposal.getState().proposal?.pull
  const updated = pull?.state === 'open' || pull?.state === 'draft'
  const host = hostName(info)
  const target = linkTarget(result.url)
  const branch = <Code>{result.branch}</Code>
  const review = info.remote?.host === 'gitlab' ? 'merge request' : 'pull request'

  let heading: string
  let detail: ReactNode
  let link: string | null = null
  switch (result.outcome) {
    case 'created':
      heading = updated ? 'Pull request updated' : 'Pull request created'
      detail = <>Your changes are on {branch}, ready for review.</>
      link = 'View pull request'
      break
    case 'compare': {
      const where = target ? (target.known ?? target.host) : null
      heading = 'One last step'
      detail = (
        <>
          Your changes are on {branch}. Open the {review}{' '}
          {where ? `on ${where}` : 'in your browser'} to finish.
        </>
      )
      link = target?.known ? `Finish on ${target.known}` : 'Finish in browser'
      break
    }
    case 'pushed':
      heading = 'Pushed'
      detail = host ? (
        <>
          Your changes are on {branch} on {host}.
        </>
      ) : (
        <>Your changes are on {branch}. Open a pull request for it on your Git host.</>
      )
      break
    case 'committed':
      heading = 'Commit saved'
      detail = (
        <>
          Your changes are saved on {branch} on this computer.
          {info.remote
            ? ' Open Source control when you’re ready to share them.'
            : ' Add a remote to share them with your team.'}
        </>
      )
      break
  }
  // A link to anywhere but github.com or gitlab.com says where it goes before it's followed.
  const label = target && !target.known ? `Open ${target.host}` : link

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-8">
      <Message
        icon={<Check className="size-4" aria-hidden="true" />}
        tone="accent"
        title={heading}
        actions={
          <>
            {label && result.url && (
              <Button
                variant="primary"
                trailingIcon={ExternalLink}
                title={result.url}
                onClick={() => openExternal(result.url ?? '')}
              >
                {label}
              </Button>
            )}
            <Button onClick={closeShipSheet}>Back to chat</Button>
          </>
        }
      >
        <p>{detail}</p>
        <p className="font-mono text-caption text-subtle">Commit {result.commit}</p>
      </Message>
    </div>
  )
}
