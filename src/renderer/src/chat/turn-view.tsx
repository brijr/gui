import { type ReactNode, useEffect, useState } from 'react'
import type { ShortcutId } from '../../../shared/shortcuts'
import {
  isRegion,
  type PermissionChoice,
  type Picked,
  type PreviewFrame,
  type SourceLocation,
  type Turn,
  type TurnItem,
} from '../../../shared/types'
import { gui } from '../lib/api'
import { ChangedFiles } from '../lib/changed-files'
import { cn } from '../lib/cn'
import { Disclosure, REVEAL, TechnicalDetails } from '../lib/disclosure'
import { readableError } from '../lib/errors'
import { InlineError } from '../lib/field'
import {
  Brain,
  Check,
  Circle,
  CircleDot,
  CircleSlash,
  Crop,
  Eye,
  FilePen,
  FileText,
  Globe,
  Hand,
  Info,
  MousePointer2,
  Redo2,
  Reply,
  Search,
  SquareTerminal,
  TriangleAlert,
  Undo2,
  Wrench,
  X,
} from '../lib/icons'
import { Badge } from '../lib/status'
import { Card, GroupLabel, Thumbnail } from '../lib/surface'
import { Button, PRESS, Spinner, Toggle } from '../lib/ui'
import { Markdown } from './markdown'
import { RecordingClip } from './recording-clip'
import { setFollowUp, useChat, waitingCard } from './store'
import { isNewRow, markSeen } from './transitions'
import { TurnPresentationScope, useTurnPresentation } from './turn-presentation'

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
  // The agent can't go on until a question it asked is answered.
  const waiting =
    running && turn.items.some((item) => item.kind === 'permission' && item.resolved === null)
  const end = `${turn.id}:end`
  const agent = useChat((s) => s.meta?.agentName ?? 'Agent')
  return (
    <TurnPresentationScope id={turn.id}>
      <article className="flex flex-col gap-3">
        {/* Who said what, for a screen reader; its heading keys step from message to message. */}
        <Row rowKey={`${turn.id}:user`}>
          <h3 className="sr-only">You</h3>
          <UserMessage turn={turn} />
        </Row>
        {/* Undone: dimmed, but still readable; the result's "Undone" badge says why. */}
        <div className={cn('flex flex-col gap-3', turn.reverted && UNDONE)}>
          <h3 className="sr-only">{agent}</h3>
          {blocks.map((block, index) => (
            <Row key={block.id} rowKey={block.id}>
              <BlockView
                block={block}
                next={blocks[index + 1]}
                turnId={turn.id}
                live={running}
                turnEnd={turn.endedAt}
              />
            </Row>
          ))}
          {running && (waiting ? <Waiting /> : <Working since={turn.startedAt} />)}
          {turn.status === 'error' && (
            <Row rowKey={end}>
              <Note tone="error" detail={turn.errorDetail} stateKey="error" announce={end}>
                {turn.error}
              </Note>
              {turn.signIn && <SignInAgain />}
            </Row>
          )}
          {turn.status === 'cancelled' && (
            <Row rowKey={end}>
              <Badge icon={CircleSlash} className="self-start">
                Stopped
              </Badge>
            </Row>
          )}
        </div>
        {!running && (
          <Row rowKey={end}>
            <Result turn={turn} showRedo={showRedo} />
          </Row>
        )}
      </article>
    </TurnPresentationScope>
  )
}

/** An undone turn's look: dimmed, at a contrast its secondary text still reads at. */
const UNDONE = 'opacity-70'

/**
 * A row of the transcript. It fades up once, when it first appears while the user watches;
 * not when history loads or the panel comes back, and not as streaming text grows in it.
 * Decided when it mounts, so later renders never cut the fade short.
 */
function Row({ rowKey, children }: { rowKey: string; children: ReactNode }) {
  const [fresh] = useState(() => isNewRow(rowKey))
  useEffect(() => markSeen([rowKey]), [rowKey])
  return (
    <div
      className={cn(
        'flex flex-col gap-3 empty:hidden',
        fresh && 'animate-row-in motion-reduce:animate-row-fade',
      )}
    >
      {children}
    </div>
  )
}

