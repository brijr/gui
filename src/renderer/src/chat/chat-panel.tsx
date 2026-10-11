import {
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import {
  BUBBLE,
  MINI,
  PANEL_SHADOW_MARGIN,
  TOOLBAR_HEIGHT,
  TRAFFIC_LIGHTS_INSET,
} from '../../../shared/layout'
import { withShortcut } from '../../../shared/shortcuts'
import {
  CHAT_FORMS,
  type ChatFloat,
  type ChatForm,
  type ChatMeta,
  PANEL_EDGES,
  type PanelCorner,
  type PanelEdge,
} from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { ErrorBoundary } from '../lib/error-boundary'
import { readableError } from '../lib/errors'
import { InlineError } from '../lib/field'
import {
  Archive,
  ChevronDown,
  Ellipsis,
  Maximize2,
  MessageSquare,
  Minus,
  MousePointer2,
  PanelLeft,
  PictureInPicture2,
  SquareArrowOutDownLeft,
  SquarePen,
} from '../lib/icons'
import { Badge, type Status, StatusDot } from '../lib/status'
import { Message, PanelHeader } from '../lib/surface'
import { Button, IconButton, PRESS, Spinner } from '../lib/ui'
import { ArchivePopover } from './archive'
import { Composer } from './composer'
import { Morph } from './morph'
import { ProposalBar, ReviewSheet, useProposal, useProposalUpdates } from './proposal'
import { ShipSheet, toggleShipSheet, useShipSheet } from './ship-sheet'
import { connectChat, keyedAnswer, setDraft, useChat, waitingCard } from './store'
import { TurnView } from './turn-view'

/** Fields ⌘⌫ deletes typing in. */
const TEXT_INPUT = /^(text|search|url|email|password|tel|number)$/

/** A field with text in it, which ⌘⌫ deletes back to the start of the line. */
function typing(target: EventTarget | null) {
  if (target instanceof HTMLTextAreaElement) return target.value !== ''
  if (target instanceof HTMLInputElement) return TEXT_INPUT.test(target.type) && target.value !== ''
  return target instanceof HTMLElement && target.isContentEditable && !!target.textContent
}

/**
 * ⌘↩ and ⌘⌫ answer the oldest waiting permission card from anywhere in the panel, with its
 * Allow or Don't Allow, as Agent → Allow and Don't Allow do from elsewhere; otherwise the
 * composer would send on ⌘↩ and a text field take ⌘⌫. Not while the PR sheet is open (its
 * ⌘↩ creates the pull request), nor ⌘⌫ in a field with text in it, which it deletes. Ahead
 * of the panel's own handlers: a key answered here goes no further, the menu included.
 */
function answerPermissionKeys() {
  const onKeyDown = (event: KeyboardEvent) => {
    const modifiers = event.ctrlKey || event.altKey || event.shiftKey
    if (!event.metaKey || modifiers || event.isComposing) return
    const allow = event.key === 'Enter'
    if (!allow && event.key !== 'Backspace') return
    if (useShipSheet.getState().open || (!allow && typing(event.target))) return
    const answer = keyedAnswer(useChat.getState().turns, allow)
    if (!answer) return
    event.preventDefault()
    event.stopPropagation()
    gui.respondPermission(answer.turnId, answer.itemId, answer.optionId)
  }
  window.addEventListener('keydown', onKeyDown, true)
  return () => window.removeEventListener('keydown', onKeyDown, true)
}

export function ChatPanel() {
  useEffect(() => connectChat(), [])
  useEffect(() => answerPermissionKeys(), [])
  // Main gives ⌘↩ to the PR sheet while it's open: Agent → Allow waits.
  useEffect(
    () =>
      useShipSheet.subscribe((sheet, before) => {
        if (sheet.open !== before.open) gui.setShipSheetOpen(sheet.open)
      }),
    [],
  )
  useProposalUpdates()
  const meta = useChat((s) => s.meta)
  const turnIds = useChat((s) => s.turnIds)
  const running = useChat((s) => s.turns.some((turn) => turn.status === 'running'))
  const float = useChat((s) => s.float)
  if (!meta) return null

  // The sidebar, or popped out into a window of its own, which it fills.
  if (meta.docked || meta.popped) {
    return (
      <div
        data-chat-panel
        className={cn(
          'relative flex h-dvh flex-col bg-raised',
          !meta.popped && 'border-r border-line-strong',
        )}
      >
        {!meta.popped && <ResizeHandle edge="right" docked />}
        <Header meta={meta} />
        <Body meta={meta} turnIds={turnIds} running={running} />
      </div>
    )
  }

  return (
    <FloatingChat float={float} meta={meta} running={running}>
      {/* The strong hairline is deliberate: the panel floats over whatever page is in the
          preview, often white on white, where the regular one disappears. */}
      <div
        data-chat-panel
        className="flex h-full flex-col overflow-hidden rounded-xl border border-line-strong bg-raised shadow-panel"
      >
        <Header meta={meta} />
        <Body meta={meta} turnIds={turnIds} running={running} />
      </div>
      {/* Every edge and corner resizes the panel; the opposite ones stay put. */}
      {PANEL_EDGES.map((edge) => (
        <ResizeHandle key={edge} edge={edge} />
      ))}
    </FloatingChat>
  )
}

/**
 * Under the header: "Create pull request" or the review comments take over the transcript and
 * composer until closed; otherwise the pull request's bar sits over the transcript.
 */
function Body({ meta, turnIds, running }: { meta: ChatMeta; turnIds: string[]; running: boolean }) {
  const shipping = useShipSheet((s) => s.open)
  const reviewing = useProposal((s) => s.reviewing)
  if (shipping) return <ShipSheet />
  if (reviewing) return <ReviewSheet />
  return (
    <>
      <ProposalBar />
      <Transcript turnIds={turnIds} meta={meta} />
      <Composer meta={meta} running={running} />
    </>
  )
}

/** Puts a box in the view's `corner`, inside the shadow margin. */
function atCorner(corner: PanelCorner): CSSProperties {
  return { [corner.x]: PANEL_SHADOW_MARGIN, [corner.y]: PANEL_SHADOW_MARGIN }
}

/**
 * The floating chat as the panel (`children`), the pill while minimized, or the bubble while
 * the user picks an element, each at the view's anchored corner. Changing form morphs (see
 * morph.ts): main keeps the view at the larger form's size meanwhile, and shrinks it once
 * told the morph is done. The form on its way out is inert.
 */
function FloatingChat({
  float,
  meta,
  running,
  children,
}: {
  float: ChatFloat
  meta: ChatMeta
  running: boolean
  children: ReactNode
}) {
  const { form, corner, seq } = float
  const elements = useRef<Partial<Record<ChatForm, HTMLElement | null>>>({})
  const morph = useRef<Morph | null>(null)
  /** The float the morph under way is for, which main checks the report against. */
  const morphSeq = useRef(seq)
  /** Forms still drawn: the current one, and any still morphing away. */
  const [drawn, setDrawn] = useState<ChatForm[]>([form])

  useLayoutEffect(() => {
    // Mounted with the form, so the morph styles it before the first paint.
    setDrawn((forms) => (forms.includes(form) ? forms : [...forms, form]))
    // The control that was pressed is in the form going away, now inert: the keyboard moves on
    // to the form taking its place (the pill's button, the panel's message box).
    const active = document.activeElement
    const left = CHAT_FORMS.some(
      (each) => each !== form && elements.current[each]?.contains(active),
    )
    if (left && document.hasFocus()) {
      const next = elements.current[form]?.querySelector<HTMLElement>(
        form === 'panel' ? '[data-composer]' : 'button',
      )
      next?.focus({ preventScroll: true })
    }
    morphSeq.current = seq
    morph.current ??= new Morph(form, {
      element: (each) => elements.current[each] ?? null,
      gone: (shown) => {
        setDrawn([shown])
        gui.chatMorphed(shown, morphSeq.current)
      },
    })
    morph.current.to(form, corner)
  }, [form, corner, seq])
  useEffect(() => () => morph.current?.stop(), [])

  const layer = (each: ChatForm) => ({
    'data-chat-form': each,
    ref: (el: HTMLElement | null) => {
      elements.current[each] = el
    },
    inert: each !== form,
  })
  const shows = (each: ChatForm) => each === form || drawn.includes(each)

  return (
    <div className="relative h-dvh">
      {shows('panel') && (
        <div
          {...layer('panel')}
          className={cn('absolute', form !== 'panel' && 'pointer-events-none')}
          style={{ inset: PANEL_SHADOW_MARGIN }}
        >
          {children}
        </div>
      )}
      {shows('pill') && (
        <div
          {...layer('pill')}
          className={cn('absolute', form !== 'pill' && 'pointer-events-none')}
          style={{ ...atCorner(corner), width: MINI.width, height: MINI.height }}
        >
          <MiniPanel meta={meta} running={running} />
        </div>
      )}
      {shows('bubble') && (
        <div
          {...layer('bubble')}
          className={cn('absolute', form !== 'bubble' && 'pointer-events-none')}
          style={{ ...atCorner(corner), width: BUBBLE.width, height: BUBBLE.height }}
        >
          <ChatBubble running={running} picking={meta.selecting} />
        </div>
      )}
    </div>
  )
}

/** The pointer's velocity at release is measured over this much of its recent path (ms). */
const VELOCITY_WINDOW = 100
/** A pointer held still this long before letting go releases at rest, whatever came before. */
const RELEASE_PAUSE = 50

interface Sample {
  x: number
  y: number
  t: number
}

/**
 * The pointer's velocity in px/s as it let go at `t`, from its path over the last
 * VELOCITY_WINDOW; zero if it had stopped moving before.
 */
function releaseVelocity(samples: Sample[], t: number) {
  const recent = samples.filter((sample) => t - sample.t <= VELOCITY_WINDOW)
  const first = recent[0]
  const last = recent.at(-1)
  if (!first || !last || t - last.t > RELEASE_PAUSE) return { x: 0, y: 0 }
  const seconds = (last.t - first.t) / 1000
  // Too short a path to tell a direction from noise.
  if (seconds < 0.008) return { x: 0, y: 0 }
  return { x: (last.x - first.x) / seconds, y: (last.y - first.y) / seconds }
}

/**
 * Follows a pointer drag in screen coordinates, since the native view moves and resizes
 * under the pointer, and reports the deltas batched per frame; at the end, the pointer's
 * velocity as it let go (px/s), so a throw carries on.
 */
function trackDrag(
  event: ReactPointerEvent<HTMLElement>,
  onMove: (dx: number, dy: number) => void,
  onEnd: (velocity: { x: number; y: number }) => void,
) {
  const el = event.currentTarget
  el.setPointerCapture(event.pointerId)
  let last = { x: event.screenX, y: event.screenY }
  let pending = { dx: 0, dy: 0 }
  let frame = 0
  let samples: Sample[] = [{ x: event.screenX, y: event.screenY, t: event.timeStamp }]

  const flush = () => {
    frame = 0
    if (pending.dx || pending.dy) onMove(pending.dx, pending.dy)
    pending = { dx: 0, dy: 0 }
  }
  const move = (e: PointerEvent) => {
    pending = { dx: pending.dx + e.screenX - last.x, dy: pending.dy + e.screenY - last.y }
    last = { x: e.screenX, y: e.screenY }
    samples = [...samples, { x: e.screenX, y: e.screenY, t: e.timeStamp }].filter(
      (sample) => e.timeStamp - sample.t <= VELOCITY_WINDOW * 2,
    )
    frame ||= requestAnimationFrame(flush)
  }
  const end = (e: PointerEvent) => {
    cancelAnimationFrame(frame)
    flush()
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', end)
    el.removeEventListener('pointercancel', end)
    onEnd(e.type === 'pointerup' ? releaseVelocity(samples, e.timeStamp) : { x: 0, y: 0 })
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', end)
  el.addEventListener('pointercancel', end)
}

/**
 * Dragging the header (or the minimized pill) moves the floating panel; letting go throws it
 * into a corner. Pressing it while it lands catches it where it is.
 */
function onDragStart(event: ReactPointerEvent<HTMLElement>) {
  if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
  const { screenX, screenY, clientX, clientY } = event
  gui.grabChat({ screenX, screenY, clientX, clientY })
  trackDrag(
    event,
    (dx, dy) => gui.dragChat(dx, dy),
    (velocity) => gui.endDragChat(velocity),
  )
}

/**
 * Hit areas straddling the floating panel's edges and corners (its view has a transparent
 * margin for the shadow), with a hairline over the border on hover. The edges stop short of
 * the corners, whose hairline traces the border's rounded part. The top edge reaches less
 * into the panel, whose header drags it.
 */
const EDGE_CLASS: Record<PanelEdge, string> = {
  top: 'inset-x-2 -top-1 h-1.5 cursor-ns-resize after:inset-x-1 after:top-1 after:h-px',
  right: 'inset-y-2 -right-0.75 w-1.5 cursor-ew-resize after:inset-y-1 after:right-0.75 after:w-px',
  bottom:
    'inset-x-2 -bottom-0.75 h-1.5 cursor-ns-resize after:inset-x-1 after:bottom-0.75 after:h-px',
  left: 'inset-y-2 -left-0.75 w-1.5 cursor-ew-resize after:inset-y-1 after:left-0.75 after:w-px',
  'top-left':
    '-top-1.5 -left-1.5 cursor-nwse-resize after:top-1.5 after:left-1.5 after:rounded-tl-xl after:border-t after:border-l',
  'top-right':
    '-top-1.5 -right-1.5 cursor-nesw-resize after:top-1.5 after:right-1.5 after:rounded-tr-xl after:border-t after:border-r',
  'bottom-left':
    '-bottom-1.5 -left-1.5 cursor-nesw-resize after:bottom-1.5 after:left-1.5 after:rounded-bl-xl after:border-b after:border-l',
  'bottom-right':
    '-right-1.5 -bottom-1.5 cursor-nwse-resize after:right-1.5 after:bottom-1.5 after:rounded-br-xl after:border-r after:border-b',
}
/** A corner's hit area, and its hairline the size of the border's rounded part. */
const CORNER_CLASS = 'size-3.5 after:size-3 after:border-accent'
/** The docked panel's left edge is its view's, so the hit area stays inside. */
const DOCKED_CLASS =
  'inset-y-0 right-0 w-1.5 cursor-ew-resize after:inset-y-0 after:right-0 after:w-px'

/** An invisible handle that resizes the panel; main keeps the panel inside the window. */
function ResizeHandle({ edge, docked = false }: { edge: PanelEdge; docked?: boolean }) {
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return
    // No text selection or focus change while dragging.
    event.preventDefault()
    trackDrag(
      event,
      (dx, dy) => gui.resizeChat(edge, dx, dy),
      () => gui.endResizeChat(),
    )
  }
  return (
    <div
      aria-hidden="true"
      onPointerDown={onPointerDown}
      className={cn(
        'absolute z-sticky after:absolute after:opacity-0 after:transition-opacity hover:after:opacity-70',
        docked ? DOCKED_CLASS : EDGE_CLASS[edge],
        edge.includes('-') ? CORNER_CLASS : 'after:bg-accent',
      )}
    />
  )
}

/** The agent's state as a dot: busy while it starts or works. */
function agentStatus(meta: ChatMeta, running: boolean): Status {
  if (meta.status === 'error') return 'error'
  if (meta.status === 'starting' || meta.status === 'working' || running) return 'busy'
  if (meta.status === 'ready') return 'ready'
  return 'idle'
}

/**
 * The panel's title bar: the agent's state and name, which switches agents, the session's
 * mode, and the panel's actions. Floating, it's also where the panel is dragged from.
 */
function Header({ meta }: { meta: ChatMeta }) {
  const running = meta.status === 'working'
  const titleBar = meta.docked || meta.popped
  const shipping = useShipSheet((s) => s.open)
  const shipBusy = useShipSheet((s) => s.busy)
  return (
    <PanelHeader
      onPointerDown={titleBar ? undefined : onDragStart}
      // As the sidebar (or popped out) it's the window's title bar: as tall as the toolbar,
      // with the traffic lights at its start (outside full screen), and what the window is
      // dragged by. The name still starts the line, after them.
      style={
        titleBar
          ? {
              height: TOOLBAR_HEIGHT,
              paddingLeft: meta.trafficLights ? TRAFFIC_LIGHTS_INSET : undefined,
            }
          : undefined
      }
      className={titleBar ? 'drag' : 'cursor-grab active:cursor-grabbing'}
      leading={<StatusDot status={agentStatus(meta, running)} />}
      actions={
        <>
          <IconButton
            size="sm"
            label="New chat"
            title={withShortcut('New chat (archives this one)', 'newChat')}
            shortcut="newChat"
            icon={SquarePen}
            onClick={() => gui.newSession()}
          />
          {!meta.popped && (
            <IconButton
              size="sm"
              label={meta.docked ? 'Float panel' : 'Show as sidebar'}
              shortcut="dockChat"
              // What it turns the chat into: a floating panel, or the sidebar.
              icon={meta.docked ? PictureInPicture2 : PanelLeft}
              onClick={() => gui.toggleDock()}
            />
          )}
          {/* Back to the window, from its own: the one action a popped-out chat needs at hand. */}
          {meta.popped && (
            <IconButton
              size="sm"
              label="Back to window"
              shortcut="popOutChat"
              icon={SquareArrowOutDownLeft}
              onClick={() => gui.togglePopOut()}
            />
          )}
          <MoreButton shipping={shipping} shipBusy={shipBusy} />
          {!meta.docked && !meta.popped && (
            <IconButton
              size="sm"
              label="Minimize"
              icon={Minus}
              onClick={() => gui.setMinimized(true)}
            />
          )}
        </>
      }
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <AgentSwitcher name={meta.agentName} />
        {meta.modeName && !meta.modeFollowsPolicy && (
          <Badge title="The agent's mode">
            <span className="truncate">{meta.modeName}</span>
          </Badge>
        )}
      </div>
    </PanelHeader>
  )
}

/**
 * The header's less-used actions in one native menu (main's `showChatMenu`): Create Pull
 * Request, Archived Chats, Pop Out. The pull request sheet and the archived chats are this
 * page's, so main says which was chosen; the archived chats open under this button.
 */
function MoreButton({ shipping, shipBusy }: { shipping: boolean; shipBusy: boolean }) {
  const button = useRef<HTMLButtonElement>(null)
  const [archive, setArchive] = useState(false)
  useEffect(
    () =>
      gui.onChatMenuChoice((choice) => {
        if (choice === 'pullRequest') toggleShipSheet()
        else setArchive(true)
      }),
    [],
  )
  return (
    <>
      <IconButton
        ref={button}
        size="sm"
        label="More"
        icon={Ellipsis}
        aria-haspopup="menu"
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          gui.showChatMenu(
            { x: Math.round(box.left), y: Math.round(box.bottom + 4) },
            { open: shipping, busy: shipBusy },
          )
        }}
      />
      <ArchivePopover
        open={archive}
        anchor={button}
        onClose={(refocus) => {
          setArchive(false)
          if (refocus) button.current?.focus()
        }}
      />
    </>
  )
}

