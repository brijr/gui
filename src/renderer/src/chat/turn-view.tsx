import {
  Brain,
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  CircleSlash,
  Crosshair,
  Eye,
  FilePen,
  FileText,
  Globe,
  Info,
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
import { readableError } from '../lib/errors'
import { Button, Spinner, TechnicalDetails } from '../lib/ui'
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
        {turn.status === 'cancelled' && <p className="text-[12px] text-subtle">Stopped</p>}
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
        <ul aria-label="Attached images" className="flex max-w-[88%] flex-wrap justify-end gap-1">
          {turn.attachments.map((image, i) => (
            // Thumbnails have no id and names repeat (every paste is "image.png").
            // biome-ignore lint/suspicious/noArrayIndexKey: the list never reorders
            <li key={i}>
              <img
                src={image.thumbnail}
                alt={image.name}
                title={image.name}
                className="size-14 rounded-md border border-line bg-canvas object-cover"
              />
            </li>
          ))}
        </ul>
      )}
      <p className="max-w-[88%] whitespace-pre-wrap break-words rounded-lg bg-accent-soft px-2.5 py-1.5 text-fg">
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
    <span
      title={element.source?.file ?? element.selector}
      className="inline-flex max-w-[88%] items-center gap-1.5 rounded-md border border-line px-1.5 py-0.5 text-[11px] text-muted"
    >
      <Crosshair className="size-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate text-fg">{name}</span>
      {where && (
        <span className="min-w-0 truncate font-mono text-[10.5px] text-subtle">{where}</span>
      )}
    </span>
  )
}

