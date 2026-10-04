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
import { useEffect, useState } from 'react'
import type { ElementContext, PermissionChoice, Turn, TurnItem } from '../../../shared/types'
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

export function TurnView({ turn, showRedo }: { turn: Turn; showRedo: boolean }) {
  const blocks = toBlocks(turn.items)
  return (
    <article className="flex flex-col gap-2.5">
      <UserMessage turn={turn} />
      <div className={cn('flex flex-col gap-2.5', turn.reverted && 'opacity-45')}>
        {blocks.map((block, index) => (
          <BlockView
            key={block.id}
            block={block}
            turnId={turn.id}
            live={turn.status === 'running'}
            last={index === blocks.length - 1}
          />
        ))}
        {turn.status === 'running' && <Working since={turn.startedAt} />}
        {turn.status === 'error' && (
          <div className="flex flex-col gap-1">
            <p className="flex gap-1.5 text-danger">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-words">{turn.error}</span>
            </p>
            {turn.errorDetail && <TechnicalDetails text={turn.errorDetail} className="pl-5" />}
          </div>
        )}
        {turn.status === 'cancelled' && <p className="text-small text-subtle">Stopped</p>}
      </div>
      {turn.status !== 'running' && <TurnFooter turn={turn} showRedo={showRedo} />}
    </article>
  )
}