/**
 * The agent's name, which opens the agent menu under it: the other agents, Agent
 * Settings…, New chat. The native menu takes the keyboard from there.
 */
function AgentSwitcher({ name }: { name: string }) {
  return (
    <button
      type="button"
      aria-haspopup="menu"
      title="Switch agent"
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect()
        gui.showAgentMenu({ x: box.left, y: box.bottom + 4 })
      }}
      // A ghost button with its chevron, pulled into the header's inset so the name lines up
      // with the panel's text.
      className={cn(
        'no-drag -ml-1 flex h-6 min-w-0 items-center gap-1 rounded-md px-1 font-medium text-fg transition-[color,background-color,opacity] hover:bg-hover',
        PRESS,
      )}
    >
      <span className="truncate">{name}</span>
      <ChevronDown className="size-3 shrink-0 text-subtle" aria-hidden="true" />
    </button>
  )
}

function MiniPanel({ meta, running }: { meta: ChatMeta; running: boolean }) {
  return (
    <div
      onPointerDown={onDragStart}
      className="flex size-full cursor-grab items-center gap-2 rounded-full border border-line-strong bg-raised pr-1.5 pl-4 shadow-panel active:cursor-grabbing"
    >
      {running ? (
        <Spinner className="text-muted" />
      ) : (
        <StatusDot status={agentStatus(meta, running)} />
      )}
      <span className="min-w-0 flex-1 truncate font-medium">
        {running ? 'Working…' : meta.agentName}
      </span>
      <IconButton label="Expand chat" icon={Maximize2} onClick={() => gui.setMinimized(false)} />
    </div>
  )
}

