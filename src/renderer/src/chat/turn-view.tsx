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
import type { ElementContext, Turn, TurnItem } from '../../../shared/types'
import { grat } from '../lib/api'
import { cn } from '../lib/cn'
import { Button, Spinner } from '../lib/ui'
import { Markdown } from './markdown'

type ToolItem = Extract<TurnItem, { kind: 'tool' }>
type Block = { kind: 'tools'; id: string; tools: ToolItem[] } | Exclude<TurnItem, ToolItem>

/** Consecutive tool calls render as one compact group. */
function toBlocks(items: TurnItem[]): Block[] {
  const blocks: Block[] = []
  for (const item of items) {
    if (item.kind !== 'tool') {
      blocks.push(item)
      continue
    }
    const last = blocks.at(-1)
    if (last?.kind === 'tools') last.tools.push(item)
    else blocks.push({ kind: 'tools', id: item.id, tools: [item] })
  }
  return blocks
}

export function TurnView({ turn, showRedo }: { turn: Turn; showRedo: boolean }) {
  return (
    <article className="flex flex-col gap-2.5">
      <UserMessage turn={turn} />
      <div className={cn('flex flex-col gap-2.5', turn.reverted && 'opacity-45')}>
        {toBlocks(turn.items).map((block) => (
          <BlockView
            key={block.id}
            block={block}
            turnId={turn.id}
            live={turn.status === 'running'}
          />
        ))}
        {turn.status === 'running' && <Working since={turn.startedAt} />}
        {turn.status === 'error' && (
          <p className="flex gap-1.5 text-danger">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">{turn.error}</span>
          </p>
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
      <p className="max-w-[88%] whitespace-pre-wrap break-words rounded-lg bg-accent-soft px-2.5 py-1.5 text-fg">
        {turn.prompt}
      </p>
    </div>
  )
}

export function elementLabel(element: ElementContext) {
  const where = element.source
    ? `${element.source.file.split('/').at(-1)}:${element.source.line}`
    : element.componentStack[0]
  return { tag: `<${element.tag}>`, where }
}

function ElementChip({ element }: { element: ElementContext }) {
  const { tag, where } = elementLabel(element)
  return (
    <span
      title={element.source?.file ?? element.selector}
      className="inline-flex max-w-[88%] items-center gap-1 rounded-md border border-line px-1.5 py-0.5 font-mono text-[10.5px] text-muted"
    >
      <Crosshair className="size-3 shrink-0" aria-hidden="true" />
      <span className="text-fg">{tag}</span>
      {where && <span className="truncate">{where}</span>}
    </span>
  )
}

/** `live` is false once the turn has ended, including turns cut off by a quit. */
function BlockView({ block, turnId, live }: { block: Block; turnId: string; live: boolean }) {
  switch (block.kind) {
    case 'text':
      return <Markdown text={block.text} />
    case 'thought':
      return <Thought text={block.text} />
    case 'tools':
      return <ToolGroup tools={block.tools} live={live} />
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
        <p
          className={cn(
            'flex gap-1.5 text-[12px]',
            block.tone === 'error' ? 'text-danger' : 'text-muted',
          )}
        >
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {block.text}
        </p>
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

function ToolGroup({ tools, live }: { tools: ToolItem[]; live: boolean }) {
  return (
    <ul className="flex flex-col rounded-lg border border-line py-1">
      {tools.map((tool) => {
        const Icon = TOOL_ICONS[tool.toolKind] ?? Wrench
        return (
          <li key={tool.id} className="flex min-w-0 items-center gap-2 px-2.5 py-1 text-[12px]">
            <Icon className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate" title={tool.locations.join('\n')}>
              {tool.title}
            </span>
            {tool.status === 'completed' ? (
              <Check className="size-3 shrink-0 text-success" aria-label="Done" />
            ) : tool.status === 'failed' ? (
              <X className="size-3 shrink-0 text-danger" aria-label="Failed" />
            ) : live ? (
              <Spinner className="size-2.5 shrink-0 text-subtle" />
            ) : (
              <CircleSlash className="size-3 shrink-0 text-subtle" aria-label="Stopped" />
            )}
          </li>
        )
      })}
    </ul>
  )
}

function Permission({
  item,
  turnId,
  live,
}: {
  item: Extract<TurnItem, { kind: 'permission' }>
  turnId: string
  live: boolean
}) {
  const chosen = item.options.find((option) => option.optionId === item.resolved)
  // An unanswered request in an ended turn has no agent waiting on it anymore.
  const outcome = chosen ? chosen.name : item.resolved === null ? 'Expired' : 'Cancelled'
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line-strong bg-surface px-2.5 py-2">
      <p className="text-[12px]">
        <span className="text-muted">Allow </span>
        <span className="font-medium">{item.title}</span>
        <span className="text-muted">?</span>
      </p>
      {item.resolved === null && live ? (
        <div className="flex flex-wrap gap-1.5">
          {item.options.map((option) => (
            <Button
              key={option.optionId}
              variant={option.kind === 'allow_once' ? 'primary' : 'secondary'}
              onClick={() => grat.respondPermission(turnId, item.id, option.optionId)}
            >
              {option.name}
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
      setError(
        err instanceof Error
          ? err.message.replace(/^Error invoking remote method '[^']+': /, '')
          : String(err),
      )
    } finally {
      setBusy(false)
    }
  }

  // Interrupted (e.g. by a quit) before its changes were recorded; it can still be undone.
  const unrecorded = changes.length === 0 && turn.changesUnknown === true && !turn.reverted

  if (changes.length === 0 && !turn.reverted && !unrecorded) return null

  return (
    <div className="flex flex-col gap-1.5">
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
                <Button variant="ghost" disabled={busy} onClick={() => run(() => grat.redo())}>
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
              onClick={() => run(() => grat.restoreTurn(turn.id))}
            >
              <Undo2 className="size-3" aria-hidden="true" />
              Undo
            </Button>
          )}
        </span>
      </div>
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
