import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChatMeta, Turn } from '../../../shared/types'
import { gui } from '../lib/api'
import { ErrorBoundary } from '../lib/error-boundary'
import { readableError } from '../lib/errors'
import { InlineError } from '../lib/field'
import { Archive, MessageSquare, SquarePen } from '../lib/icons'
import { Banner, Card, Message } from '../lib/surface'
import { Button, PromptButton } from '../lib/ui'
import { setDraft, useChat, waitingCard } from './store'
import { type TurnHeight, TurnLayout } from './turn-layout'
import { TurnPresentation, TurnPresentationProvider } from './turn-presentation'
import { TurnView } from './turn-view'

export function Transcript({ turnIds, meta }: { turnIds: string[]; meta: ChatMeta }) {
  if (turnIds.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <EmptyTranscript
          canSelect={meta.canSelect}
          canvas={meta.canvas}
          canvasEmpty={meta.canvasEmpty}
        />
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
/**
 * How long after the user's own wheel, touch or key a scroll counts as theirs. Other scrolls
 * come from layout (the panel growing clamps the position) and never let go of the end.
 */
const INTENT_WINDOW = 250

/** After New chat: the chat it replaced is in the archive, and can come straight back. */
function ArchivedNotice({ archived }: { archived: NonNullable<ChatMeta['archived']> }) {
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  return (
    <Banner
      wrap
      edge="bottom"
      icon={Archive}
      actions={
        <Button
          size="sm"
          variant="ghost"
          loading={opening}
          onClick={() => {
            setOpening(true)
            setError(null)
            // Opened, this chat is replaced and the notice goes with it.
            gui
              .openChat(archived.id)
              .catch((err: unknown) => setError(readableError(err)))
              .finally(() => setOpening(false))
          }}
        >
          Reopen
        </Button>
      }
    >
      <p>Your chat with {archived.agentName} is archived.</p>
      {error && <InlineError>{error}</InlineError>}
    </Banner>
  )
}

/** Past this many messages, the transcript suggests starting over (agents lose the thread). */
const LONG_CHAT = 150

function LongChatHint() {
  return (
    <Card tone="inset" padding="compact" className="flex items-center gap-2">
      <p className="min-w-0 flex-1 text-small text-muted">
        This chat is long. Agents stay sharper in a fresh one; this one stays in the archive.
      </p>
      <Button size="sm" icon={SquarePen} onClick={() => gui.newSession()}>
        New chat
      </Button>
    </Card>
  )
}

/**
 * Stays pinned to the newest line unless the user scrolled up: as turns stream in, as what's
 * in them grows (a permission card, an image loading), and as the composer's stack (queue,
 * problems, the picked element) grows or shrinks under it. A new turn is the user's own
 * message, so it always comes into view and the transcript follows from there, wherever they
 * had scrolled to. So does a new permission question: the agent can't go on until it's
 * answered, so its buttons come into view. Only the user's own scrolling lets go of the end;
 * a scroll the layout caused (a row not measured yet, the panel resizing) never does.
 */
const TRANSCRIPT_INSET = 16

function Turns({ turnIds, meta }: { turnIds: string[]; meta: ChatMeta }) {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const toggledAt = useRef(Number.NEGATIVE_INFINITY)
  /** When the user last wheeled, touched or pressed a key over the transcript. */
  const intentAt = useRef(Number.NEGATIVE_INFINITY)
  /** The pointer is down on the transcript: it may be dragging the scrollbar. */
  const held = useRef(false)
  const newest = turnIds.at(-1)
  const waiting = useChat((s) => waitingCard(s.turns)?.item.id ?? null)
  const running = useChat((s) => s.turnsById[newest ?? '']?.status === 'running')
  // Running turns stay mounted even when the user reads far back. This also retains waiting
  // permission cards and their view-transition counterparts without mounting archived turns.
  const active = useChat((s) =>
    s.turns
      .filter((turn) => turn.status === 'running')
      .map((turn) => turn.id)
      .join('\0'),
  )
  const [presentation] = useState(() => new TurnPresentation())
  const [heights, setHeights] = useState<Map<string, TurnHeight>>(() => new Map())
  const [viewport, setViewport] = useState({ top: 0, height: 600, width: 0 })
  const layout = useMemo(
    () => new TurnLayout(turnIds, heights, viewport.width),
    [turnIds, heights, viewport.width],
  )
  const currentLayout = useRef(layout)
  const currentWidth = useRef(viewport.width)
  const anchor = useRef<ReturnType<TurnLayout['anchor']>>(null)
  const pendingHeights = useRef(new Map<string, TurnHeight>())
  const measureFrame = useRef<number | null>(null)
  const scrollFrame = useRef<number | null>(null)

  const readViewport = useCallback(() => {
    const el = scroller.current
    if (!el) return
    setViewport((before) => {
      const next = { top: el.scrollTop, height: el.clientHeight, width: el.clientWidth }
      return before.top === next.top && before.height === next.height && before.width === next.width
        ? before
        : next
    })
  }, [])

  const measure = useCallback((id: string, height: number) => {
    const width = scroller.current?.clientWidth ?? 0
    pendingHeights.current.set(id, { height, width })
    if (measureFrame.current !== null) return
    measureFrame.current = requestAnimationFrame(() => {
      measureFrame.current = null
      const el = scroller.current
      if (el && !stick.current) {
        anchor.current = currentLayout.current.anchor(el.scrollTop - TRANSCRIPT_INSET)
      }
      const pending = pendingHeights.current
      pendingHeights.current = new Map()
      setHeights((before) => {
        let next = before
        for (const [id, size] of pending) {
          const old = before.get(id)
          if (old?.width === size.width && Math.abs(old.height - size.height) < 0.5) continue
          if (next === before) next = new Map(before)
          next.set(id, size)
        }
        return next
      })
    })
  }, [])

  useEffect(() => {
    presentation.retain(turnIds)
    const allowed = new Set(turnIds)
    setHeights((before) => {
      if ([...before.keys()].every((id) => allowed.has(id))) return before
      return new Map([...before].filter(([id]) => allowed.has(id)))
    })
  }, [presentation, turnIds])

  // A sent/queued message must already be in view when the store's transition takes its
  // after snapshot. Layout effects restore the bottom and mounted window before paint.
  // A new message, or a new question from the agent: back to the end, wherever the user was.
  const pin = useCallback(() => {
    stick.current = true
    toggledAt.current = Number.NEGATIVE_INFINITY
    anchor.current = null
    toEnd(scroller.current)
    readViewport()
  }, [readViewport])
  useLayoutEffect(() => {
    if (newest !== undefined) pin()
  }, [newest, pin])
  useLayoutEffect(() => {
    if (waiting !== null) pin()
  }, [waiting, pin])
  useLayoutEffect(() => {
    currentLayout.current = layout
    currentWidth.current = viewport.width
    const el = scroller.current
    if (!el) return
    if (stick.current && performance.now() - toggledAt.current >= TOGGLE_WINDOW) toEnd(el)
    else if (anchor.current) {
      const restored = layout.restore(anchor.current)
      if (restored !== null) el.scrollTop = restored + TRANSCRIPT_INSET
    }
    anchor.current = null
    readViewport()
  }, [layout, viewport.width, readViewport])

  useEffect(() => {
    const el = scroller.current
    const inner = content.current
    if (!el || !inner) return
    const observer = new ResizeObserver(() => {
      if (!stick.current && el.clientWidth !== currentWidth.current) {
        anchor.current = currentLayout.current.anchor(el.scrollTop - TRANSCRIPT_INSET)
      }
      if (stick.current && performance.now() - toggledAt.current >= TOGGLE_WINDOW) toEnd(el)
      readViewport()
    })
    observer.observe(el)
    observer.observe(inner)
    // What the user does to scroll, so onScroll can tell their scrolling from the layout's.
    const intend = () => {
      intentAt.current = performance.now()
    }
    const hold = () => {
      held.current = true
    }
    const release = () => {
      held.current = false
    }
    const passive = { passive: true }
    el.addEventListener('wheel', intend, passive)
    el.addEventListener('touchmove', intend, passive)
    el.addEventListener('keydown', intend)
    el.addEventListener('pointerdown', hold)
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      observer.disconnect()
      el.removeEventListener('wheel', intend)
      el.removeEventListener('touchmove', intend)
      el.removeEventListener('keydown', intend)
      el.removeEventListener('pointerdown', hold)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      if (measureFrame.current !== null) cancelAnimationFrame(measureFrame.current)
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
    }
  }, [readViewport])

  const top = stick.current
    ? Math.max(0, layout.total - viewport.height)
    : Math.max(0, viewport.top - TRANSCRIPT_INSET)
  const pinned = active ? active.split('\0') : []
  const indices = layout.window(top, viewport.height, pinned)
  return (
    <TurnPresentationProvider state={presentation}>
      <div
        ref={scroller}
        data-transcript
        data-clip
        // Virtual rows use an explicit turn/offset anchor; browser anchoring against an
        // unmounted row would apply a second compensation.
        style={{ overflowAnchor: 'none' }}
        onScroll={(event) => {
          const el = event.currentTarget
          anchor.current = null
          if (el.scrollHeight - el.scrollTop - el.clientHeight < STICK_SLOP) stick.current = true
          else if (held.current || performance.now() - intentAt.current < INTENT_WINDOW) {
            stick.current = false
          }
          if (scrollFrame.current !== null) return
          scrollFrame.current = requestAnimationFrame(() => {
            scrollFrame.current = null
            readViewport()
          })
        }}
        onClickCapture={(event) => {
          if ((event.target as Element).closest('[aria-expanded]')) {
            toggledAt.current = performance.now()
            stick.current = false
          }
        }}
        className="min-h-0 flex-1 select-text overflow-y-auto scroll-stable scroll-fade px-3 py-4"
      >
        <div ref={content} className="flex flex-col gap-6">
          <div className="relative shrink-0" style={{ height: layout.total }}>
            {indices.map((index) => (
              <TurnRow
                key={turnIds[index]}
                id={turnIds[index]}
                top={layout.offsets[index]}
                measure={measure}
                showRedo={meta.redoTurnIds[0] === turnIds[index]}
              />
            ))}
          </div>
          {turnIds.length >= LONG_CHAT && !running && <LongChatHint />}
        </div>
      </div>
      <Announcer />
    </TurnPresentationProvider>
  )
}

/**
 * What a screen reader hears while the agent works, which the screen shows elsewhere: a
 * question it's waiting on, and its turn ending. Not the reply as it streams, and not an
 * error, which reads itself out (Note's alert). Keyed by the turn or card it's about, so each
 * is read once.
 */
function announcement(turns: Turn[], agent = 'The agent'): string {
  const waiting = waitingCard(turns)
  if (waiting) return `${waiting.item.id}\0Permission needed: ${waiting.item.title}`
  const last = turns.at(-1)
  if (last?.status === 'done') return `${last.id}\0${agent} finished`
  if (last?.status === 'cancelled') return `${last.id}\0${agent} stopped`
  return ''
}

function Announcer() {
  const latest = useChat((s) => announcement(s.turns, s.meta?.agentName))
  // What was so when the transcript appeared is history, not news.
  const [history] = useState(latest)
  return (
    <p role="status" className="sr-only">
      {latest === history ? '' : latest.split('\0')[1]}
    </p>
  )
}

/** Each row observes its own turn; streaming does not rerender the transcript shell. */
function TurnRow({
  id,
  top,
  measure,
  showRedo,
}: {
  id: string
  top: number
  measure: (id: string, height: number) => void
  showRedo: boolean
}) {
  const turn = useChat((s) => s.turnsById[id])
  const row = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = row.current
    if (!el) return
    // The layout height, not getBoundingClientRect's: while the panel grows in (morph.ts) it's
    // scaled, and growing doesn't resize the row, so a scaled height would never be corrected.
    // Observing reports the row once to start.
    const observer = new ResizeObserver(([entry]) => {
      measure(id, entry.borderBoxSize[0]?.blockSize ?? el.offsetHeight)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [id, measure])
  if (!turn) return null
  return (
    <div ref={row} data-turn-row={id} className="absolute inset-x-0 top-0" style={{ top }}>
      <ErrorBoundary resetKey={turn}>
        <TurnView turn={turn} showRedo={showRedo} />
      </ErrorBoundary>
    </div>
  )
}

/** Something to start from in an empty chat: building an app from nothing, or changing one. */
const STARTERS = {
  build: [
    'Build a landing page for a coffee shop',
    'Build a portfolio site with a project gallery',
    'Build a sign-up form with friendly validation',
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
          <PromptButton
            onClick={() => {
              setDraft(prompt)
              document.querySelector<HTMLTextAreaElement>('[data-composer]')?.focus()
            }}
          >
            {prompt}
          </PromptButton>
        </li>
      ))}
    </ul>
  )
}

function EmptyTranscript({
  canSelect,
  canvas,
  canvasEmpty,
}: {
  canSelect: boolean
  canvas: boolean
  canvasEmpty: boolean
}) {
  // An empty canvas says what to ask for itself: the chat doesn't say it again.
  if (canvasEmpty && !canSelect) return <div className="min-h-0 flex-1" />
  // On a canvas's frames there's no app to point at until one is open.
  if (canvas && !canSelect) {
    return (
      <Message fill icon={MessageSquare} title="Design on the canvas">
        Ask for a page, or a few versions of one, and each lands on the canvas as a frame. Open a
        frame to point at any part of it to change.
      </Message>
    )
  }
  // Nothing on screen to point at yet (the app is starting, or failed to): say so, and
  // still take a message, which needs no element.
  if (!canSelect) {
    return (
      <Message
        fill
        icon={MessageSquare}
        title="Ask about your project"
        actions={<StarterPrompts prompts={STARTERS.build} />}
      >
        Once your app shows in the preview, you can point at any part of it to change. Until then,
        your agent can still read and edit the code.
      </Message>
    )
  }
  // Nothing more to say here: the message box, and the line over it, say what's next.
  return <div className="min-h-0 flex-1" />
}