function UserMessage({ turn }: { turn: Turn }) {
  return (
    <div className="flex flex-col items-end gap-1.5">
      {turn.context.length > 0 && (
        <ul aria-label="Selected" className="flex max-w-7/8 flex-wrap justify-end gap-1">
          {turn.context.map((picked) => (
            <li key={picked.id} className="min-w-0">
              <PickedChip picked={picked} />
            </li>
          ))}
        </ul>
      )}
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
      {turn.recordings?.map((clip) => (
        <RecordingClip key={clip.id} clip={clip} />
      ))}
      {turn.followUp && (
        <p
          className="flex max-w-7/8 min-w-0 items-center gap-1.5 text-caption text-subtle"
          title={turn.followUp.prompt}
        >
          <Reply className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">Following up on “{turn.followUp.prompt}”</span>
        </p>
      )}
      <p
        data-user-message={turn.id}
        className="max-w-7/8 whitespace-pre-wrap break-words rounded-lg bg-fill px-3 py-1.5 text-fg"
      >
        {turn.prompt}
      </p>
    </div>
  )
}

/** What a designer calls it: up to two components, innermost last ("Hero › Button"), or the tag. */
function componentName(componentStack: string[], tag: string) {
  const [inner, outer] = componentStack
  if (inner) return outer ? `${outer} › ${inner}` : inner
  if (/^h[1-6]$/.test(tag)) return 'Heading'
  const names: Record<string, string> = {
    a: 'Link',
    button: 'Button',
    img: 'Image',
    p: 'Paragraph',
    span: 'Text',
    input: 'Input',
    textarea: 'Text field',
    select: 'Dropdown',
    nav: 'Navigation',
    section: 'Section',
    ul: 'List',
    ol: 'List',
    li: 'List item',
  }
  return names[tag] ?? 'Element'
}

function sourceLabel(source: SourceLocation | null) {
  if (!source) return null
  return `${source.file.split('/').at(-1)}:${source.line}${source.approximate ? ' (approx.)' : ''}`
}

/**
 * How a pick is named in the chat. An element: its component (`name`), its text (`detail`),
 * and its source location (`where`). An area: its size, and the component and source of what
 * it's in. `title` is the full path, for a tooltip.
 */
export function pickLabel(picked: Picked) {
  if (isRegion(picked)) {
    const { rect, container } = picked
    const size = `${Math.round(rect.width)} × ${Math.round(rect.height)}`
    const inside = container ? componentName(container.componentStack, container.tag) : null
    const source = sourceLabel(container?.source ?? null)
    return {
      name: 'Area',
      detail: size,
      where: inside ? `in ${inside}${source ? ` · ${source}` : ''}` : null,
      title: container?.source?.file ?? container?.selector,
    }
  }
  return {
    name: componentName(picked.componentStack, picked.tag),
    detail: picked.text ? picked.text.slice(0, 60) : null,
    where: sourceLabel(picked.source),
    title: picked.source?.file ?? picked.selector,
  }
}

function PickedChip({ picked }: { picked: Picked }) {
  const { name, detail, where, title } = pickLabel(picked)
  const region = isRegion(picked)
  const Icon = region ? Crop : MousePointer2
  return (
    // A neutral badge's look, but only the name takes the label weight: the size and the
    // source after it are detail, at body weight.
    <span
      title={title}
      className="inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded-sm bg-fill px-1.5 text-caption text-muted"
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate font-medium text-fg">{name}</span>
      {region && detail && <span className="shrink-0 tabular-nums">{detail}</span>}
      {!region && picked.source && where && (
        <span className="min-w-0 truncate font-mono">{where}</span>
      )}
    </span>
  )
}