/**
 * The floating panel out of the way: while the user picks an element, or tucked once they
 * went back to the page. The panel morphs into this bubble at its anchored corner and main
 * shrinks the view to it. Clicking it brings the panel back (and stops picking).
 */
function ChatBubble({ running, picking }: { running: boolean; picking: boolean }) {
  const statusId = useId()
  // A permission card in the running turn; it shows once the panel is back.
  const waiting = useChat((s) => waitingCard(s.turns) !== null)
  const status = waiting
    ? 'The agent is waiting for you. '
    : running
      ? 'The agent is working. '
      : ''
  return (
    <>
      <button
        type="button"
        aria-label="Show chat"
        aria-describedby={statusId}
        title={picking ? 'Show chat (stops selecting)' : 'Show chat'}
        onClick={() => (picking ? gui.stopSelecting() : gui.expandChat())}
        // Floats over the page like the panel, so the same strong hairline and shadow.
        className={cn(
          'relative flex size-full items-center justify-center rounded-full border border-line-strong bg-raised text-muted shadow-panel transition-[color,opacity] hover:text-fg hover:tint',
          PRESS,
        )}
      >
        {/* 16px: a control's 14px icon looks lost in the 44px bubble */}
        {running ? <Spinner size="md" /> : <MessageSquare className="size-4" aria-hidden="true" />}
        {/* Larger than a status dot, with a ring of the bubble's color, so it reads on the edge */}
        {waiting && (
          <StatusDot
            status="attention"
            className="absolute top-0.5 right-0.5 size-2.5 ring-2 ring-raised"
          />
        )}
      </button>
      <span id={statusId} hidden>
        {status}
        {picking && 'Stops selecting.'}
      </span>
    </>
  )
}

