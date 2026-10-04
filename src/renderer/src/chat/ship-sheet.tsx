import {
  ArrowLeft,
  Check,
  ChevronRight,
  ExternalLink,
  GitBranch,
  TriangleAlert,
} from 'lucide-react'
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { create } from 'zustand'
import type { ShipFile, ShipInfo, ShipRequest, ShipResult } from '../../../shared/types'
import { grat } from '../lib/api'
import { cn } from '../lib/cn'
import { readableError } from '../lib/errors'
import { Button, IconButton, Spinner } from '../lib/ui'

type Loaded =
  | { kind: 'loading' }
  | { kind: 'blocked'; message: string }
  | { kind: 'ready'; info: ShipInfo }

interface ShipSheetStore {
  open: boolean
  loaded: Loaded
  /** The form; lives here so it survives the panel remounting on dock/float/minimize */
  draft: ShipRequest | null
  busy: boolean
  error: string | null
  done: { result: ShipResult; info: ShipInfo } | null
}

const CLOSED: ShipSheetStore = {
  open: false,
  loaded: { kind: 'loading' },
  draft: null,
  busy: false,
  error: null,
  done: null,
}

export const useShipSheet = create<ShipSheetStore>(() => CLOSED)

/** Bumped on close so a slow load can't fill a sheet that was closed and reopened. */
let generation = 0

export function toggleShipSheet() {
  const { open, busy } = useShipSheet.getState()
  if (busy) return
  generation++
  useShipSheet.setState(open ? CLOSED : { ...CLOSED, open: true })
}

function closeShipSheet() {
  if (useShipSheet.getState().busy) return
  generation++
  useShipSheet.setState(CLOSED)
}

/** Fetches what would be shipped; the draft is only filled from the suggestion once. */
async function loadShipInfo() {
  const current = generation
  let loaded: Loaded
  try {
    const info = await grat.getShipInfo()
    if (!info) loaded = { kind: 'blocked', message: 'Open a project first.' }
    else if (info.blocked) loaded = { kind: 'blocked', message: info.blocked }
    else loaded = { kind: 'ready', info }
  } catch (error) {
    loaded = { kind: 'blocked', message: readableError(error) }
  }
  if (current !== generation) return
  useShipSheet.setState(({ draft }) => ({
    loaded,
    draft: draft ?? (loaded.kind === 'ready' ? loaded.info.suggestion : null),
  }))
}

function setShipDraft(patch: Partial<ShipRequest>) {
  useShipSheet.setState(({ draft }) => (draft ? { draft: { ...draft, ...patch } } : {}))
}

async function submitShip(info: ShipInfo) {
  const { draft, busy } = useShipSheet.getState()
  if (!draft || busy) return
  const request = {
    branch: draft.branch.trim(),
    title: draft.title.trim(),
    body: draft.body.trim(),
  }
  useShipSheet.setState({ busy: true, error: null })
  try {
    const result = await grat.ship(request)
    // The pull request isn't open until they finish it in the browser, so go there now.
    if (opensByItself(result) && result.url) openExternal(result.url)
    useShipSheet.setState({ busy: false, done: { result, info } })
  } catch (error) {
    useShipSheet.setState({ busy: false, error: readableError(error) })
    // A failed push still committed: refresh so the sheet says what's left to do.
    void loadShipInfo()
  }
}