/** `live` is false once the turn has ended, including turns cut off by a quit. */
function BlockView({
  block,
  next,
  turnId,
  live,
  turnEnd,
}: {
  block: Block
  /** The block after it, if any */
  next: Block | undefined
  turnId: string
  live: boolean
  turnEnd: number | null
}) {
  switch (block.kind) {
    case 'text':
      return <Markdown text={block.text} live={live} />
    case 'steps': {
      // The card below asks about the step the agent is on, so it speaks for that step.
      const asking = live && next?.kind === 'permission' && next.resolved === null
      return (
        <StepGroup
          stateKey={block.id}
          steps={block.steps}
          live={live}
          last={!next}
          asking={asking}
          turnEnd={turnEnd}
        />
      )
    }
    case 'plan':
      return (
        // A compact card: a short list, not a block of prose.
        <Card tone="inset" padding="compact">
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
        <Note tone={block.tone} detail={block.detail} stateKey={block.id}>
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

/**
 * What sits under a note's text lines up with the text, past its 14px icon and 6px gap. The
 * composer's problems use the same inset.
 */
export const NOTE_INSET = 'pl-5'

/** A line from Gui or the agent beside the conversation: information, or what went wrong. */
function Note({
  tone,
  detail,
  stateKey,
  announce,
  children,
}: {
  tone: 'info' | 'error'
  detail?: string | null
  stateKey: string
  /**
   * Its row's key, to read it out to screen readers when it appears while the user is here
   * (not from history, nor when scrolled back into view)
   */
  announce?: string
  children: ReactNode
}) {
  const details = useTurnPresentation(`details:${stateKey}`, false)
  // Decided when it mounts, as a row's fade is (Row marks the key seen).
  const [fresh] = useState(() => announce !== undefined && isNewRow(announce))
  const Icon = tone === 'error' ? TriangleAlert : Info
  return (
    <div className="flex flex-col gap-1">
      <p
        role={fresh ? 'alert' : undefined}
        className={cn('flex gap-1.5 text-small', tone === 'error' ? 'text-danger' : 'text-muted')}
      >
        <Icon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 select-text break-words">{children}</span>
      </p>
      {detail && <TechnicalDetails text={detail} className={NOTE_INSET} state={details} />}
    </div>
  )
}

/** After the agent's login expired: signs in again here, rather than leaving the chat stuck. */
function SignInAgain() {
  const [state, setState] = useTurnPresentation<'idle' | 'pending' | 'done' | 'failed'>(
    'sign-in',
    'idle',
  )
  if (state === 'done') {
    return (
      <p className={cn('flex gap-1.5 text-small text-success', NOTE_INSET)}>
        <Check className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        Signed in. Send your message again.
      </p>
    )
  }
  return (
    <div className={cn('flex flex-col items-start gap-1.5', NOTE_INSET)}>
      <Button
        variant="primary"
        loading={state === 'pending'}
        onClick={() => {
          setState('pending')
          gui.signInAgain().then(
            (signedIn) => setState(signedIn ? 'done' : 'failed'),
            () => setState('failed'),
          )
        }}
      >
        {state === 'pending' ? 'Signing in…' : 'Sign in'}
      </Button>
      {state === 'pending' && (
        <p className="text-small text-muted">Continue in your browser to sign in.</p>
      )}
      {state === 'failed' && (
        <InlineError>Not signed in yet. Try again, or sign in from Settings → Agents.</InlineError>
      )}
    </div>
  )
}

function Thought({ id, text }: { id: string; text: string }) {
  const [open, setOpen] = useTurnPresentation(`thought:${id}`, false)
  return (
    <div className="flex flex-col items-start gap-1">
      <Disclosure open={open} onOpenChange={setOpen}>
        Thinking
      </Disclosure>
      {open && (
        <p className={cn(REVEAL, 'whitespace-pre-wrap pl-4 text-small text-muted')}>{text}</p>
      )}
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

/**
 * How long a run of steps took, from the first starting to the last finishing: "12s".
 * Steps that never finished (the turn was stopped) end when the turn did.
 */
function stepsDuration(tools: ToolItem[], turnEnd: number | null) {
  const starts = tools.map((tool) => tool.startedAt)
  const ends = tools.map((tool) => tool.endedAt ?? turnEnd)
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
  stateKey,
  steps,
  live,
  last,
  asking,
  turnEnd,
}: {
  stateKey: string
  steps: Step[]
  live: boolean
  last: boolean
  asking: boolean
  /** When the turn ended; null while it runs */
  turnEnd: number | null
}) {
  const [open, setOpen] = useTurnPresentation(`steps:${stateKey}`, false)
  const tools = steps.filter((step): step is ToolItem => step.kind === 'tool')
  const latest = tools.at(-1)
  // Thinking with no tool calls around it stays a plain "Thinking" disclosure.
  if (!latest) {
    return (
      <>
        {steps.map((step) =>
          step.kind === 'thought' ? <Thought key={step.id} id={step.id} text={step.text} /> : null,
        )}
      </>
    )
  }
  const failed = tools.filter((tool) => tool.status === 'failed').length
  const failedNote = failed > 0 && (
    <span className="text-danger tabular-nums"> · {failed} failed</span>
  )
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
            key={latest.id}
            className={cn(
              'min-w-0 truncate motion-safe:animate-fade-in motion-reduce:animate-row-fade',
              latest.status === 'failed' ? 'text-danger' : 'text-muted',
            )}
            title={stepDetail(latest) ?? undefined}
          >
            {stepLabel(latest)}
          </span>
          <ToolStatusIcon tool={latest} live={live} />
          {tools.length > 1 && (
            <span className="ml-auto shrink-0">
              <Disclosure
                open={open}
                onOpenChange={setOpen}
                className="whitespace-nowrap tabular-nums"
              >
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

  const duration = active ? null : stepsDuration(tools, turnEnd)
  return (
    <div className="flex flex-col items-start gap-1.5">
      <Disclosure open={open} onOpenChange={setOpen}>
        <span className="tabular-nums">{plural(tools.length, 'step')}</span>
        {duration && <span className="tabular-nums"> · {duration}</span>}
        {failedNote}
      </Disclosure>
      {list}
    </div>
  )
}

function StepList({ steps, live }: { steps: Step[]; live: boolean }) {
  return (
    <Card tone="inset" padding="none" className={cn(REVEAL, 'w-full')}>
      <ul aria-label="Steps" className="flex flex-col py-1">
        {steps.map((step) => {
          if (step.kind === 'thought') {
            return (
              <li key={step.id} className="px-3 py-0.5">
                <Thought id={step.id} text={step.text} />
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
              {/* A long label (another server's tool name) truncates rather than pushing the row wide. */}
              <span
                className={cn('max-w-full min-w-0 truncate', failed && 'text-danger')}
                title={stepLabel(step)}
              >
                {stepLabel(step)}
              </span>
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
  reject_once: 'Don’t allow',
  reject_always: 'Never allow',
}

/** What was decided, once it was: an outcome rather than the button's wording. */
const OUTCOME_LABELS: Record<string, string> = {
  allow_once: 'Allowed',
  allow_always: 'Always allowed',
  reject_once: 'Not allowed',
  reject_always: 'Never allowed',
}

/** The keys that answer the oldest waiting card, on its buttons (Agent → Allow, Don't Allow). */
const OPTION_SHORTCUTS: Partial<Record<string, ShortcutId>> = {
  allow_once: 'allow',
  reject_once: 'dontAllow',
}

/** macOS order, the default last: refusals, anything else, then the allows. */
const OPTION_ORDER: Record<string, number> = {
  reject_always: 0,
  reject_once: 1,
  allow_always: 3,
  allow_once: 4,
}

/** Past this many characters, an option won't fit half a narrow card: the options stack. */
const LONG_OPTION = 24

/** An agent's own question keeps its wording ("Skip", its choices), not Allow / Don't allow. */
function optionLabel(option: PermissionChoice, asked: boolean) {
  return (asked ? null : OPTION_LABELS[option.kind]) ?? option.name
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
    ? [CircleSlash, 'text-subtle', item.resolved === null ? 'Expired' : 'Stopped']
    : item.toolKind === 'question'
      ? chosen.kind === 'answer'
        ? [Check, 'text-success', chosen.name]
        : [X, 'text-subtle', 'Skipped']
      : chosen.kind.startsWith('allow')
        ? [Check, 'text-success', OUTCOME_LABELS[chosen.kind] ?? chosen.name]
        : [X, 'text-subtle', OUTCOME_LABELS[chosen.kind] ?? chosen.name]
  const firstLine = subject.split('\n')[0]
  return (
    <p
      data-permission={item.id}
      className="flex h-6 min-w-0 items-center gap-2 text-small text-muted"
    >
      <Icon className={cn('size-3.5 shrink-0', tone)} aria-hidden="true" />
      {/* An agent's own answer can be a sentence: it truncates, whole in the tooltip. */}
      <span className="max-w-full min-w-0 truncate" title={outcome}>
        {outcome}
      </span>
      {/* What was asked about gives way first: the answer is what to read. */}
      <span
        className="min-w-0 flex-1 select-text truncate font-mono text-caption text-subtle"
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
  // ⌘↩ and ⌘⌫ answer the card waiting longest, which shows them.
  const keyed = useChat((s) => waitingCard(s.turns)?.item.id === item.id)
  // History saved before these fields existed lacks them.
  const toolKind = item.toolKind ?? 'other'
  const locations = item.locations ?? []
  const subject = permissionSubject(toolKind, item.title, locations)
  if (item.resolved !== null || !live) return <PermissionOutcome item={item} subject={subject} />

  // Agents' own questions (see `answerForm` in agent.ts) come with their wording.
  const asked = toolKind === 'question'
  const question = asked ? item.title : permissionQuestion(toolKind, locations)
  const options = [...item.options].sort(byOptionOrder)
  const stacked = options.some((option) => optionLabel(option, asked).length > LONG_OPTION)
  const many = locations.length > 1
  const why = many
    ? 'These files control how the project builds or runs.'
    : 'This file controls how the project builds or runs.'
  return (
    <Card
      tone="inset"
      as="section"
      aria-label={question}
      data-permission={item.id}
      className="flex flex-col gap-3"
    >
      <div className="flex min-w-0 items-start gap-2">
        <p className="min-w-0 flex-1 break-words font-semibold">{question}</p>
        {item.sensitive && (
          <Badge tone="warning" icon={TriangleAlert} title={why} className="shrink-0">
            {many ? 'Sensitive files' : 'Sensitive file'}
          </Badge>
        )}
      </div>
      {!asked && subject !== fileNames(locations) && (
        <pre className="max-h-32 select-text overflow-y-auto scroll-stable whitespace-pre-wrap wrap-anywhere rounded-md bg-fill px-2 py-1.5 font-mono text-small text-fg">
          {subject}
        </pre>
      )}
      {item.sensitive && <p className="sr-only">{why}</p>}
      {/* One row, the default last, where the card is wide enough. Narrower, two columns that
          share the width, so the default never ends up alone on a line under the others: with
          an odd count, the first one takes a line of its own instead. An agent's own wording
          can run long ("Allow search via Exa, Firecrawl, …"): then each takes a full-width
          line, left-aligned, and wraps. */}
      <div className="@container">
        <div
          className={
            stacked ? 'flex flex-col gap-2' : 'grid grid-cols-2 gap-2 @sm:flex @sm:justify-end'
          }
        >
          {options.map((option, index) => (
            <Button
              key={option.optionId}
              variant={option.kind === 'allow_once' ? 'primary' : 'secondary'}
              title={option.name}
              shortcut={keyed ? OPTION_SHORTCUTS[option.kind] : undefined}
              keys
              onClick={() => gui.respondPermission(turnId, item.id, option.optionId)}
              className={cn(
                'min-w-0',
                // `!`: Button's own fixed height would win otherwise (cn doesn't merge).
                stacked
                  ? 'h-auto! min-h-7 py-1 text-left'
                  : index === 0 && options.length % 2 === 1 && 'col-span-2',
              )}
            >
              <span
                className={cn(
                  'min-w-0',
                  stacked ? 'flex-1 break-words whitespace-normal' : 'truncate',
                )}
              >
                {optionLabel(option, asked)}
              </span>
            </Button>
          ))}
        </div>
      </div>
    </Card>
  )
}

/** In place of Working while a question waits: the agent is paused on the user, not busy. */
function Waiting() {
  return (
    <p className="flex h-6 items-center gap-2 text-small text-muted">
      <Hand className="size-3.5 shrink-0 text-warning" aria-hidden="true" />
      Waiting for you
    </p>
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
  const [large, setLarge] = useTurnPresentation('comparison:large', false)
  /** The after image's width over its height, when there's no frame to say it. */
  const [loadedRatio, setLoadedRatio] = useTurnPresentation<number | null>('comparison:ratio', null)
  const preview = turn.preview
  // Without an after image there's nothing to compare yet (or the change wasn't on screen).
  if (!preview?.after) return null
  const shots = [
    { label: 'Before', src: preview.before },
    { label: 'After', src: preview.after },
  ] as const
  // Frames take the shot's shape, up to a cap, so a tall element isn't shrunk into a strip.
  const ratio = preview.frame ? preview.frame.width / preview.frame.height : loadedRatio
  // A long strip (a heading, a nav bar) fit whole would be a hairline: it fills the frame's
  // height (or width) instead, from its start, so its first words read.
  const strip = !ratio ? null : ratio > 4 ? 'wide' : ratio < 1 / 4 ? 'tall' : null
  return (
    <div
      className={cn('grid gap-2', large ? 'grid-cols-1' : 'grid-cols-2', turn.reverted && UNDONE)}
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
                // The page's own color (from the image), so a frame reads as a window onto it.
                style={{
                  backgroundColor: preview.fill ?? undefined,
                  aspectRatio: ratio ?? undefined,
                }}
                // A window onto the page, so no hover fill over it: the border strengthens.
                className={cn(
                  'flex min-h-12 w-full items-center justify-center overflow-hidden rounded-md border border-line bg-canvas transition-[border-color,opacity] hover:border-line-strong',
                  PRESS,
                  !ratio && (large ? 'h-48' : 'h-24'),
                  large ? 'max-h-128' : 'max-h-64',
                )}
              >
                <Shot
                  src={shot.src}
                  label={shot.label}
                  frame={preview.frame ?? null}
                  before={shot.label === 'Before'}
                  strip={strip}
                  onRatio={shot.label === 'After' ? setLoadedRatio : undefined}
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
  strip,
  onRatio,
}: {
  src: string
  label: string
  frame: PreviewFrame | null
  before: boolean
  /** A long strip, cropped to fill rather than shrunk to fit (see Comparison) */
  strip: 'wide' | 'tall' | null
  /** Reports the image's width over its height once it loads */
  onRatio?: (ratio: number) => void
}) {
  if (!frame) {
    return (
      <img
        src={src}
        alt={label}
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget
          if (naturalHeight > 0) onRatio?.(naturalWidth / naturalHeight)
        }}
        className={cn(
          'size-full',
          strip === 'wide'
            ? 'object-cover object-left'
            : strip === 'tall'
              ? 'object-cover object-top'
              : 'object-contain',
        )}
      />
    )
  }
  const area = before ? frame.before : { x: 0, y: 0, width: frame.width, height: frame.height }
  return (
    <svg
      viewBox={`0 0 ${frame.width} ${frame.height}`}
      role="img"
      aria-label={label}
      className="size-full"
      preserveAspectRatio={
        strip === 'wide' ? 'xMinYMid slice' : strip === 'tall' ? 'xMidYMin slice' : undefined
      }
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

/**
 * The end of a turn that changed files: how the element looked before and after, what
 * changed, Follow up (talk about this change again, later on), and Undo (Redo once undone).
 * Undo also undoes every later message (`restoreTurn`), so on an older one it reads "Undo to
 * here" and asks first.
 */
function Result({ turn, showRedo }: { turn: Turn; showRedo: boolean }) {
  const [open, setOpen] = useTurnPresentation('result:files', false)
  const [busy, setBusy] = useTurnPresentation<'undo' | 'redo' | null>('result:busy', null)
  const [error, setError] = useTurnPresentation<string | null>('result:error', null)
  const [confirming, setConfirming] = useTurnPresentation('result:confirm', false)
  const following = useChat((s) => s.followUp === turn.id)
  // Later messages with changes that Undo here would take back too.
  const later = useChat(
    (s) =>
      s.turnIds.slice(s.turnIds.indexOf(turn.id) + 1).filter((id) => {
        const next = s.turnsById[id]
        return !!next && !next.reverted && (!!next.changes?.length || !!next.changesUnknown)
      }).length,
  )
  const changes = turn.changes ?? []
  const additions = changes.reduce((sum, change) => sum + change.additions, 0)
  const deletions = changes.reduce((sum, change) => sum + change.deletions, 0)

  const run = async (which: 'undo' | 'redo', action: () => Promise<void>) => {
    setBusy(which)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(readableError(err))
    } finally {
      setBusy(null)
    }
  }

  const undo = () => {
    setConfirming(false)
    void run('undo', () => gui.restoreTurn(turn.id))
  }

  // Interrupted (e.g. by a quit) before its changes were recorded; it can still be undone.
  const unrecorded = changes.length === 0 && turn.changesUnknown === true
  // A turn that changed nothing has no result, even when undoing an earlier one marked it.
  if (changes.length === 0 && !unrecorded) return null

  return (
    <Card tone="inset" as="section" aria-label="Result" className="flex flex-col gap-3">
      <Comparison turn={turn} />
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {changes.length > 0 ? (
          <Disclosure open={open} onOpenChange={setOpen} className="tabular-nums">
            {plural(changes.length, 'file')} changed
            <span className="font-mono text-success tabular-nums"> +{additions}</span>
            <span className="font-mono text-danger tabular-nums"> −{deletions}</span>
          </Disclosure>
        ) : (
          unrecorded && <span className="text-small text-muted">Changes not recorded</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <Toggle
            size="sm"
            icon={Reply}
            pressed={following}
            title="Ask about this change in your next message"
            onClick={() => setFollowUp(following ? null : turn.id)}
          >
            Follow up
          </Toggle>
          {turn.reverted ? (
            <>
              <Badge>Undone</Badge>
              {showRedo && (
                <Button
                  size="sm"
                  icon={Redo2}
                  loading={busy === 'redo'}
                  onClick={() => run('redo', () => gui.redo())}
                >
                  Redo
                </Button>
              )}
            </>
          ) : (
            !confirming && (
              <Button
                size="sm"
                icon={Undo2}
                loading={busy === 'undo'}
                title={
                  later > 0
                    ? 'Restore files to how they were before this message, undoing later messages too'
                    : 'Restore files to how they were before this message'
                }
                onClick={() => (later > 0 ? setConfirming(true) : undo())}
              >
                {later > 0 ? 'Undo to here' : 'Undo'}
              </Button>
            )
          )}
        </span>
      </div>
      {confirming && !turn.reverted && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="min-w-0 flex-1 text-small text-pretty text-muted">
            {later > 0 ? `Undo this and ${plural(later, 'later message')}?` : 'Undo this message?'}{' '}
            You can redo.
          </p>
          <span className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" icon={Undo2} onClick={undo}>
              Undo
            </Button>
          </span>
        </div>
      )}
      {open && <ChangedFiles changes={changes} />}
      {error && <InlineError>{error}</InlineError>}
    </Card>
  )
}