function UserMessage({ turn }: { turn: Turn }) {
  return (
    <div className="flex flex-col items-end gap-1">
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
      <p className="max-w-7/8 whitespace-pre-wrap break-words rounded-lg bg-accent-soft px-2.5 py-1.5 text-fg">
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
  turnId,
  live,
  last,
}: {
  block: Block
  turnId: string
  live: boolean
  last: boolean
}) {
  switch (block.kind) {
    case 'text':
      return <Markdown text={block.text} />
    case 'steps':
      return <StepGroup steps={block.steps} live={live} last={last} />
    case 'plan':
      return (
        <Card tone="inset" className="px-2.5 py-2">
          <ul className="flex flex-col gap-1">
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
    case 'notice': {
      const Icon = block.tone === 'error' ? TriangleAlert : Info
      return (
        <div className="flex flex-col gap-1">
          <p
            className={cn(
              'flex gap-1.5 text-small',
              block.tone === 'error' ? 'text-danger' : 'text-muted',
            )}
          >
            <Icon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            {block.text}
          </p>
          {block.detail && <TechnicalDetails text={block.detail} className="pl-5" />}
        </div>
      )
    }
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

function isInFlight(tool: ToolItem) {
  return tool.status === 'pending' || tool.status === 'in_progress'
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
 * Steps stay out of the way: the group the agent is working in shows only its latest step, and
 * finished groups collapse to a summary. Either expands to the full list.
 */
function StepGroup({ steps, live, last }: { steps: Step[]; live: boolean; last: boolean }) {
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
  const failedNote = failed > 0 && <span className="text-danger">· {failed} failed</span>
  const list = open && <StepList steps={steps} live={live} />
  // Earlier groups of a running turn collapse once the agent has moved on.
  const active = live && (last || tools.some(isInFlight))

  if (active) {
    const Icon = TOOL_ICONS[latest.toolKind] ?? Wrench
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2 text-small">
          <Icon className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
          <span className="min-w-0 truncate text-muted" title={latest.locations.join('\n')}>
            {latest.title}
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

  return (
    <div className="flex flex-col items-start gap-1.5">
      <Disclosure open={open} onOpenChange={setOpen}>
        Used {plural(tools.length, 'step')}
        {failedNote}
      </Disclosure>
      {list}
    </div>
  )
}

function StepList({ steps, live }: { steps: Step[]; live: boolean }) {
  return (
    <Card tone="inset" className="w-full py-1">
      <ul className="flex flex-col">
        {steps.map((tool) => {
          if (tool.kind === 'thought') {
            return (
              <li key={tool.id} className="px-2.5 py-0.5">
                <Thought text={tool.text} />
              </li>
            )
          }
          const Icon = TOOL_ICONS[tool.toolKind] ?? Wrench
          return (
            <li key={tool.id} className="flex min-w-0 items-center gap-2 px-2.5 py-1 text-small">
              <Icon className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate" title={tool.locations.join('\n')}>
                {tool.title}
              </span>
              <ToolStatusIcon tool={tool} live={live} />
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

function optionLabel(option: PermissionChoice) {
  return OPTION_LABELS[option.kind] ?? option.name
}

/** What the agent wants to do, in plain words, e.g. "Change Hero.tsx and 2 more". */
function permissionSummary(toolKind: string, locations: string[]) {
  const first = locations[0]?.split('/').at(-1)
  const files = first
    ? locations.length > 1
      ? `${first} and ${locations.length - 1} more`
      : first
    : 'files'
  switch (toolKind) {
    case 'edit':
      return `Change ${files}`
    case 'delete':
      return `Delete ${files}`
    case 'move':
      return `Move ${files}`
    case 'read':
      return `Read ${files}`
    case 'execute':
      return 'Run a command'
    case 'fetch':
      return 'Access the web'
    default:
      return 'Use a tool'
  }
}

/** The answer to a permission request, or why there wasn't one. */
function PermissionOutcome({ item }: { item: PermissionItem }) {
  const chosen = item.options.find((option) => option.optionId === item.resolved)
  if (!chosen) {
    // An unanswered request in an ended turn has no agent waiting on it anymore.
    return (
      <p className="flex items-center gap-1 text-small text-muted">
        <CircleSlash className="size-3 shrink-0 text-subtle" aria-hidden="true" />
        {item.resolved === null ? 'Expired' : 'Cancelled'}
      </p>
    )
  }
  const allowed = chosen.kind.startsWith('allow')
  return (
    <p className="flex items-center gap-1 text-small text-muted">
      {allowed ? (
        <Check className="size-3 shrink-0 text-success" aria-hidden="true" />
      ) : (
        <X className="size-3 shrink-0 text-subtle" aria-hidden="true" />
      )}
      {OUTCOME_LABELS[chosen.kind] ?? chosen.name}
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
  const sensitive = item.sensitive ?? false
  return (
    <Card tone="inset" className="flex flex-col gap-2 px-2.5 py-2">
      <div className="flex flex-col gap-1">
        <p className="text-small">
          <span className="text-muted">The agent wants to: </span>
          <span className="font-medium" title={locations.join('\n') || undefined}>
            {permissionSummary(toolKind, locations)}
          </span>
        </p>
        {sensitive && (
          <p className="flex gap-1.5 text-small text-warning">
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
            {locations.length > 1
              ? 'These files control how the project builds or runs.'
              : 'This file controls how the project builds or runs.'}
          </p>
        )}
        <p className="select-text break-words font-mono text-caption text-subtle">{item.title}</p>
      </div>
      {item.resolved === null && live ? (
        <div className="flex flex-wrap gap-1.5">
          {item.options.map((option) => (
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
      ) : (
        <PermissionOutcome item={item} />
      )}
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
    <p className="flex items-center gap-2 text-small text-subtle">
      <Spinner />
      Working <span className="tabular-nums">{seconds}s</span>
    </p>
  )
}

/** The picked element before the turn and after hot reload; either may be missing. */
function BeforeAfter({ turn }: { turn: Turn }) {
  const shots = [
    { label: 'Before', src: turn.preview?.before },
    { label: 'After', src: turn.preview?.after },
  ].filter((shot): shot is { label: string; src: string } => Boolean(shot.src))
  if (shots.length === 0) return null
  return (
    <div className={cn('grid grid-cols-2 gap-2', turn.reverted && 'opacity-45')}>
      {shots.map((shot) => (
        <Shot key={shot.label} label={shot.label} src={shot.src} />
      ))}
    </div>
  )
}

function Shot({ label, src }: { label: string; src: string }) {
  const [large, setLarge] = useState(false)
  return (
    <figure className={cn('flex min-w-0 flex-col gap-1', large && 'col-span-2')}>
      <GroupLabel as="figcaption">{label}</GroupLabel>
      <button
        type="button"
        aria-expanded={large}
        title={large ? 'Show smaller' : 'Show larger'}
        onClick={() => setLarge(!large)}
        className="block overflow-hidden rounded-lg border border-line bg-canvas transition-colors hover:border-line-strong"
      >
        <img
          src={src}
          alt={label}
          className={cn('block w-full object-contain', large ? 'h-auto max-h-120' : 'h-24')}
        />
      </button>
    </figure>
  )
}

function TurnFooter({ turn, showRedo }: { turn: Turn; showRedo: boolean }) {
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
  const hasRow = changes.length > 0 || turn.reverted || unrecorded
  const hasPreview = Boolean(turn.preview?.before || turn.preview?.after)

  if (!hasRow && !hasPreview) return null

  return (
    <div className="flex flex-col gap-1.5">
      <BeforeAfter turn={turn} />
      {hasRow && (
        <div className="flex items-center gap-1 text-small text-muted">
          {changes.length > 0 && (
            <Disclosure open={open} onOpenChange={setOpen}>
              {changes.length} {changes.length === 1 ? 'file' : 'files'} changed
              <span className="font-mono text-success tabular-nums">+{additions}</span>
              <span className="font-mono text-danger tabular-nums">−{deletions}</span>
            </Disclosure>
          )}
          {unrecorded && <span className="text-subtle">Changes not recorded</span>}
          <span className="ml-auto flex items-center gap-1">
            {turn.reverted ? (
              <>
                <span className="text-subtle">Undone</span>
                {showRedo && (
                  <Button
                    variant="ghost"
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
                variant="ghost"
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
      )}
      {open && (
        <ul className="flex flex-col gap-0.5 pl-4 font-mono text-caption">
          {changes.map((change) => (
            <li key={change.path} className="flex items-center gap-2">
              <span
                className={cn(
                  'w-3 shrink-0',
                  change.status === 'added' && 'text-success',
                  change.status === 'deleted' && 'text-danger',
                  change.status === 'modified' && 'text-warning',
                )}
              >
                {change.status[0].toUpperCase()}
              </span>
              <PathText path={change.path} className="flex-1" />
              <span className="text-success tabular-nums">+{change.additions}</span>
              <span className="text-danger tabular-nums">−{change.deletions}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-small text-danger">{error}</p>}
    </div>
  )
}