/** The chat window hands window.open to the system browser (guardAppContents in window.ts). */
function openExternal(url: string) {
  if (/^https?:\/\//.test(url)) window.open(url, '_blank', 'noopener')
}

/** Hosts whose pull request pages Grat builds itself. */
const KNOWN_HOSTS = new Map([
  ['github.com', 'GitHub'],
  ['gitlab.com', 'GitLab'],
])

/**
 * Where a result's link goes: its host as shown on the button, and the host's name when
 * it's github.com or gitlab.com over https. Exported for tests.
 */
export function linkTarget(url: string | null): { host: string; known: string | null } | null {
  if (!url) return null
  try {
    const { protocol, host, hostname } = new URL(url)
    if (protocol !== 'https:' && protocol !== 'http:') return null
    return { host, known: (protocol === 'https:' && KNOWN_HOSTS.get(hostname)) || null }
  } catch {
    return null
  }
}

/**
 * Only the new-pull-request page Grat built for github.com or gitlab.com opens without a
 * click. Any other link (a self-hosted server's, or one a server printed while pushing)
 * waits behind a button that names its host. Exported for tests.
 */
export function opensByItself(result: ShipResult): boolean {
  return result.outcome === 'compare' && Boolean(linkTarget(result.url)?.known)
}

const HOSTS = { github: 'GitHub', gitlab: 'GitLab' } as const

function hostName(info: ShipInfo) {
  const host = info.remote?.host
  return host === 'github' || host === 'gitlab' ? HOSTS[host] : null
}

/** What the primary button does for this branch. */
function actionFor(info: ShipInfo, branch: string) {
  if (!info.remote) return { label: 'Commit', running: 'Committing…' }
  // Committing straight onto the default branch leaves nothing to review.
  const direct = info.onDefaultBranch && branch === info.branch
  if (hostName(info) && !direct) return { label: 'Create pull request', running: 'Creating…' }
  return info.files.length > 0
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

  const info = loaded.kind === 'ready' ? loaded.info : null
  const heading =
    done || !info || !draft ? 'Create pull request' : actionFor(info, draft.branch.trim()).label

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-1.5">
        <IconButton label="Back to chat" disabled={busy} onClick={closeShipSheet}>
          <ArrowLeft className="size-3.5" />
        </IconButton>
        <h2 className="truncate font-medium">{heading}</h2>
      </div>
      {done ? (
        <Done result={done.result} info={done.info} />
      ) : loaded.kind === 'loading' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted">
          <Spinner />
        </div>
      ) : loaded.kind === 'blocked' ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <p className="text-pretty text-muted">
            <WithCode text={loaded.message} />
          </p>
          <Button onClick={closeShipSheet}>Back to chat</Button>
        </div>
      ) : (
        draft && <ShipForm info={loaded.info} draft={draft} busy={busy} />
      )}
    </div>
  )
}

const FIELD =
  'w-full rounded-lg border border-line-strong bg-raised px-2.5 text-[13px] text-fg outline-none placeholder:text-subtle focus:border-accent focus-visible:outline-none disabled:opacity-60'

function ShipForm({ info, draft, busy }: { info: ShipInfo; draft: ShipRequest; busy: boolean }) {
  const error = useShipSheet((s) => s.error)
  const id = useId()
  const titleInput = useRef<HTMLInputElement>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    titleInput.current?.focus()
  }, [])

  const branch = draft.branch.trim()
  const action = actionFor(info, branch)
  const ready = draft.title.trim() !== '' && branch !== '' && !busy
  // A branch problem needs the branch field, which is otherwise tucked away.
  const showBranch = expanded || /branch name/i.test(error ?? '')

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
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-title`} className="px-0.5 text-[11.5px] text-muted">
            Title
          </label>
          <input
            ref={titleInput}
            id={`${id}-title`}
            value={draft.title}
            maxLength={500}
            disabled={busy}
            onChange={(event) => setShipDraft({ title: event.target.value })}
            className={cn(FIELD, 'h-8')}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-body`} className="px-0.5 text-[11.5px] text-muted">
            Description
          </label>
          <textarea
            id={`${id}-body`}
            value={draft.body}
            rows={4}
            maxLength={20_000}
            disabled={busy}
            placeholder="What changed, and why"
            onChange={(event) => setShipDraft({ body: event.target.value })}
            onKeyDown={onBodyKeyDown}
            className={cn(FIELD, 'resize-none py-1.5 leading-snug')}
          />
        </div>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            aria-expanded={showBranch}
            title="Change the branch or see the files"
            onClick={() => setExpanded(!showBranch)}
            className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-left text-[12px] text-muted hover:bg-hover hover:text-fg"
          >
            <GitBranch className="size-3 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">
              <BranchSummary info={info} branch={branch} />
            </span>
            <ChevronRight
              className={cn(
                'ml-auto size-3 shrink-0 transition-transform',
                showBranch && 'rotate-90',
              )}
              aria-hidden="true"
            />
          </button>
          {showBranch && (
            <div className="flex flex-col gap-2 pl-5">
              <div className="flex flex-col gap-1">
                <label htmlFor={`${id}-branch`} className="px-0.5 text-[11.5px] text-muted">
                  Branch
                </label>
                <input
                  id={`${id}-branch`}
                  value={draft.branch}
                  maxLength={200}
                  disabled={busy}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(event) => setShipDraft({ branch: event.target.value })}
                  className={cn(FIELD, 'h-7 font-mono text-[12px]')}
                />
              </div>
              {info.files.length > 0 && <FileList files={info.files} />}
            </div>
          )}
        </div>

        {info.skipped.length > 0 && (
          <p
            className="px-1 text-[11.5px] text-subtle"
            title="Files that may hold secrets stay on this computer"
          >
            Not included: <PathList paths={info.skipped} />
          </p>
        )}
        {!info.remote && (
          <p className="px-1 text-[11.5px] text-subtle">
            This project has no remote, so the commit stays on this computer.
          </p>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-line p-2">
        {error && (
          <p
            role="alert"
            className="flex max-h-40 select-text gap-1.5 overflow-y-auto px-1 text-[12px] text-danger"
          >
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 whitespace-pre-wrap break-words">
              <WithCode text={error} />
            </span>
          </p>
        )}
        <Button type="submit" variant="primary" disabled={!ready} className="h-8 justify-center">
          {busy && <Spinner />}
          {busy ? action.running : action.label}
        </Button>
      </div>
    </form>
  )
}

