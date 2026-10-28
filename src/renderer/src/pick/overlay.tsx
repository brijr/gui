import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { GuideOverlay, PickOverlayState, Point, Rect } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { Counter, Kbd } from '../lib/ui'

/** A press that moves less than this is a click; further, a drag for an area. */
const DRAG_THRESHOLD = 4
/** Smaller than this either way, a drag is taken as a click after all. */
const MIN_AREA = 8
/** The label's height (h-5) */
const LABEL_HEIGHT = 20
/** Between the label and the outline, so the label doesn't sit on what's above the element */
const LABEL_GAP = 4
/** Labels this close to the right edge hang from the outline's right end instead */
const LABEL_ROOM = 180

const IDLE: PickOverlayState = { hover: null, picked: [], busy: false, scale: 1, run: 0 }

/**
 * Picking, drawn over the preview (main/picker.ts lays this view over the page): the element
 * under the pointer with its name and size, what's been picked (numbered when there are
 * several), and an area being dragged out. A click picks the element; a drag picks the area as
 * a screenshot; with ⇧ either adds to what's picked and picking goes on. The wheel scrolls the
 * page underneath; Esc ends picking.
 */
export function PickOverlay() {
  const [state, setState] = useState<PickOverlayState>(IDLE)
  const [drag, setDrag] = useState<{ start: Point; end: Point } | null>(null)
  const [adding, setAdding] = useState(false)
  const [hintRun, setHintRun] = useState(0)
  const press = useRef<{ start: Point; dragging: boolean } | null>(null)
  const pending = useRef<{ at: Point | null; frame: number | null }>({ at: null, frame: null })

  useEffect(() => gui.onPickState(setState), [])

  // Keep the instructions until the user starts a pick, including time spent reading them.
  useEffect(() => {
    if (state.run === 0) return
    setHintRun(state.run)
  }, [state.run])

  // ⇧ can go down before the pointer moves, or while the window is elsewhere.
  useEffect(() => {
    const sync = (event: KeyboardEvent | PointerEvent) => setAdding(event.shiftKey)
    const reset = () => setAdding(false)
    window.addEventListener('keydown', sync)
    window.addEventListener('keyup', sync)
    window.addEventListener('pointermove', sync)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', sync)
      window.removeEventListener('keyup', sync)
      window.removeEventListener('pointermove', sync)
      window.removeEventListener('blur', reset)
    }
  }, [])

  /** One hover a frame, the latest: main measures what's under it. */
  const hover = (at: Point | null) => {
    const queued = pending.current
    queued.at = at
    if (queued.frame !== null) return
    queued.frame = requestAnimationFrame(() => {
      queued.frame = null
      gui.pickHover(queued.at)
    })
  }

  const pointAt = (event: ReactPointerEvent): Point => ({
    x: Math.min(Math.max(event.clientX, 0), window.innerWidth),
    y: Math.min(Math.max(event.clientY, 0), window.innerHeight),
  })

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    press.current = { start: pointAt(event), dragging: false }
    setHintRun(0)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const at = pointAt(event)
    const pressed = press.current
    if (!pressed) return hover(at)
    const moved = Math.hypot(at.x - pressed.start.x, at.y - pressed.start.y)
    if (!pressed.dragging && moved < DRAG_THRESHOLD) return
    if (!pressed.dragging) {
      pressed.dragging = true
      // The element outline would only get in the way of the area.
      hover(null)
    }
    setDrag({ start: pressed.start, end: at })
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pressed = press.current
    press.current = null
    setDrag(null)
    if (!pressed || event.button !== 0) return
    const at = pointAt(event)
    const area = rectBetween(pressed.start, at)
    if (pressed.dragging && area.width >= MIN_AREA && area.height >= MIN_AREA) {
      gui.pickArea(area, event.shiftKey)
    } else {
      gui.pickElement(pressed.start, event.shiftKey)
    }
    hover(at)
  }

  // Main gives this page the keyboard when picking starts; nothing in it has focus, so Esc is
  // heard on the window.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (press.current?.dragging) {
        // Esc mid-drag lets go of the area, and picking goes on.
        press.current = null
        setDrag(null)
        return
      }
      gui.stopSelecting()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Not picking: the agent is walking the user through the page.
  if (state.guide) return <Guide guide={state.guide} />

  const area = drag ? rectBetween(drag.start, drag.end) : null
  const several = state.picked.length > 1

  return (
    <div
      role="application"
      aria-label="Pick in the preview"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        press.current = null
        setDrag(null)
      }}
      onPointerLeave={() => {
        if (!press.current) hover(null)
      }}
      onWheel={(event) => {
        const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1
        gui.pickWheel(
          { x: event.clientX, y: event.clientY },
          event.deltaX * lines,
          event.deltaY * lines,
        )
      }}
      onContextMenu={(event) => event.preventDefault()}
      className={cn(
        'fixed inset-0 overflow-hidden outline-none',
        state.busy ? 'cursor-progress' : adding ? 'cursor-copy' : 'cursor-crosshair',
      )}
    >
      {state.picked.map((picked, i) => (
        <Outline key={picked.id} rect={picked.rect} kind="picked">
          {several && <Counter className="absolute -top-2 -left-2 shadow-raised">{i + 1}</Counter>}
        </Outline>
      ))}
      {state.hover && !area && (
        <>
          <Outline rect={state.hover.rect} kind="hover" />
          <Label rect={state.hover.rect}>
            {state.hover.name && <span className="font-medium">{state.hover.name}</span>}
            <span className="tabular-nums">{state.hover.size}</span>
          </Label>
        </>
      )}
      {area && (
        <>
          <div
            className="pointer-events-none absolute rounded-sm border border-accent bg-accent-soft"
            // The page outside the area dims, the way a screenshot tool shows what it takes.
            style={{ ...place(area), boxShadow: '0 0 0 100vmax var(--scrim)' }}
          />
          <Label rect={area} below>
            <span className="tabular-nums">
              {Math.round(area.width / state.scale)} × {Math.round(area.height / state.scale)}
            </span>
          </Label>
        </>
      )}
      <Hint shown={hintRun !== 0 && hintRun === state.run} />
    </div>
  )
}

