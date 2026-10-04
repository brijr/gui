import {
  ChevronDown,
  GitPullRequest,
  Maximize2,
  MessageSquare,
  Minus,
  MousePointer2,
  PanelRight,
  PanelRightClose,
  SquarePen,
} from 'lucide-react'
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
import { BUBBLE, MINI, PANEL_SHADOW_MARGIN } from '../../../shared/layout'
import {
  type ChatFloat,
  type ChatForm,
  type ChatMeta,
  PANEL_EDGES,
  type PanelCorner,
  type PanelEdge,
  type Turn,
} from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { Badge, type Status, StatusDot } from '../lib/status'
import { Message } from '../lib/surface'
import { Button, IconButton, Spinner } from '../lib/ui'
import { Composer } from './composer'
import { Morph } from './morph'
import { ShipSheet, toggleShipSheet, useShipSheet } from './ship-sheet'
import { connectChat, keyedAnswer, useChat, waitingCard } from './store'
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
  const meta = useChat((s) => s.meta)
  const turns = useChat((s) => s.turns)
  // "Create pull request" takes over the transcript and composer until it's closed.
  const shipping = useShipSheet((s) => s.open)
  const float = useChat((s) => s.float)
  if (!meta) return null

  const running = turns.some((turn) => turn.status === 'running')

  if (meta.docked) {
    return (
      <div
        data-chat-panel
        className="relative flex h-dvh flex-col border-l border-line-strong bg-raised"
      >
        <ResizeHandle edge="left" docked />
        <Header meta={meta} />
        {shipping ? (
          <ShipSheet />
        ) : (
          <>
            <Transcript turns={turns} meta={meta} />
            <Composer meta={meta} running={running} />
          </>
        )}
      </div>
    )
  }

  return (
    <FloatingChat float={float} meta={meta} turns={turns} running={running}>
      <div
        data-chat-panel
        className="flex h-full flex-col overflow-hidden rounded-xl border border-line-strong bg-raised shadow-panel"
      >
        <Header meta={meta} />
        {shipping ? (
          <ShipSheet />
        ) : (
          <>
            <Transcript turns={turns} meta={meta} />
            <Composer meta={meta} running={running} />
          </>
        )}
      </div>
      {/* Every edge and corner resizes the panel; the opposite ones stay put. */}
      {PANEL_EDGES.map((edge) => (
        <ResizeHandle key={edge} edge={edge} />
      ))}
    </FloatingChat>
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
  turns,
  running,
  children,
}: {
  float: ChatFloat
  meta: ChatMeta
  turns: Turn[]
  running: boolean
  children: ReactNode
}) {
  const { form, corner } = float
  const elements = useRef<Partial<Record<ChatForm, HTMLElement | null>>>({})
  const morph = useRef<Morph | null>(null)
  /** Forms still drawn: the current one, and any still morphing away. */
  const [drawn, setDrawn] = useState<ChatForm[]>([form])

  useLayoutEffect(() => {
    // Mounted with the form, so the morph styles it before the first paint.
    setDrawn((forms) => (forms.includes(form) ? forms : [...forms, form]))
    morph.current ??= new Morph(form, {
      element: (each) => elements.current[each] ?? null,
      gone: (shown) => {
        setDrawn([shown])
        gui.chatMorphed(shown)
      },
    })
    morph.current.to(form, corner)
  }, [form, corner])
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
          <ChatBubble turns={turns} running={running} />
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
  'inset-y-0 left-0 w-1.5 cursor-ew-resize after:inset-y-0 after:left-0 after:w-px'

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
        'absolute z-10 after:absolute after:opacity-0 after:transition-opacity hover:after:opacity-70',
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
  const shipping = useShipSheet((s) => s.open)
  const shipBusy = useShipSheet((s) => s.busy)
  return (
    <div
      onPointerDown={meta.docked ? undefined : onDragStart}
      className={cn(
        'flex h-10 shrink-0 items-center gap-1.5 border-b border-line pr-2 pl-3',
        !meta.docked && 'cursor-grab active:cursor-grabbing',
      )}
    >
      <StatusDot status={agentStatus(meta, running)} />
      <AgentSwitcher name={meta.agentName} />
      {meta.modeName && (
        <Badge title="The agent's mode">
          <span className="truncate">{meta.modeName}</span>
        </Badge>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <IconButton
          size="sm"
          label="Create pull request"
          icon={GitPullRequest}
          pressed={shipping}
          disabled={shipBusy}
          onClick={toggleShipSheet}
        />
        <IconButton
          size="sm"
          label="New chat"
          shortcut="newChat"
          icon={SquarePen}
          onClick={() => gui.newSession()}
        />
        <IconButton
          size="sm"
          label={meta.docked ? 'Float panel' : 'Dock to the side'}
          shortcut="dockChat"
          icon={meta.docked ? PanelRightClose : PanelRight}
          onClick={() => gui.toggleDock()}
        />
        {!meta.docked && (
          <IconButton
            size="sm"
            label="Minimize"
            icon={Minus}
            onClick={() => gui.setMinimized(true)}
          />
        )}
      </div>
    </div>
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
      className="no-drag -ml-1 flex h-6 min-w-0 items-center gap-1 rounded-md px-1 font-medium text-fg transition-colors hover:bg-hover"
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
 * The floating panel while the user picks an element: the panel morphs into this bubble at
 * its anchored corner and main shrinks the view to it. Clicking it stops picking, which brings
 * the panel back.
 */
function ChatBubble({ turns, running }: { turns: Turn[]; running: boolean }) {
  const statusId = useId()
  // A permission card in the running turn; it shows once the panel is back.
  const waiting = waitingCard(turns) !== null
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
        title="Show chat (stops selecting)"
        onClick={() => gui.stopSelecting()}
        className="relative flex size-full items-center justify-center rounded-full border border-line-strong bg-raised text-muted shadow-panel transition-colors hover:text-fg"
      >
        {/* 16px: a control's 14px icon looks lost in the 44px bubble */}
        {running ? <Spinner size="md" /> : <MessageSquare className="size-4" aria-hidden="true" />}
        {waiting && (
          <span
            aria-hidden="true"
            className="absolute top-0.5 right-0.5 size-2.5 rounded-full bg-accent ring-2 ring-raised"
          />
        )}
      </button>
      <span id={statusId} hidden>
        {status}Stops selecting.
      </span>
    </>
  )
}

function Transcript({ turns, meta }: { turns: Turn[]; meta: ChatMeta }) {
  if (turns.length === 0) return <EmptyTranscript />
  return <Turns turns={turns} meta={meta} />
}

/**
 * Stays pinned to the newest line unless the user scrolled up: as turns stream in, and as
 * the composer's stack (queue, problems, the picked element) grows or shrinks under it.
 */
function Turns({ turns, meta }: { turns: Turn[]; meta: ChatMeta }) {
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current && turns.length) el.scrollTop = el.scrollHeight
  }, [turns])

  // The composer growing shrinks the transcript without scrolling it.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={scroller}
      data-transcript
      onScroll={(event) => {
        const el = event.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
      }}
      className="min-h-0 flex-1 select-text overflow-y-auto px-3 py-4"
    >
      <div className="flex flex-col gap-6">
        {turns.map((turn) => (
          <TurnView key={turn.id} turn={turn} showRedo={meta.redoTurnIds[0] === turn.id} />
        ))}
      </div>
    </div>
  )
}

function EmptyTranscript() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-8">
      <Message
        icon={<MousePointer2 className="size-4" aria-hidden="true" />}
        title="Point at something to change"
        actions={
          <Button icon={MousePointer2} onClick={() => gui.toggleSelect()}>
            Select element
          </Button>
        }
      >
        Pick an element in your app, then describe the change. Your agent edits the code and the
        preview updates live.
      </Message>
    </div>
  )
}