function BranchSummary({ info, branch }: { info: ShipInfo; branch: string }) {
  const name = <code className="font-mono text-[11.5px] text-fg">{branch || '…'}</code>
  const count = info.files.length
  // Committed earlier, but the push didn't go through.
  if (count === 0) return <>Saved on {name}, ready to push</>
  const files = `${count} ${count === 1 ? 'file' : 'files'}`
  return branch === info.branch ? (
    <>
      Commits to {name} · {files}
    </>
  ) : (
    <>
      On branch {name} · {files}
    </>
  )
}

const FILE_LIMIT = 100
const STATUS_COLOR: Record<ShipFile['status'], string> = {
  added: 'text-success',
  modified: 'text-warning',
  deleted: 'text-danger',
  renamed: 'text-accent',
}

function FileList({ files }: { files: ShipFile[] }) {
  const more = files.length - FILE_LIMIT
  return (
    <ul className="flex flex-col gap-0.5 font-mono text-[11px]">
      {files.slice(0, FILE_LIMIT).map((file) => (
        <li key={file.path} className="flex min-w-0 items-center gap-2">
          <span className={cn('w-3 shrink-0', STATUS_COLOR[file.status])} title={file.status}>
            {file.status[0]?.toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate" title={file.path}>
            {file.path}
          </span>
        </li>
      ))}
      {more > 0 && <li className="pl-5 font-sans text-subtle">and {more} more</li>}
    </ul>
  )
}

function PathList({ paths }: { paths: string[] }) {
  const shown = paths.slice(0, 3)
  const nodes: ReactNode[] = []
  for (const [index, path] of shown.entries()) {
    if (index > 0) nodes.push(<span key={`${path}-sep`}>, </span>)
    nodes.push(
      <code key={path} className="font-mono text-[11px] text-muted">
        {path}
      </code>,
    )
  }
  if (paths.length > shown.length) nodes.push(` and ${paths.length - shown.length} more`)
  return <>{nodes}</>
}

/** Renders `backticked` parts of a message as code. */
function WithCode({ text }: { text: string }) {
  const nodes: ReactNode[] = []
  let offset = 0
  for (const [index, part] of text.split('`').entries()) {
    nodes.push(
      index % 2 === 1 ? (
        <code key={offset} className="font-mono text-[11.5px]">
          {part}
        </code>
      ) : (
        <span key={offset}>{part}</span>
      ),
    )
    offset += part.length + 1
  }
  return <>{nodes}</>
}

function Done({ result, info }: { result: ShipResult; info: ShipInfo }) {
  const host = hostName(info)
  const target = linkTarget(result.url)
  const branch = <code className="font-mono text-[12px] text-fg">{result.branch}</code>
  const review = info.remote?.host === 'gitlab' ? 'merge request' : 'pull request'

  let heading: string
  let detail: ReactNode
  let link: string | null = null
  switch (result.outcome) {
    case 'created':
      heading = 'Pull request created'
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
      heading = 'Committed'
      detail = (
        <>Your changes are saved on {branch}. There’s no remote, so they stay on this computer.</>
      )
      break
  }
  // A link to anywhere but github.com or gitlab.com says where it goes before it's followed.
  const label = target && !target.known ? `Open ${target.host}` : link

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <span className="flex size-8 items-center justify-center rounded-full bg-accent-soft text-accent">
        <Check className="size-4" aria-hidden="true" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="font-medium">{heading}</p>
        <p className="text-pretty text-muted">{detail}</p>
        <p className="font-mono text-[11px] text-subtle">Commit {result.commit}</p>
      </div>
      <div className="flex flex-col items-center gap-1.5">
        {label && result.url && (
          <Button
            variant="primary"
            title={result.url}
            onClick={() => openExternal(result.url ?? '')}
          >
            {label}
            <ExternalLink className="size-3" aria-hidden="true" />
          </Button>
        )}
        <Button variant="ghost" onClick={closeShipSheet}>
          Back to chat
        </Button>
      </div>
    </div>
  )
}