/** Between the outline and the caption */
const CAPTION_GAP = 10
/** The caption's widest, and about its height for a line or two */
const CAPTION_WIDTH = 280
const CAPTION_HEIGHT = 64

/**
 * The agent's walkthrough (preview_point): what it points at, its caption beside it, and its
 * pointer gliding to each step and each input's target. A click lets the page have the pointer
 * back; the wheel still scrolls the page.
 */
function Guide({ guide }: { guide: GuideOverlay }) {
  // A caption on its own, with no input since, has no pointer.
  const target = guide.cursor ?? (guide.rect && center(guide.rect))
  return (
    <div
      onPointerDown={() => gui.endGuide()}
      onWheel={(event) => {
        const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1
        gui.pickWheel(
          { x: event.clientX, y: event.clientY },
          event.deltaX * lines,
          event.deltaY * lines,
        )
      }}
      className="fixed inset-0 overflow-hidden"
    >
      {guide.rect && (
        <div
          key={guide.step}
          data-guide-outline=""
          className="pointer-events-none absolute animate-row-fade rounded-sm border-2 border-accent shadow-[0_0_0_4px_var(--accent-soft)]"
          style={place(guide.rect)}
        />
      )}
      {guide.caption && (
        <div
          key={guide.step}
          role="status"
          aria-live="polite"
          className="pointer-events-none absolute max-w-70 animate-row-in rounded-lg border border-line bg-raised px-3 py-2 text-small text-fg shadow-popover motion-reduce:animate-row-fade"
          style={captionPlace(guide.rect)}
        >
          {guide.caption}
        </div>
      )}
      {target && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0 transition-transform duration-650 ease-out motion-reduce:transition-none"
          style={{ transform: `translate(${target.x}px, ${target.y}px)` }}
        >
          {guide.clicks > 0 && (
            <span
              key={guide.clicks}
              className="absolute -top-4 -left-4 size-8 animate-click-ring rounded-full border-2 border-accent motion-reduce:animate-row-fade"
            />
          )}
          <svg
            width="20"
            height="22"
            viewBox="0 0 20 22"
            className="drop-shadow-sm"
            aria-hidden="true"
          >
            <path
              d="M2 1.5v16.2l4.6-4.3 3.1 6.9 3-1.3-3-6.8 6.3-.3z"
              className="fill-accent stroke-knob"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      )}
    </div>
  )
}