function Transcript({ turnIds, meta }: { turnIds: string[]; meta: ChatMeta }) {
  if (turnIds.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <EmptyTranscript canSelect={meta.canSelect} picked={meta.selection.length} />
        {meta.archived && <ArchivedNotice archived={meta.archived} />}
      </div>
    )
  }
  return <Turns turnIds={turnIds} meta={meta} />
}

function toEnd(el: HTMLElement | null) {
  if (el) el.scrollTop = el.scrollHeight
}

/** Within this many pixels of the end counts as at the end. */
const STICK_SLOP = 48
/** How long after a disclosure is toggled its change in height is the user's, not new content. */
const TOGGLE_WINDOW = 150

/** After New chat: the chat it replaced is in the archive, and can come straight back. */
function ArchivedNotice({ archived }: { archived: NonNullable<ChatMeta['archived']> }) {
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex shrink-0 flex-col gap-1 border-t border-line px-3 py-2">
      <div className="flex items-center gap-2">
        <Archive className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
        <p className="min-w-0 flex-1 truncate text-small text-muted">
          Your chat with {archived.agentName} is archived.
        </p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void gui.openChat(archived.id).catch((err: unknown) => setError(readableError(err)))
          }
        >
          Reopen
        </Button>
      </div>
      {error && <InlineError>{error}</InlineError>}
    </div>
  )
}

