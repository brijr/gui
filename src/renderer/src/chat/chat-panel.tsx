import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
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
  TAB_ROW_HEIGHT,
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
import {
  ChevronDown,
  Ellipsis,
  Maximize2,
  MessageSquare,
  Minus,
  PanelLeft,
  PictureInPicture2,
  SquareArrowOutDownLeft,
  SquarePen,
} from '../lib/icons'
import { Badge, type Status, StatusDot } from '../lib/status'
import { PanelHeader } from '../lib/surface'
import { Button, IconButton, PRESS, Spinner } from '../lib/ui'
import { ArchivePopover } from './archive'
import { Composer } from './composer'
import { Morph } from './morph'
import { ProposalBar, ReviewSheet, useProposal, useProposalUpdates } from './proposal'
import { proposeDraft } from './proposal-state'
import { openShipSheet, ShipSheet, useShipSheet } from './ship-sheet'
import { showSourceControl } from './shipping-state'
import { connectChat, keyedAnswer, useChat, waitingCard } from './store'
import { Transcript } from './transcript'
import { closeVersions, toggleVersions, useVersions, VersionsSheet } from './versions-sheet'

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
    if (useShipSheet.getState().open || useVersions.getState().open) return
    if (!allow && typing(event.target)) return
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
  // The agent's proposal goes on the bar's button, and into Source Control when it's open.
  useEffect(
    () =>
      gui.onShipDraft((draft) => {
        proposeDraft(draft)
        if (useShipSheet.getState().open) openShipSheet(draft)
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
          !meta.popped && 'border-line-strong',
          !meta.popped && (meta.sidebarSide === 'left' ? 'border-r' : 'border-l'),
        )}
      >
        {!meta.popped && (
          <ResizeHandle edge={meta.sidebarSide === 'left' ? 'right' : 'left'} docked />
        )}
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
  const versioning = useVersions((s) => s.open)
  const reviewing = useProposal((s) => s.reviewing)
  if (shipping) return <ShipSheet />
  if (versioning) return <VersionsSheet />
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

/** How far an arrow key moves a resize handle, in px. */
const RESIZE_STEP = 16

/**
 * An invisible handle that resizes the panel; main keeps the panel inside the window. The
 * sidebar's, and the floating panel's left and top edges, are also separators the keyboard
 * reaches, whose arrow keys resize it; the rest are for the pointer.
 */
function ResizeHandle({ edge, docked = false }: { edge: PanelEdge; docked?: boolean }) {
  const handle = useRef<HTMLDivElement>(null)
  const keyboard = docked || edge === 'left' || edge === 'top'
  const sideways = edge === 'left' || edge === 'right'
  // What it resizes, for assistive tech: the panel's width or height.
  const [size, setSize] = useState(0)
  useLayoutEffect(() => {
    const el = handle.current
    const panel =
      el?.closest<HTMLElement>('[data-chat-panel]') ??
      el?.parentElement?.querySelector<HTMLElement>('[data-chat-panel]')
    if (!keyboard || !panel) return
    const observer = new ResizeObserver(() =>
      setSize(Math.round(sideways ? panel.offsetWidth : panel.offsetHeight)),
    )
    observer.observe(panel)
    return () => observer.disconnect()
  }, [keyboard, sideways])

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
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const moves: Record<string, [number, number]> = sideways
      ? { ArrowLeft: [-RESIZE_STEP, 0], ArrowRight: [RESIZE_STEP, 0] }
      : { ArrowUp: [0, -RESIZE_STEP], ArrowDown: [0, RESIZE_STEP] }
    const move = moves[event.key]
    if (!move) return
    event.preventDefault()
    gui.resizeChat(edge, ...move)
  }
  // The pointer-only ones are hidden from assistive tech.
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> can't hold the keyboard to resize.
    <div
      ref={handle}
      role="separator"
      tabIndex={keyboard ? 0 : undefined}
      aria-hidden={keyboard ? undefined : true}
      aria-label={keyboard ? 'Resize chat' : undefined}
      aria-orientation={keyboard ? (sideways ? 'vertical' : 'horizontal') : undefined}
      aria-valuenow={keyboard ? size : undefined}
      aria-valuetext={keyboard ? `${size} pixels ${sideways ? 'wide' : 'tall'}` : undefined}
      onKeyDown={keyboard ? onKeyDown : undefined}
      onKeyUp={keyboard ? () => gui.endResizeChat() : undefined}
      onPointerDown={onPointerDown}
      className={cn(
        'absolute z-sticky outline-none after:absolute after:opacity-0 after:transition-opacity hover:after:opacity-70 focus-visible:after:opacity-100',
        docked
          ? edge === 'left'
            ? DOCKED_CLASS.replaceAll('right-0', 'left-0')
            : DOCKED_CLASS
          : EDGE_CLASS[edge],
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
  return (
    <PanelHeader
      onPointerDown={titleBar ? undefined : onDragStart}
      // As the sidebar (or popped out) it's the window's title bar: as tall as the toolbar,
      // or the tab row beside it while that shows, with the traffic lights at its start
      // (outside full screen), and what the window is dragged by. The name still starts the
      // line, after them.
      style={
        titleBar
          ? {
              height: meta.tabRow ? TAB_ROW_HEIGHT : TOOLBAR_HEIGHT,
              paddingLeft: meta.trafficLights ? TRAFFIC_LIGHTS_INSET : undefined,
            }
          : undefined
      }
      className={titleBar ? 'drag' : 'cursor-grab active:cursor-grabbing'}
      // In an icon's 14px box, so the dot and the name sit over the source control bar's
      // branch icon and branch name.
      leading={
        <span className="mr-0.5 flex size-3.5 shrink-0 items-center justify-center">
          <StatusDot status={agentStatus(meta, running)} />
        </span>
      }
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
              label={meta.docked ? 'Show as floating panel' : 'Show as sidebar'}
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
          <MoreButton />
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
          // Out of the title bar's drag area, or its tooltip never shows.
          <Badge title="The agent's mode" className="no-drag">
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
function MoreButton() {
  const button = useRef<HTMLButtonElement>(null)
  const [archive, setArchive] = useState(false)
  useEffect(
    () =>
      gui.onChatMenuChoice((choice) => {
        if (choice === 'versions') toggleVersions()
        else if (choice === 'archive') setArchive(true)
        else {
          // The toolbar's branch menu
          closeVersions()
          showSourceControl(choice)
        }
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
          gui.showChatMenu({ x: Math.round(box.left), y: Math.round(box.bottom + 4) })
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
    <Button
      size="sm"
      variant="ghost"
      trailingIcon={ChevronDown}
      aria-haspopup="menu"
      aria-label={`Switch agent, ${name}`}
      title="Switch agent"
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect()
        gui.showAgentMenu({ x: box.left, y: box.bottom + 4 })
      }}
      // Pulled into the header's inset so the name lines up with the panel's text.
      className="-ml-2 min-w-0 text-body text-fg"
    >
      <span className="truncate">{name}</span>
    </Button>
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