/** Below what's pointed at, or above it when there's no room; top-left without it. */
function captionPlace(rect: Rect | null) {
  if (!rect) return { top: 12, left: 12 }
  const left = Math.min(Math.max(8, rect.x), Math.max(8, window.innerWidth - CAPTION_WIDTH - 8))
  const below = rect.y + rect.height + CAPTION_GAP
  if (below + CAPTION_HEIGHT <= window.innerHeight) return { top: below, left }
  if (rect.y - CAPTION_GAP - CAPTION_HEIGHT >= 0)
    return { bottom: window.innerHeight - rect.y + CAPTION_GAP, left }
  // Taller than the view: inside its top edge.
  return { top: Math.max(8, rect.y + CAPTION_GAP), left }
}

const center = (rect: Rect): Point => ({
  x: Math.min(Math.max(rect.x + rect.width / 2, 0), window.innerWidth),
  y: Math.min(Math.max(rect.y + rect.height / 2, 0), window.innerHeight),
})

function Outline({
  rect,
  kind,
  children,
}: {
  rect: Rect
  kind: 'hover' | 'picked'
  children?: ReactNode
}) {
  return (
    <div
      data-outline={kind}
      className={cn(
        'pointer-events-none absolute rounded-sm border-accent',
        kind === 'hover' ? 'border bg-accent-soft' : 'animate-row-fade border-2',
      )}
      style={place(rect)}
    >
      {children}
    </div>
  )
}

/** The outline's name tag: over its top-left corner, or inside it when there's no room above. */
function Label({
  rect,
  below = false,
  children,
}: {
  rect: Rect
  below?: boolean
  children: ReactNode
}) {
  const nearRight = rect.x > window.innerWidth - LABEL_ROOM
  const top = below
    ? Math.min(rect.y + rect.height + LABEL_GAP, window.innerHeight - LABEL_HEIGHT)
    : rect.y >= LABEL_HEIGHT + LABEL_GAP
      ? rect.y - LABEL_HEIGHT - LABEL_GAP
      : Math.max(rect.y + LABEL_GAP, 2)
  const horizontal = nearRight
    ? { right: Math.max(2, window.innerWidth - rect.x - rect.width) }
    : { left: Math.max(2, rect.x) }
  return (
    <div
      data-label=""
      className="pointer-events-none absolute flex h-5 max-w-full items-center gap-1.5 truncate rounded-sm bg-accent px-1.5 text-caption text-accent-fg shadow-raised"
      style={{ top, ...horizontal }}
    >
      {children}
    </div>
  )
}

function Hint({ shown }: { shown: boolean }) {
  return (
    <div
      aria-live="polite"
      className={cn(
        // As wide as its words, up to the overlay's width less the margins (a phone frame is
        // narrow): then whole phrases wrap to a second row, never a phrase across two.
        'pointer-events-none absolute top-2 right-2 left-2 flex w-fit flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-raised px-2.5 py-1.5 text-small text-muted shadow-popover transition-opacity duration-(--motion-panel) *:whitespace-nowrap',
        shown ? 'opacity-100' : 'opacity-0',
      )}
    >
      {/* Gestures in words, keys as keycaps */}
      <span>
        <span className="font-medium text-fg">Click</span> an element
      </span>
      <span>
        <span className="font-medium text-fg">Drag</span> for a screenshot
      </span>
      <span className="flex items-center gap-1">
        <Kbd>⇧</Kbd> to pick more
      </span>
      <span className="flex items-center gap-1">
        <Kbd>Esc</Kbd> when done
      </span>
    </div>
  )
}

function rectBetween(a: Point, b: Point): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

const place = (rect: Rect) => ({
  left: rect.x,
  top: rect.y,
  width: rect.width,
  height: rect.height,
})