/** Past this many messages, the transcript suggests starting over (agents lose the thread). */
const LONG_CHAT = 150

function LongChatHint() {
  return (
    <div className="flex items-center gap-2 rounded-md border border-line px-3 py-2">
      <p className="min-w-0 flex-1 text-small text-muted">
        This chat is long. Agents stay sharper in a fresh one; this one stays in the archive.
      </p>
      <Button size="sm" icon={SquarePen} onClick={() => gui.newSession()}>
        New chat
      </Button>
    </div>
  )
}

/**
 * Stays pinned to the newest line unless the user scrolled up: as turns stream in, as what's
 * in them grows (a permission card, an image loading), and as the composer's stack (queue,
 * problems, the picked element) grows or shrinks under it. A new turn is the user's own
 * message, so it always comes into view and the transcript follows from there, wherever they
 * had scrolled to.
 */
function Turns({ turnIds, meta }: { turnIds: string[]; meta: ChatMeta }) {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  /** When the user last opened or closed a disclosure in the transcript. */
  const toggledAt = useRef(Number.NEGATIVE_INFINITY)
  const newest = turnIds.at(-1)
  const running = useChat((s) => s.turnsById[newest ?? '']?.status === 'running')

  // Before paint, so a message moving into the transcript lands where it ends up.
  useLayoutEffect(() => {
    if (newest === undefined) return
    stick.current = true
    toEnd(scroller.current)
  }, [newest])
  useLayoutEffect(() => {
    if (stick.current && turnIds.length) toEnd(scroller.current)
  }, [turnIds])

  // The transcript's own height (the composer growing) and its content's (anything that grows
  // after it renders) both change without a scroll.
  useEffect(() => {
    const el = scroller.current
    const inner = content.current
    if (!el || !inner) return
    const observer = new ResizeObserver(() => {
      // Opening "3 steps" near the end is the user reading there: it opens in place.
      if (performance.now() - toggledAt.current < TOGGLE_WINDOW) return
      if (stick.current) toEnd(el)
    })
    observer.observe(el)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={scroller}
      data-transcript
      data-clip
      onScroll={(event) => {
        const el = event.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLOP
      }}
      onClickCapture={(event) => {
        if ((event.target as Element).closest('[aria-expanded]')) {
          toggledAt.current = performance.now()
        }
      }}
      className="min-h-0 flex-1 select-text overflow-y-auto scroll-stable scroll-fade px-3 py-4"
    >
      <div ref={content} className="flex flex-col gap-6">
        {turnIds.map((id) => (
          <TurnRow key={id} id={id} showRedo={meta.redoTurnIds[0] === id} />
        ))}
        {turnIds.length >= LONG_CHAT && !running && <LongChatHint />}
      </div>
    </div>
  )
}

/** Each row observes its own turn; streaming does not rerender the transcript shell. */
function TurnRow({ id, showRedo }: { id: string; showRedo: boolean }) {
  const turn = useChat((s) => s.turnsById[id])
  if (!turn) return null
  return (
    <ErrorBoundary resetKey={turn}>
      <TurnView turn={turn} showRedo={showRedo} />
    </ErrorBoundary>
  )
}

/** Something to start from in an empty chat: building an app from nothing, or changing one. */
const STARTERS = {
  build: [
    'Build a landing page for a coffee shop',
    'Build a portfolio site with a project gallery',
    'Build a sign-up form with friendly validation',
  ],
  change: [
    'Make it feel more modern and polished',
    'Add a dark mode that follows the system setting',
    'Make it work well on phones',
  ],
}

/**
 * A few things to ask for, under the empty chat's message. Choosing one puts it in the
 * message box to edit or send, rather than sending it.
 */
function StarterPrompts({ prompts }: { prompts: readonly string[] }) {
  return (
    <ul aria-label="Ideas to start with" className="flex flex-col items-start gap-1.5">
      {prompts.map((prompt) => (
        <li key={prompt}>
          <Button
            size="sm"
            variant="ghost"
            className="h-auto py-1 text-left whitespace-normal"
            onClick={() => {
              setDraft(prompt)
              document.querySelector<HTMLTextAreaElement>('[data-composer]')?.focus()
            }}
          >
            {prompt}
          </Button>
        </li>
      ))}
    </ul>
  )
}

function EmptyTranscript({ canSelect, picked }: { canSelect: boolean; picked: number }) {
  // Nothing on screen to point at yet (the app is starting, or failed to): say so, and
  // still take a message, which needs no element.
  if (!canSelect) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 py-6">
        <Message
          className="m-auto shrink-0"
          icon={<MessageSquare className="size-4" aria-hidden="true" />}
          title="Ask about your project"
        >
          Once your app shows in the preview, you can point at any part of it to change. Until then,
          your agent can still read and edit the code.
        </Message>
        <div className="mx-auto mb-auto w-full max-w-sm pt-4">
          <StarterPrompts prompts={STARTERS.build} />
        </div>
      </div>
    )
  }
  // Something's picked: the next step is the message, not picking again.
  if (picked > 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 py-6">
        <Message
          className="m-auto shrink-0"
          icon={<MessageSquare className="size-4" aria-hidden="true" />}
          title="Describe the change"
        >
          Say what {picked === 1 ? 'it' : 'they'} should look like or do, and send. Your agent edits
          the code and the preview updates live.
        </Message>
      </div>
    )
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 py-6">
      <Message
        className="m-auto shrink-0"
        icon={<MousePointer2 className="size-4" aria-hidden="true" />}
        title="Point at something to change"
        actions={
          <Button icon={MousePointer2} onClick={() => gui.toggleSelect()}>
            Select element
          </Button>
        }
      >
        Click elements in your app (⇧ for several) or drag out an area, then describe the change.
        Your agent edits the code and the preview updates live.
      </Message>
      <div className="mx-auto mb-auto w-full max-w-sm pt-4">
        <StarterPrompts prompts={STARTERS.change} />
      </div>
    </div>
  )
}
