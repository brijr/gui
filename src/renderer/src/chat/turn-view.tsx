import {
  Brain,
  Check,
  Circle,
  CircleDot,
  CircleSlash,
  Eye,
  FilePen,
  FileText,
  Globe,
  Info,
  MousePointer2,
  Redo2,
  Search,
  SquareTerminal,
  TriangleAlert,
  Undo2,
  Wrench,
  X,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import type {
  ElementContext,
  FileChange,
  PermissionChoice,
  PreviewFrame,
  Turn,
  TurnItem,
} from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { Disclosure, TechnicalDetails } from '../lib/disclosure'
import { readableError } from '../lib/errors'
import { PathText } from '../lib/path-text'
import { Badge } from '../lib/status'
import { Card, GroupLabel, Thumbnail } from '../lib/surface'
import { Button, Spinner } from '../lib/ui'
import { Markdown } from './markdown'

type ToolItem = Extract<TurnItem, { kind: 'tool' }>
type PermissionItem = Extract<TurnItem, { kind: 'permission' }>
type ThoughtItem = Extract<TurnItem, { kind: 'thought' }>
type Step = ToolItem | ThoughtItem
type Block = { kind: 'steps'; id: string; steps: Step[] } | Exclude<TurnItem, Step>

/** Consecutive tool calls and the thinking between them render as one compact group. */
function toBlocks(items: TurnItem[]): Block[] {
  const blocks: Block[] = []
  for (const item of items) {
    if (item.kind !== 'tool' && item.kind !== 'thought') {
      blocks.push(item)
      continue
    }
    const last = blocks.at(-1)
    if (last?.kind === 'steps') last.steps.push(item)
    else blocks.push({ kind: 'steps', id: item.id, steps: [item] })
  }
  return blocks
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/**
 * One turn: what the user asked, what the agent said and did (its steps folded away), and
 * at the end the result to judge, with Undo.
 */
export function TurnView({ turn, showRedo }: { turn: Turn; showRedo: boolean }) {
  const blocks = toBlocks(turn.items)
  const running = turn.status === 'running'
  return (
    <article className="flex flex-col gap-3">
      <UserMessage turn={turn} />
      <div className={cn('flex flex-col gap-3', turn.reverted && 'opacity-50')}>
        {blocks.map((block, index) => (
          <BlockView
            key={block.id}
            block={block}
            next={blocks[index + 1]}
            turnId={turn.id}
            live={running}
          />
        ))}
        {running && <Working since={turn.startedAt} />}
        {turn.status === 'error' && (
          <Note tone="error" detail={turn.errorDetail}>
            {turn.error}
          </Note>
        )}
        {turn.status === 'cancelled' && (
          <Badge icon={CircleSlash} className="self-start">
            Stopped
          </Badge>
        )}
      </div>
      {!running && <Result turn={turn} showRedo={showRedo} />}
    </article>
  )
}

function UserMessage({ turn }: { turn: Turn }) {
  return (
    <div className="flex flex-col items-end gap-1.5">
      {turn.context && <ElementChip element={turn.context} />}
      {turn.attachments && turn.attachments.length > 0 && (
        <ul aria-label="Attached images" className="flex max-w-7/8 flex-wrap justify-end gap-1">
          {turn.attachments.map((image, i) => (
            // Thumbnails have no id and names repeat (every paste is "image.png").
            // biome-ignore lint/suspicious/noArrayIndexKey: the list never reorders
            <li key={i}>
              <Thumbnail src={image.thumbnail} alt={image.name} title={image.name} />
            </li>
          ))}
        </ul>
      )}
      <p className="max-w-7/8 whitespace-pre-wrap break-words rounded-lg bg-accent-soft px-3 py-1.5 text-fg">
        {turn.prompt}
      </p>
    </div>
  )
}

/**
 * `name` is what a designer recognizes: up to two components, innermost last ("Hero › Button"),
 * or the tag when React didn't report any. `where` is the source location, when known.
 */
export function elementLabel(element: ElementContext) {
  const [inner, outer] = element.componentStack
  const name = inner ? (outer ? `${outer} › ${inner}` : inner) : `<${element.tag}>`
  const source = element.source
  const where = source
    ? `${source.file.split('/').at(-1)}:${source.line}${source.approximate ? ' (approx.)' : ''}`
    : null
  return { name, where }
}

function ElementChip({ element }: { element: ElementContext }) {
  const { name, where } = elementLabel(element)
  return (
    <Badge
      icon={MousePointer2}
      title={element.source?.file ?? element.selector}
      className="max-w-7/8"
    >
      <span className="min-w-0 truncate text-fg">{name}</span>
      {where && <span className="min-w-0 truncate font-mono font-normal">{where}</span>}
    </Badge>
  )
}

/** `live` is false once the turn has ended, including turns cut off by a quit. */
function BlockView({
  block,
  next,
  turnId,
  live,
}: {
  block: Block
  /** The block after it, if any */
  next: Block | undefined
  turnId: string
  live: boolean
}) {
  switch (block.kind) {
    case 'text':
      return <Markdown text={block.text} />
    case 'steps': {
      // The card below asks about the step the agent is on, so it speaks for that step.
      const asking = live && next?.kind === 'permission' && next.resolved === null
      return <StepGroup steps={block.steps} live={live} last={!next} asking={asking} />
    }
    case 'plan':
      return (
        <Card tone="inset" className="px-3 py-2">
          <ul aria-label="Plan" className="flex flex-col gap-1">
            {withKeys(block.entries).map(({ key, entry }) => (
              <li key={key} className="flex items-start gap-2 text-small">
                {entry.status === 'completed' ? (
                  <Check className="mt-0.5 size-3 shrink-0 text-success" aria-hidden="true" />
                ) : entry.status === 'in_progress' ? (
                  <CircleDot
                    className="mt-0.5 size-3 shrink-0 text-accent-text"
                    aria-hidden="true"
                  />
                ) : (
                  <Circle className="mt-0.5 size-3 shrink-0 text-subtle" aria-hidden="true" />
                )}
                <span className={cn(entry.status === 'completed' && 'text-muted line-through')}>
                  {entry.content}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )
    case 'permission':
      return <Permission item={block} turnId={turnId} live={live} />
    case 'notice':
      return (
        <Note tone={block.tone} detail={block.detail}>
          {block.text}
        </Note>
      )
  }
}

/** Plan entries have no ids; key by content, numbering repeats. */
function withKeys<T extends { content: string }>(entries: T[]) {
  const seen = new Map<string, number>()
  return entries.map((entry) => {
    const count = seen.get(entry.content) ?? 0
    seen.set(entry.content, count + 1)
    return { key: `${entry.content}#${count}`, entry }
  })
}

/** A line from Gui or the agent beside the conversation: information, or what went wrong. */
function Note({
  tone,
  detail,
  children,
}: {
  tone: 'info' | 'error'
  detail?: string | null
  children: ReactNode
}) {
  const Icon = tone === 'error' ? TriangleAlert : Info
  return (
    <div className="flex flex-col gap-1">
      <p className={cn('flex gap-1.5 text-small', tone === 'error' ? 'text-danger' : 'text-muted')}>
        <Icon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 select-text break-words">{children}</span>
      </p>
      {detail && <TechnicalDetails text={detail} className="pl-5" />}
    </div>
  )
}

function Thought({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col items-start gap-1">
      <Disclosure open={open} onOpenChange={setOpen}>
        Thinking
      </Disclosure>
      {open && <p className="whitespace-pre-wrap pl-4 text-small text-muted">{text}</p>}
    </div>
  )
}

const TOOL_ICONS: Record<string, typeof Wrench> = {
  read: FileText,
  edit: FilePen,
  delete: FilePen,
  move: FilePen,
  search: Search,
  execute: SquareTerminal,
  fetch: Globe,
  think: Brain,
  preview: Eye,
}

/** A path's file name, without the line number Gui adds to locations. */
const fileName = (location: string) => location.replace(/:\d+$/, '').split('/').at(-1) ?? location

/** "Hero.tsx", "Hero.tsx and 2 more"; null without paths. */
function fileNames(locations: string[]) {
  const first = locations[0]
  if (!first) return null
  const more = locations.length - 1
  return more > 0 ? `${fileName(first)} and ${more} more` : fileName(first)
}

/**
 * What a step did, in words a designer reads at a glance. Commands, queries and URLs are
 * the step's detail, shown only in the expanded list. Gui's own tools, and kinds it can't
 * describe better (another server's tools), keep the title they came with.
 */
function stepLabel(tool: ToolItem) {
  const files = fileNames(tool.locations)
  switch (tool.toolKind) {
    case 'read':
      return files ? `Read ${files}` : 'Read files'
    case 'edit':
      return files ? `Edit ${files}` : 'Edit files'
    case 'delete':
      return files ? `Delete ${files}` : 'Delete files'
    case 'move':
      return files ? `Move ${files}` : 'Move files'
    case 'search':
      return 'Search the project'
    case 'execute':
      return 'Run a command'
    case 'fetch':
      return 'Look something up online'
    case 'think':
      return 'Think it through'
    default:
      return tool.title
  }
}

/** The raw part behind a step's label: the command, the query, the paths. */
function stepDetail(tool: ToolItem) {
  switch (tool.toolKind) {
    case 'read':
    case 'edit':
    case 'delete':
    case 'move':
      return tool.locations.length ? tool.locations.join(', ') : tool.title
    case 'search':
    case 'execute':
    case 'fetch':
    case 'think':
      return tool.title
    default:
      return null
  }
}

function isInFlight(tool: ToolItem) {
  return tool.status === 'pending' || tool.status === 'in_progress'
}

/** How long a run of steps took, from the first starting to the last finishing: "12s". */
function stepsDuration(tools: ToolItem[]) {
  const starts = tools.map((tool) => tool.startedAt)
  const ends = tools.map((tool) => tool.endedAt)
  if (starts.some((at) => at === undefined) || ends.some((at) => at == null)) return null
  const ms = Math.max(...(ends as number[])) - Math.min(...(starts as number[]))
  const seconds = Math.round(ms / 1000)
  if (seconds < 1) return null
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function ToolStatusIcon({ tool, live }: { tool: ToolItem; live: boolean }) {
  if (tool.status === 'completed') {
    return <Check className="size-3 shrink-0 text-success" aria-label="Done" />
  }
  if (tool.status === 'failed') {
    return <X className="size-3 shrink-0 text-danger" aria-label="Failed" />
  }
  if (live) return <Spinner className="text-subtle" />
  return <CircleSlash className="size-3 shrink-0 text-subtle" aria-label="Stopped" />
}

/**
 * Steps stay out of the way: the group the agent is working in shows its latest step live,
 * and a finished group folds into "6 steps · 12s". Either opens to the full list. While a
 * permission card right below asks about the latest step, the group shows only its count.
 */
function StepGroup({
  steps,
  live,
  last,
  asking,
}: {
  steps: Step[]
  live: boolean
  last: boolean
  asking: boolean
}) {
  const [open, setOpen] = useState(false)
  const tools = steps.filter((step): step is ToolItem => step.kind === 'tool')
  const latest = tools.at(-1)
  // Thinking with no tool calls around it stays a plain "Thinking" disclosure.
  if (!latest) {
    return (
      <>
        {steps.map((step) =>
          step.kind === 'thought' ? <Thought key={step.id} text={step.text} /> : null,
        )}
      </>
    )
  }
  const failed = tools.filter((tool) => tool.status === 'failed').length
  const failedNote = failed > 0 && <span className="text-danger"> · {failed} failed</span>
  const list = open && <StepList steps={steps} live={live} />
  // Earlier groups of a running turn fold once the agent has moved on.
  const active = live && (last || tools.some(isInFlight))

  if (active && asking && tools.length === 1) return null

  if (active && !asking) {
    const Icon = TOOL_ICONS[latest.toolKind] ?? Wrench
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex h-6 min-w-0 items-center gap-2 text-small">
          <Icon className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
          <span
            className={cn(
              'min-w-0 truncate',
              latest.status === 'failed' ? 'text-danger' : 'text-muted',
            )}
            title={stepDetail(latest) ?? undefined}
          >
            {stepLabel(latest)}
          </span>
          <ToolStatusIcon tool={latest} live={live} />
          {tools.length > 1 && (
            <span className="ml-auto shrink-0">
              <Disclosure open={open} onOpenChange={setOpen}>
                {plural(tools.length, 'step')}
                {failedNote}
              </Disclosure>
            </span>
          )}
        </div>
        {list}
      </div>
    )
  }

  const duration = active ? null : stepsDuration(tools)
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Disclosure open={open} onOpenChange={setOpen}>
        {plural(tools.length, 'step')}
        {duration && <span> · {duration}</span>}
        {failedNote}
      </Disclosure>
      {list}
    </div>
  )
}

function StepList({ steps, live }: { steps: Step[]; live: boolean }) {
  return (
    <Card tone="inset" className="w-full py-1">
      <ul aria-label="Steps" className="flex flex-col">
        {steps.map((step) => {
          if (step.kind === 'thought') {
            return (
              <li key={step.id} className="px-3 py-0.5">
                <Thought text={step.text} />
              </li>
            )
          }
          const Icon = TOOL_ICONS[step.toolKind] ?? Wrench
          const detail = stepDetail(step)
          const failed = step.status === 'failed'
          return (
            <li key={step.id} className="flex h-7 min-w-0 items-center gap-2 px-3 text-small">
              <Icon
                className={cn('size-3.5 shrink-0', failed ? 'text-danger' : 'text-subtle')}
                aria-hidden="true"
              />
              <span className={cn('shrink-0', failed && 'text-danger')}>{stepLabel(step)}</span>
              <span
                className="min-w-0 flex-1 select-text truncate font-mono text-caption text-subtle"
                title={detail ?? undefined}
              >
                {detail}
              </span>
              <ToolStatusIcon tool={step} live={live} />
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

const OPTION_LABELS: Record<string, string> = {
  allow_once: 'Allow',
  allow_always: 'Always allow',
  reject_once: "Don't allow",
  reject_always: 'Never allow',
}

/** What was decided, once it was: an outcome rather than the button's wording. */
const OUTCOME_LABELS: Record<string, string> = {
  allow_once: 'Allowed',
  allow_always: 'Always allowed',
  reject_once: 'Not allowed',
  reject_always: 'Never allowed',
}

/** macOS order, the default last: refusals, anything else, then the allows. */
const OPTION_ORDER: Record<string, number> = {
  reject_always: 0,
  reject_once: 1,
  allow_always: 3,
  allow_once: 4,
}

function optionLabel(option: PermissionChoice) {
  return OPTION_LABELS[option.kind] ?? option.name
}

function byOptionOrder(a: PermissionChoice, b: PermissionChoice) {
  return (OPTION_ORDER[a.kind] ?? 2) - (OPTION_ORDER[b.kind] ?? 2)
}

/** Gui shows paths outside the project in full (or from ~); those inside, relative. */
const isOutside = (location: string) => location.startsWith('/') || location.startsWith('~')

/** The agent's request as a question: "Run a command?", "Edit package.json?". */
function permissionQuestion(toolKind: string, locations: string[]) {
  const files = fileNames(locations)
  const outside = locations.some(isOutside)
  const onFiles = (verb: string) =>
    outside ? `${verb} a file outside the project?` : files ? `${verb} ${files}?` : `${verb} files?`
  switch (toolKind) {
    case 'edit':
      return onFiles('Edit')
    case 'delete':
      return onFiles('Delete')
    case 'move':
      return onFiles('Move')
    case 'read':
      return onFiles('Read')
    case 'search':
      return outside ? 'Search outside the project?' : 'Search the project?'
    case 'execute':
      return 'Run a command?'
    case 'fetch':
      return 'Access the web?'
    default:
      return 'Use a tool?'
  }
}

/** What exactly it would run or touch: the command, the paths, the address. */
function permissionSubject(toolKind: string, title: string, locations: string[]) {
  const onFiles = ['edit', 'delete', 'move', 'read', 'search'].includes(toolKind)
  return onFiles && locations.length ? locations.join('\n') : title
}

/** The answer to a permission request, or why there wasn't one, on one quiet line. */
function PermissionOutcome({ item, subject }: { item: PermissionItem; subject: string }) {
  const chosen = item.options.find((option) => option.optionId === item.resolved)
  // An unanswered request in an ended turn has no agent waiting on it anymore.
  const [Icon, tone, outcome] = !chosen
    ? [CircleSlash, 'text-subtle', item.resolved === null ? 'Expired' : 'Cancelled']
    : chosen.kind.startsWith('allow')
      ? [Check, 'text-success', OUTCOME_LABELS[chosen.kind] ?? chosen.name]
      : [X, 'text-subtle', OUTCOME_LABELS[chosen.kind] ?? chosen.name]
  const firstLine = subject.split('\n')[0]
  return (
    <p className="flex h-6 min-w-0 items-center gap-2 text-small text-muted">
      <Icon className={cn('size-3.5 shrink-0', tone)} aria-hidden="true" />
      <span className="shrink-0">{outcome}</span>
      <span
        className="min-w-0 select-text truncate font-mono text-caption text-subtle"
        title={subject}
      >
        {firstLine}
      </span>
    </p>
  )
}

function Permission({
  item,
  turnId,
  live,
}: {
  item: PermissionItem
  turnId: string
  live: boolean
}) {
  // History saved before these fields existed lacks them.
  const toolKind = item.toolKind ?? 'other'
  const locations = item.locations ?? []
  const subject = permissionSubject(toolKind, item.title, locations)
  if (item.resolved !== null || !live) return <PermissionOutcome item={item} subject={subject} />

  const question = permissionQuestion(toolKind, locations)
  const many = locations.length > 1
  return (
    <Card tone="inset" as="section" aria-label={question} className="flex flex-col gap-3 p-3">
      <div className="flex min-w-0 items-start gap-2">
        <p className="min-w-0 flex-1 break-words font-semibold">{question}</p>
        {item.sensitive && (
          <Badge
            tone="warning"
            icon={TriangleAlert}
            title={
              many
                ? 'These files control how the project builds or runs.'
                : 'This file controls how the project builds or runs.'
            }
            className="shrink-0"
          >
            {many ? 'Sensitive files' : 'Sensitive file'}
          </Badge>
        )}
      </div>
      <pre className="max-h-32 select-text overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-fill px-2 py-1.5 font-mono text-small text-fg">
        {subject}
      </pre>
      {item.sensitive && (
        <p className="sr-only">
          {many
            ? 'These files control how the project builds or runs.'
            : 'This file controls how the project builds or runs.'}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {[...item.options].sort(byOptionOrder).map((option) => (
          <Button
            key={option.optionId}
            variant={option.kind === 'allow_once' ? 'primary' : 'secondary'}
            title={option.name}
            onClick={() => gui.respondPermission(turnId, item.id, option.optionId)}
          >
            {optionLabel(option)}
          </Button>
        ))}
      </div>
    </Card>
  )
}

function Working({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  return (
    <p className="flex h-6 items-center gap-2 text-small text-subtle">
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <Spinner />
      </span>
      Working <span className="tabular-nums">{seconds}s</span>
    </p>
  )
}

/**
 * The picked element before the turn and after hot reload, in frames of the same size.
 * Both images frame the same area, so they line up as they are; when the element changed
 * size, the before image sits where it was inside the after image's larger area (`frame`).
 */
function Comparison({ turn }: { turn: Turn }) {
  const [large, setLarge] = useState(false)
  const preview = turn.preview
  // Without an after image there's nothing to compare yet (or the change wasn't on screen).
  if (!preview?.after) return null
  const shots = [
    { label: 'Before', src: preview.before },
    { label: 'After', src: preview.after },
  ] as const
  return (
    <div
      className={cn(
        'grid gap-2',
        large ? 'grid-cols-1' : 'grid-cols-2',
        turn.reverted && 'opacity-50',
      )}
    >
      {shots.map(
        (shot) =>
          shot.src && (
            <figure key={shot.label} className="flex min-w-0 flex-col gap-1">
              <GroupLabel as="figcaption">{shot.label}</GroupLabel>
              <button
                type="button"
                aria-expanded={large}
                title={large ? 'Show smaller' : 'Show larger'}
                onClick={() => setLarge(!large)}
                className={cn(
                  'flex w-full items-center justify-center overflow-hidden rounded-md border border-line bg-canvas transition-colors hover:border-line-strong',
                  large ? 'h-48' : 'h-24',
                )}
              >
                <Shot
                  src={shot.src}
                  label={shot.label}
                  frame={preview.frame ?? null}
                  before={shot.label === 'Before'}
                />
              </button>
            </figure>
          ),
      )}
    </div>
  )
}

function Shot({
  src,
  label,
  frame,
  before,
}: {
  src: string
  label: string
  frame: PreviewFrame | null
  before: boolean
}) {
  if (!frame) return <img src={src} alt={label} className="size-full object-contain" />
  const area = before ? frame.before : { x: 0, y: 0, width: frame.width, height: frame.height }
  return (
    <svg
      viewBox={`0 0 ${frame.width} ${frame.height}`}
      role="img"
      aria-label={label}
      className="size-full"
    >
      <image
        href={src}
        x={area.x}
        y={area.y}
        width={area.width}
        height={area.height}
        preserveAspectRatio="none"
      />
    </svg>
  )
}

const CHANGE_TONE: Record<FileChange['status'], string> = {
  added: 'text-success',
  modified: 'text-warning',
  deleted: 'text-danger',
}

function ChangedFiles({ changes }: { changes: FileChange[] }) {
  return (
    <ul aria-label="Changed files" className="flex flex-col gap-1 font-mono text-caption">
      {changes.map((change) => (
        <li key={change.path} className="flex min-w-0 items-center gap-2">
          <span className={cn('w-3 shrink-0', CHANGE_TONE[change.status])} title={change.status}>
            {change.status[0].toUpperCase()}
          </span>
          <PathText path={change.path} className="flex-1 text-muted" />
          <span className="shrink-0 text-success tabular-nums">+{change.additions}</span>
          <span className="shrink-0 text-danger tabular-nums">−{change.deletions}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The end of a turn that changed files: how the element looked before and after, what
 * changed, and Undo (Redo once undone).
 */
function Result({ turn, showRedo }: { turn: Turn; showRedo: boolean }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changes = turn.changes ?? []
  const additions = changes.reduce((sum, change) => sum + change.additions, 0)
  const deletions = changes.reduce((sum, change) => sum + change.deletions, 0)

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(readableError(err))
    } finally {
      setBusy(false)
    }
  }

  // Interrupted (e.g. by a quit) before its changes were recorded; it can still be undone.
  const unrecorded = changes.length === 0 && turn.changesUnknown === true && !turn.reverted
  if (changes.length === 0 && !turn.reverted && !unrecorded) return null

  return (
    <Card tone="inset" as="section" aria-label="Result" className="flex flex-col gap-3 p-3">
      <Comparison turn={turn} />
      <div className="flex min-w-0 items-center gap-2">
        {changes.length > 0 ? (
          <Disclosure open={open} onOpenChange={setOpen}>
            {plural(changes.length, 'file')} changed
            <span className="font-mono text-success tabular-nums"> +{additions}</span>
            <span className="font-mono text-danger tabular-nums"> −{deletions}</span>
          </Disclosure>
        ) : (
          unrecorded && <span className="text-small text-muted">Changes not recorded</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {turn.reverted ? (
            <>
              <Badge>Undone</Badge>
              {showRedo && (
                <Button
                  size="sm"
                  icon={Redo2}
                  disabled={busy}
                  onClick={() => run(() => gui.redo())}
                >
                  Redo
                </Button>
              )}
            </>
          ) : (
            <Button
              size="sm"
              icon={Undo2}
              disabled={busy}
              title="Restore files to how they were before this turn (also undoes later turns)"
              onClick={() => run(() => gui.restoreTurn(turn.id))}
            >
              Undo
            </Button>
          )}
        </span>
      </div>
      {open && <ChangedFiles changes={changes} />}
      {error && (
        <p role="alert" className="select-text text-small text-danger">
          {error}
        </p>
      )}
    </Card>
  )
}
