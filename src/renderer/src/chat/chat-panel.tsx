import { GripHorizontal, Maximize2, Minus, MousePointer2, SquarePen } from 'lucide-react'
import { type PointerEvent as ReactPointerEvent, useEffect, useRef } from 'react'
import type { ChatMeta, Turn } from '../../../shared/types'
import { grat } from '../lib/api'
import { cn } from '../lib/cn'
import { Button, IconButton, Spinner } from '../lib/ui'
import { Composer } from './composer'
import { connectChat, useChat } from './store'
import { TurnView } from './turn-view'

const PANEL_SHADOW = 'shadow-[0_4px_14px_rgb(0_0_0/0.16),0_0_0_0.5px_rgb(0_0_0/0.06)]'

export function ChatPanel() {
  useEffect(() => connectChat(), [])
  const meta = useChat((s) => s.meta)
  const turns = useChat((s) => s.turns)
  if (!meta) return null

  const running = turns.some((turn) => turn.status === 'running')

  return (
    <div className="h-dvh p-[18px]">
      {meta.minimized ? (
        <MiniPanel meta={meta} running={running} />
      ) : (
        <div
          className={cn(
            'flex h-full flex-col overflow-hidden rounded-xl border border-line-strong bg-raised',
            PANEL_SHADOW,
          )}
        >
          <Header meta={meta} />
          <Transcript turns={turns} meta={meta} />
          <Composer meta={meta} running={running} />
        </div>
      )}
    </div>
  )
}

/** Pointer drags move the native view; deltas are batched per frame. */
function onDragStart(event: ReactPointerEvent<HTMLElement>) {
  if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
  const el = event.currentTarget
  el.setPointerCapture(event.pointerId)
  let last = { x: event.screenX, y: event.screenY }
  let pending = { dx: 0, dy: 0 }
  let frame = 0

  const flush = () => {
    frame = 0
    if (pending.dx || pending.dy) grat.dragChat(pending.dx, pending.dy)
    pending = { dx: 0, dy: 0 }
  }
  const move = (e: PointerEvent) => {
    pending = { dx: pending.dx + e.screenX - last.x, dy: pending.dy + e.screenY - last.y }
    last = { x: e.screenX, y: e.screenY }
    frame ||= requestAnimationFrame(flush)
  }
  const end = () => {
    cancelAnimationFrame(frame)
    flush()
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', end)
    el.removeEventListener('pointercancel', end)
    grat.endDragChat()
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', end)
  el.addEventListener('pointercancel', end)
}

function StatusDot({ meta, running }: { meta: ChatMeta; running: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        meta.status === 'error' && 'bg-danger',
        (meta.status === 'starting' || running) && 'animate-pulse bg-warning',
        meta.status === 'ready' && !running && 'bg-success',
        meta.status === 'idle' && 'bg-subtle',
      )}
    />
  )
}

function Header({ meta }: { meta: ChatMeta }) {
  const running = meta.status === 'working'
  return (
    <div
      onPointerDown={onDragStart}
      className="flex h-10 shrink-0 cursor-grab items-center gap-2 border-b border-line pr-1.5 pl-3 active:cursor-grabbing"
    >
      <GripHorizontal className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
      <StatusDot meta={meta} running={running} />
      <span className="truncate font-medium">{meta.agentName}</span>
      {meta.modeName && (
        <span className="truncate rounded bg-hover px-1.5 py-px text-[10.5px] text-muted">
          {meta.modeName}
        </span>
      )}
      <div className="ml-auto flex items-center">
        <IconButton label="New chat (⇧⌘K)" onClick={() => grat.newSession()}>
          <SquarePen className="size-3.5" />
        </IconButton>
        <IconButton label="Minimize" onClick={() => grat.setMinimized(true)}>
          <Minus className="size-4" />
        </IconButton>
      </div>
    </div>
  )
}

function MiniPanel({ meta, running }: { meta: ChatMeta; running: boolean }) {
  return (
    <div
      onPointerDown={onDragStart}
      className={cn(
        'flex h-full cursor-grab items-center gap-2 rounded-full border border-line-strong bg-raised pr-1.5 pl-4 active:cursor-grabbing',
        PANEL_SHADOW,
      )}
    >
      {running ? <Spinner className="text-muted" /> : <StatusDot meta={meta} running={running} />}
      <span className="min-w-0 flex-1 truncate font-medium">
        {running ? 'Working…' : meta.agentName}
      </span>
      <IconButton label="Expand chat" onClick={() => grat.setMinimized(false)}>
        <Maximize2 className="size-3.5" />
      </IconButton>
    </div>
  )
}

function Transcript({ turns, meta }: { turns: Turn[]; meta: ChatMeta }) {
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    const el = scroller.current
    if (el && stick.current && turns.length) el.scrollTop = el.scrollHeight
  }, [turns])

  if (turns.length === 0) return <EmptyTranscript />

  const firstReverted = turns.find((turn) => turn.reverted)?.id

  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const el = event.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
      }}
      className="min-h-0 flex-1 select-text overflow-y-auto px-3 py-3"
    >
      <div className="flex flex-col gap-5">
        {turns.map((turn) => (
          <TurnView
            key={turn.id}
            turn={turn}
            showRedo={meta.canRedo && turn.id === firstReverted}
          />
        ))}
      </div>
    </div>
  )
}

function EmptyTranscript() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <p className="font-medium">Point at something to change</p>
      <p className="text-pretty text-muted">
        Pick an element in your app, then describe the change. Your agent edits the code and the
        preview updates live.
      </p>
      <Button onClick={() => grat.toggleSelect()}>
        <MousePointer2 className="size-3.5" aria-hidden="true" />
        Select element
      </Button>
    </div>
  )
}
