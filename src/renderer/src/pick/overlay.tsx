import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { PickOverlayState, Point, Rect } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'

/** A press that moves less than this is a click; further, a drag for an area. */
const DRAG_THRESHOLD = 4
/** Smaller than this either way, a drag is taken as a click after all. */
const MIN_AREA = 8
/** How long the hint stays when picking starts */
const HINT_MS = 4000
/** Room the label needs above an outline to sit over it rather than inside it */
const LABEL_HEIGHT = 20
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

  // Each time picking starts the hint shows, then gets out of the way.
  useEffect(() => {
    if (state.run === 0) return
    setHintRun(state.run)
    const timer = setTimeout(() => setHintRun(0), HINT_MS)
    return () => clearTimeout(timer)
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
          {several && (
            <span className="absolute -top-2 -left-2 flex size-4 items-center justify-center rounded-full bg-accent text-caption font-medium text-accent-fg tabular-nums shadow-raised">
              {i + 1}
            </span>
          )}
        </Outline>
      ))}
      {state.hover && !area && (
        <>
          <Outline rect={state.hover.rect} kind="hover" />
          <Label rect={state.hover.rect}>
            {state.hover.name && <span className="font-medium">{state.hover.name}</span>}
            <span className="opacity-80 tabular-nums">{state.hover.size}</span>
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
    ? Math.min(rect.y + rect.height + 4, window.innerHeight - LABEL_HEIGHT)
    : rect.y >= LABEL_HEIGHT + 2
      ? rect.y - LABEL_HEIGHT - 2
      : Math.max(rect.y + 2, 2)
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
        'pointer-events-none absolute top-2 left-2 flex items-center gap-3 rounded-md bg-raised px-2.5 py-1.5 text-small text-muted shadow-popover transition-opacity duration-(--motion-panel)',
        shown ? 'opacity-100' : 'opacity-0',
      )}
    >
      <span>
        <span className="font-medium text-fg">Click</span> an element
      </span>
      <span>
        <span className="font-medium text-fg">Drag</span> for a screenshot
      </span>
      <span>
        <span className="font-medium text-fg">⇧</span> to pick more
      </span>
      <span>
        <span className="font-medium text-fg">Esc</span> when done
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