/** A quiet disclosure for technical text (exit codes, stderr) behind a plain-language message. */

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
        <ul className="flex flex-col gap-1 rounded-lg border border-line px-2.5 py-2">
          {withKeys(block.entries).map(({ key, entry }) => (
            <li key={key} className="flex items-start gap-2 text-[12px]">
              {entry.status === 'completed' ? (
                <Check className="mt-0.5 size-3 shrink-0 text-success" aria-hidden="true" />
              ) : entry.status === 'in_progress' ? (
                <CircleDot className="mt-0.5 size-3 shrink-0 text-accent" aria-hidden="true" />
              ) : (
                <Circle className="mt-0.5 size-3 shrink-0 text-subtle" aria-hidden="true" />
              )}
              <span className={cn(entry.status === 'completed' && 'text-muted line-through')}>
                {entry.content}
              </span>
            </li>
          ))}
        </ul>
      )
    case 'permission':
      return <Permission item={block} turnId={turnId} live={live} />
    case 'notice':
      return (
        <div className="flex flex-col gap-1">
          <p
            className={cn(
              'flex gap-1.5 text-[12px]',
              block.tone === 'error' ? 'text-danger' : 'text-muted',
            )}
          >
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {block.text}
          </p>
          {block.detail && <TechnicalDetails text={block.detail} className="pl-5" />}
        </div>
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

function Thought({ text }: { text: string }) {
  return (
    <details className="group text-[12px] text-subtle">
      <summary className="flex cursor-default list-none items-center gap-1 hover:text-muted">
        <ChevronRight
          className="size-3 transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
        Thinking
      </summary>
      <p className="mt-1 whitespace-pre-wrap pl-4">{text}</p>
    </details>
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
  if (live) return <Spinner className="size-2.5 shrink-0 text-subtle" />
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
        <div className="flex min-w-0 items-center gap-2 text-[12px]">
          <Icon className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
          <span className="min-w-0 truncate text-muted" title={latest.locations.join('\n')}>
            {latest.title}
          </span>
          <ToolStatusIcon tool={latest} live={live} />
          {tools.length > 1 && (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="ml-auto flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[11px] text-subtle hover:bg-hover hover:text-muted"
            >
              <ChevronRight
                className={cn('size-3 transition-transform', open && 'rotate-90')}
                aria-hidden="true"
              />
              {plural(tools.length, 'step')}
              {failedNote}
            </button>
          )}
        </div>
        {list}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 self-start rounded text-[12px] text-subtle hover:text-muted"
      >
        <ChevronRight
          className={cn('size-3 transition-transform', open && 'rotate-90')}
          aria-hidden="true"
        />
        Used {plural(tools.length, 'step')}
        {failedNote}
      </button>
      {list}
    </div>
  )
}

function StepList({ steps, live }: { steps: Step[]; live: boolean }) {
  return (
    <ul className="flex flex-col rounded-lg border border-line py-1">
      {steps.map((tool) => {
        if (tool.kind === 'thought') {
          return (
            <li key={tool.id} className="px-2.5 py-1">
              <Thought text={tool.text} />
            </li>
          )
        }
        const Icon = TOOL_ICONS[tool.toolKind] ?? Wrench
        return (
          <li key={tool.id} className="flex min-w-0 items-center gap-2 px-2.5 py-1 text-[12px]">
            <Icon className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate" title={tool.locations.join('\n')}>
              {tool.title}
            </span>
            <ToolStatusIcon tool={tool} live={live} />
          </li>
        )
      })}
    </ul>
  )
}

const OPTION_LABELS: Record<string, string> = {
  allow_once: 'Allow',
  allow_always: 'Always allow',
  reject_once: "Don't allow",
  reject_always: 'Never allow',
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
  const chosen = item.options.find((option) => option.optionId === item.resolved)
  // An unanswered request in an ended turn has no agent waiting on it anymore.
  const outcome = chosen ? optionLabel(chosen) : item.resolved === null ? 'Expired' : 'Cancelled'
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line-strong bg-surface px-2.5 py-2">
      <div className="flex flex-col gap-1">
        <p className="text-[12px]">
          <span className="text-muted">The agent wants to: </span>
          <span className="font-medium" title={locations.join('\n') || undefined}>
            {permissionSummary(toolKind, locations)}
          </span>
        </p>
        {sensitive && (
          <p className="flex gap-1.5 text-[12px] text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            {locations.length > 1
              ? 'These files control how the project builds or runs.'
              : 'This file controls how the project builds or runs.'}
          </p>
        )}
        <p className="select-text break-words font-mono text-[11px] text-subtle">{item.title}</p>
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
        <p className="text-[12px] text-subtle">{outcome}</p>
      )}
    </div>
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
    <p className="flex items-center gap-2 text-[12px] text-subtle">
      <Spinner className="size-2.5" />
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
      <figcaption className="text-[11px] text-subtle">{label}</figcaption>
      <button
        type="button"
        aria-expanded={large}
        title={large ? 'Show smaller' : 'Show larger'}
        onClick={() => setLarge(!large)}
        className="block overflow-hidden rounded-md border border-line bg-canvas hover:border-line-strong"
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
        <div className="flex items-center gap-1 text-[11.5px] text-muted">
          {changes.length > 0 && (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-hover hover:text-fg"
            >
              <ChevronRight
                className={cn('size-3 transition-transform', open && 'rotate-90')}
                aria-hidden="true"
              />
              {changes.length} {changes.length === 1 ? 'file' : 'files'} changed
              <span className="font-mono text-success tabular-nums">+{additions}</span>
              <span className="font-mono text-danger tabular-nums">−{deletions}</span>
            </button>
          )}
          {unrecorded && <span className="px-1 py-0.5 text-subtle">Changes not recorded</span>}
          <span className="ml-auto flex items-center gap-1">
            {turn.reverted ? (
              <>
                <span className="text-subtle">Undone</span>
                {showRedo && (
                  <Button variant="ghost" disabled={busy} onClick={() => run(() => gui.redo())}>
                    <Redo2 className="size-3" aria-hidden="true" />
                    Redo
                  </Button>
                )}
              </>
            ) : (
              <Button
                variant="ghost"
                disabled={busy}
                title="Restore files to how they were before this turn (also undoes later turns)"
                onClick={() => run(() => gui.restoreTurn(turn.id))}
              >
                <Undo2 className="size-3" aria-hidden="true" />
                Undo
              </Button>
            )}
          </span>
        </div>
      )}
      {open && (
        <ul className="flex flex-col gap-0.5 pl-5 font-mono text-[11px]">
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
              <span className="min-w-0 flex-1 truncate" title={change.path}>
                {change.path}
              </span>
              <span className="text-success tabular-nums">+{change.additions}</span>
              <span className="text-danger tabular-nums">−{change.deletions}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-[12px] text-danger">{error}</p>}
    </div>
  )
}
