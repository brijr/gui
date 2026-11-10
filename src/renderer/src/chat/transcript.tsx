import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { ChatMeta, Turn } from '../../../shared/types'
import { gui } from '../lib/api'
import { ErrorBoundary } from '../lib/error-boundary'
import { readableError } from '../lib/errors'
import { InlineError } from '../lib/field'
import { Archive, MessageSquare, SquarePen } from '../lib/icons'
import { Banner, Card, Message } from '../lib/surface'
import { Button, PromptButton } from '../lib/ui'
import { setDraft, useChat, waitingCard } from './store'
import { TurnLayout } from './turn-layout'
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
  /** Each turn's last measured height; `heights` is the copy the layout was made from. */
  const known = useRef(new Map<string, number>())
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [viewport, setViewport] = useState({ top: 0, height: 600, width: 0 })
  const layout = useMemo(() => new TurnLayout(turnIds, heights), [turnIds, heights])
  const currentLayout = useRef(layout)
  const currentWidth = useRef(viewport.width)
  const anchor = useRef<ReturnType<TurnLayout['anchor']>>(null)
  const scrollFrame = useRef<number | null>(null)
  const hint = turnIds.length >= LONG_CHAT && !running

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

  /**
   * Takes rows' new heights, and the panel's new width, for the layout. Away from the end, the
   * turn at the top of the view stays where it is while those around it change height.
   */
  const remeasure = useCallback((measured: [string, number][], widthChanged: boolean) => {
    const el = scroller.current
    // Hidden, every row measures nothing: keep the heights they had in view.
    if (!el || el.clientWidth === 0) return
    const changed = measured.filter(([id, height]) => {
      const old = known.current.get(id)
      return old === undefined || Math.abs(old - height) >= 0.5
    })
    if (!stick.current && (changed.length > 0 || widthChanged)) {
      anchor.current = currentLayout.current.anchor(el.scrollTop - TRANSCRIPT_INSET)
    }
    if (changed.length === 0) return
    for (const [id, height] of changed) known.current.set(id, height)
    setHeights(new Map(known.current))
  }, [])

  // Sizes are taken in the frame they change, before it's painted: dragging the panel's edge
  // rewraps every row each frame, and rows placed by the heights they had a frame ago draw
  // over each other.
  const [sizes] = useState(
    () =>
      new RowSizes((measured, resized) => {
        const el = scroller.current
        if (!el) return
        const widthChanged = resized && el.clientWidth !== currentWidth.current
        flushSync(() => {
          remeasure(measured, widthChanged)
          if (resized) readViewport()
        })
        anchor.current = null
        if (!resized) return
        if (stick.current && performance.now() - toggledAt.current >= TOGGLE_WINDOW) toEnd(el)
        readViewport()
      }),
  )

  useEffect(() => {
    presentation.retain(turnIds)
    const allowed = new Set(turnIds)
    const gone = [...known.current.keys()].filter((id) => !allowed.has(id))
    if (gone.length === 0) return
    for (const id of gone) known.current.delete(id)
    setHeights(new Map(known.current))
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: the hint below the turns coming or going moves the end too.
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
  }, [layout, viewport.width, hint, readViewport])
  // Rows that just mounted are measured before they're painted, wherever the layout guessed.
  useLayoutEffect(() => {
    const measured = sizes.takeMounted()
    if (measured.length > 0) remeasure(measured, false)
  })

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const stop = sizes.watch(el)
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
      stop()
      el.removeEventListener('wheel', intend)
      el.removeEventListener('touchmove', intend)
      el.removeEventListener('keydown', intend)
      el.removeEventListener('pointerdown', hold)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
    }
  }, [sizes])

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
        <div className="flex flex-col gap-6">
          <div className="relative shrink-0" style={{ height: layout.total }}>
            {indices.map((index) => (
              <TurnRow
                key={turnIds[index]}
                id={turnIds[index]}
                top={layout.offsets[index]}
                sizes={sizes}
                showRedo={meta.redoTurnIds[0] === turnIds[index]}
              />
            ))}
          </div>
          {hint && <LongChatHint />}
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

/**
 * Watches the transcript and its rows for size changes, and hands them over in the frame they
 * happen, before it's painted. A row is measured as it mounts, and watched from the next frame:
 * watched from inside a resize callback, the browser would report it a frame late, as an error.
 */
class RowSizes {
  private readonly observer: ResizeObserver
  private readonly ids = new Map<Element, string>()
  private readonly mounted = new Set<HTMLElement>()
  private readonly unwatched = new Set<Element>()
  private frame: number | null = null

  constructor(onResize: (measured: [string, number][], resized: boolean) => void) {
    this.observer = new ResizeObserver((entries) => {
      const measured: [string, number][] = []
      let resized = false
      for (const entry of entries) {
        const id = this.ids.get(entry.target)
        if (id === undefined) resized = true
        else {
          // The layout height, not getBoundingClientRect's: while the panel grows in (morph.ts)
          // it's scaled, and growing doesn't resize the row, so a scaled height would stay.
          const box = entry.borderBoxSize[0]?.blockSize
          measured.push([id, box ?? (entry.target as HTMLElement).offsetHeight])
        }
      }
      onResize(measured, resized)
    })
  }

  /** Watches the transcript itself, and the rows it holds, until the returned stop. */
  watch(scroller: HTMLElement) {
    this.observer.observe(scroller)
    this.watchSoon()
    return () => {
      this.observer.disconnect()
      if (this.frame !== null) cancelAnimationFrame(this.frame)
      this.frame = null
      for (const row of this.ids.keys()) this.unwatched.add(row)
    }
  }

  add(id: string, row: HTMLElement) {
    this.ids.set(row, id)
    this.mounted.add(row)
    return () => {
      this.ids.delete(row)
      this.mounted.delete(row)
      this.unwatched.delete(row)
      this.observer.unobserve(row)
    }
  }

  /** The rows mounted since last asked, measured now. */
  takeMounted() {
    const measured: [string, number][] = []
    for (const row of this.mounted) {
      const id = this.ids.get(row)
      if (id !== undefined) measured.push([id, row.offsetHeight])
      this.unwatched.add(row)
    }
    this.mounted.clear()
    this.watchSoon()
    return measured
  }

  private watchSoon() {
    if (this.unwatched.size === 0 || this.frame !== null) return
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      for (const row of this.unwatched) this.observer.observe(row)
      this.unwatched.clear()
    })
  }
}

/** Each row observes its own turn; streaming does not rerender the transcript shell. */
function TurnRow({
  id,
  top,
  sizes,
  showRedo,
}: {
  id: string
  top: number
  sizes: RowSizes
  showRedo: boolean
}) {
  const turn = useChat((s) => s.turnsById[id])
  const row = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = row.current
    return el ? sizes.add(id, el) : undefined
  }, [id, sizes])
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
    'Build Kiln, a booking app for pottery studios',
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
      <Message fill icon={MessageSquare} heading="Design on the canvas">
        Open a frame to point at what you want to change.
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
        heading="Ask about your project"
        actions={canvasEmpty ? <StarterPrompts prompts={STARTERS.build} /> : undefined}
      >
        Your agent can read and edit the code while the preview starts.
      </Message>
    )
  }
  // Nothing more to say here: the message box, and the line over it, say what's next.
  return <div className="min-h-0 flex-1" />
}
