import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type {
  GuideOverlay,
  PickOverlayState,
  Point,
  Rect,
  VariationsBar,
} from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { ChevronLeft, ChevronRight, Undo2, X } from '../lib/icons'
import { Button, Counter, IconButton, Kbd } from '../lib/ui'

/** A press that moves less than this is a click; further, a drag for an area. */
const DRAG_THRESHOLD = 4
/** Smaller than this either way, a drag is taken as a click after all. */
const MIN_AREA = 8
/** The longest main lingers for a double-click's second click (picker.ts `doubleClickMs`) */
const SECOND_CLICK_MS = 800
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
 * a screenshot; with ⇧ either adds to what's picked and picking goes on. A double-click on text
 * edits it in place, in the page. The wheel scrolls the page underneath; Esc ends picking.
 */
export function PickOverlay() {
  const [state, setState] = useState<PickOverlayState>(IDLE)
  const [drag, setDrag] = useState<{ start: Point; end: Point } | null>(null)
  const [adding, setAdding] = useState(false)
  const [hintRun, setHintRun] = useState(0)
  const press = useRef<{ start: Point; dragging: boolean; second: boolean } | null>(null)
  /**
   * Where a plain click last picked, and when: a second click there before main stops
   * lingering makes it a double-click, which edits the text there.
   */
  const clicked = useRef<{ at: Point; time: number } | null>(null)
  /** A press at `at` is a double-click's second: the click before it was there, just now. */
  const secondClick = (at: Point) => {
    const first = clicked.current
    clicked.current = null
    return (
      !!first &&
      performance.now() - first.time < SECOND_CLICK_MS &&
      Math.hypot(at.x - first.at.x, at.y - first.at.y) < DRAG_THRESHOLD
    )
  }
  const pending = useRef<{ at: Point | null; frame: number | null }>({ at: null, frame: null })

  useEffect(() => gui.onPickState(setState), [])

  // Keep the instructions until the user starts a pick, including time spent reading them.
  // A new run of picking has no click before it to make a double-click with.
  useEffect(() => {
    clicked.current = null
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
    const start = pointAt(event)
    // Before main's linger has reached this page, a quick second click lands here.
    press.current = { start, dragging: false, second: secondClick(start) }
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
    } else if (pressed.second) {
      gui.editPreviewText(pressed.start)
    } else {
      // Picks at once. A plain click ends picking, but main keeps this overlay a moment
      // (`linger`) for a second click, which would make it a double-click.
      clicked.current = event.shiftKey ? null : { at: pressed.start, time: performance.now() }
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

  // Not picking: the agent is walking the user through the page, or showing versions (or both).
  const variations = state.variations && <Variations bar={state.variations} />
  if (state.guide)
    return (
      <>
        <Guide guide={state.guide} />
        {variations}
      </>
    )
  // The bar on its own: this overlay is only as big as it is (main/picker.ts).
  if (variations) return variations
  // Picking just ended on a click: nothing drawn, and main has this overlay over only the spot
  // it was on, so a second click there makes it a double-click, which edits the text (main
  // drops the pick the first one made). A click anywhere else reaches the page.
  if (state.linger)
    return (
      <div
        aria-hidden="true"
        className="fixed inset-0"
        onPointerDown={(event) => {
          const first = clicked.current
          clicked.current = null
          if (event.button !== 0 || !first) return
          if (performance.now() - first.time < SECOND_CLICK_MS) gui.editPreviewText(first.at)
        }}
      />
    )

  const area = drag ? rectBetween(drag.start, drag.end) : null
  const several = state.picked.length > 1

  return (
    <div
      role="application"
      aria-label="Design mode"
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
            <Counter
              className={cn(
                'absolute shadow-raised',
                // Inside the corner when the element is at the view's edge, where it'd be cut off.
                picked.rect.x < 8 || picked.rect.y < 8 ? 'top-0.5 left-0.5' : '-top-2 -left-2',
              )}
            >
              {i + 1}
            </Counter>
          )}
        </Outline>
      ))}
      {state.hover && !area && (
        <>
          <Outline rect={state.hover.rect} kind="hover" />
          <Label rect={state.hover.rect}>
            {state.hover.name && <span className="shrink-0 font-medium">{state.hover.name}</span>}
            {state.hover.component && (
              <span className="min-w-0 truncate opacity-75">{state.hover.component}</span>
            )}
            <span className="shrink-0 tabular-nums opacity-75">{state.hover.size}</span>
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

/** Between the outline and the caption: 8px clear of the outline's 4px ring */
const CAPTION_GAP = 12
/** Between the caption and the view's edges */
const CAPTION_EDGE = 8
/** The caption's widest, and about its height for a line or two */
const CAPTION_WIDTH = 280
const CAPTION_HEIGHT = 64

/** How long the note on a held website stays after a click */
const HELD_NOTE_MS = 3000
/** Between the user's pointer and that note */
const HELD_NOTE_OFFSET = 16
/** How long the pointer shows a key the agent pressed */
const KEY_SHOWN_MS = 900

/**
 * The agent in the preview: its pointer gliding to each input's target, and in a walkthrough
 * (preview_point) what it points at, with its caption beside it. A click lets the page have the
 * pointer back, except on a website while the agent's turn uses it (`held`): there a click only
 * says so, and the page is left alone. The wheel still scrolls the page.
 */
function Guide({ guide }: { guide: GuideOverlay }) {
  const [announcementsReady, setAnnouncementsReady] = useState(false)
  useEffect(() => setAnnouncementsReady(true), [])
  // A caption on its own, with no input since, has no pointer.
  const target = guide.cursor ?? (guide.rect && center(guide.rect))
  const pressed = usePressedKey(guide.key)
  const [heldNote, setHeldNote] = useState<Point | null>(null)
  useEffect(() => {
    if (!heldNote) return
    const timer = setTimeout(() => setHeldNote(null), HELD_NOTE_MS)
    return () => clearTimeout(timer)
  }, [heldNote])
  return (
    <div
      onPointerDown={(event) => {
        if (!guide.held) return gui.endGuide()
        setHeldNote({ x: event.clientX, y: event.clientY })
      }}
      data-guide={guide.held ? 'held' : ''}
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
          // Its own key: one shared with the caption makes React lose the old outline on the
          // next step, and leave it on the page.
          key={`outline-${guide.step}`}
          data-guide-outline=""
          className="pointer-events-none absolute motion-safe:animate-fade-in motion-reduce:animate-row-fade rounded-sm border-2 border-accent ring-4 ring-accent-soft"
          style={place(guide.rect)}
        />
      )}
      <div role="status" aria-live="polite">
        {announcementsReady && guide.caption && (
          <div
            key={`caption-${guide.step}`}
            className="pointer-events-none absolute max-w-70 animate-row-in rounded-lg border border-line bg-overlay px-3 py-2 text-small text-fg shadow-popover motion-reduce:animate-row-fade"
            style={captionPlace(guide.rect)}
          >
            {guide.caption}
          </div>
        )}
      </div>
      {target && (
        <div
          aria-hidden="true"
          data-guide-pointer=""
          // Fades in where it first shows, then glides as long as main waits for it (`glide`).
          className="pointer-events-none absolute top-0 left-0 transition-transform ease-in-out motion-safe:animate-fade-in motion-reduce:transition-none"
          style={{
            transform: `translate(${target.x}px, ${target.y}px)`,
            transitionDuration: `${guide.glide}ms`,
          }}
        >
          {guide.clicks > 0 && (
            <span
              key={guide.clicks}
              className="absolute -top-4 -left-4 size-8 animate-click-ring rounded-full border-2 border-accent motion-reduce:hidden"
            />
          )}
          <svg
            width="20"
            height="22"
            viewBox="0 0 20 22"
            // The tip (2, 1.5) on the point, not the box's corner.
            className="-mt-[1.5px] -ml-0.5 drop-shadow-pointer"
            aria-hidden="true"
          >
            <path
              d="M2 1.5v16.2l4.6-4.3 3.1 6.9 3-1.3-3-6.8 6.3-.3z"
              className="fill-accent stroke-knob"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
          <span className="absolute top-4 left-3 inline-flex items-center gap-1 rounded-full bg-accent px-1.5 py-0.5 text-caption font-medium whitespace-nowrap text-knob drop-shadow-pointer select-none">
            Gui
            {pressed && (
              <Kbd
                key={pressed.presses}
                data-guide-key=""
                tone="inherit"
                className="h-3.5 motion-safe:animate-fade-in"
              >
                {pressed.label}
              </Kbd>
            )}
          </span>
        </div>
      )}
      {heldNote && guide.held && (
        <div
          role="status"
          data-guide-held=""
          className="pointer-events-none absolute max-w-70 motion-safe:animate-fade-in motion-reduce:animate-row-fade rounded-lg border border-line bg-overlay px-3 py-2 text-small text-fg shadow-popover"
          style={notePlace(heldNote)}
        >
          The agent is using this website. Stop it to use it yourself.
        </div>
      )}
    </div>
  )
}

/** The key the agent pressed last, for KEY_SHOWN_MS after each press; null otherwise. */
function usePressedKey(key: GuideOverlay['key']) {
  const presses = key?.presses ?? 0
  const label = key?.label ?? ''
  const [shown, setShown] = useState<{ label: string; presses: number } | null>(null)
  // A key pressed before this pointer showed isn't news.
  const seen = useRef(presses)
  useEffect(() => {
    if (presses === seen.current) return
    seen.current = presses
    setShown({ label, presses })
    const timer = setTimeout(() => setShown(null), KEY_SHOWN_MS)
    return () => clearTimeout(timer)
  }, [presses, label])
  return shown
}

/**
 * The versions the agent wrote of an element (preview_variations), in the preview's bottom-left
 * corner: ‹ › flip them, as do ← and → here or in the preview, and the page shows each at once,
 * never animated. Use this asks the agent to keep the one showing; × or Esc discards them all,
 * undoing the message that made them (asking first when later messages would go too). Main
 * places it and fits the overlay to it, so it reports its size.
 */
function Variations({ bar }: { bar: VariationsBar }) {
  const ref = useRef<HTMLDivElement>(null)
  const asking = bar.confirm !== null
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const report = () => {
      const { width, height } = element.getBoundingClientRect()
      gui.variationsSize(width, height)
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        gui.variations(event.key === 'ArrowLeft' ? 'previous' : 'next')
      } else if (event.key === 'Escape') {
        event.preventDefault()
        gui.variations(asking ? 'cancel' : 'discard')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [asking])
  const later = bar.confirm === 1 ? '1 later message' : `${bar.confirm} later messages`
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Versions"
      data-variations=""
      // A walkthrough's overlay ends on a click; one here is the bar's.
      onPointerDown={(event) => event.stopPropagation()}
      className="absolute flex w-max flex-col rounded-lg border border-line bg-overlay p-1 text-small text-fg shadow-popover"
      style={{ left: bar.at.x, top: bar.at.y, maxWidth: bar.room }}
    >
      {asking ? (
        <div className="flex items-center gap-1">
          <p role="status" className="px-2 text-muted">
            Undo this and {later}? You can redo.
          </p>
          <Button variant="ghost" className="shrink-0" onClick={() => gui.variations('cancel')}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={Undo2}
            className="shrink-0"
            onClick={() => gui.variations('confirm')}
          >
            Undo
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <IconButton
            icon={ChevronLeft}
            label="Previous version"
            title="Previous version (←)"
            aria-disabled={bar.busy}
            onClick={() => gui.variations('previous')}
          />
          <IconButton
            icon={ChevronRight}
            label="Next version"
            title="Next version (→)"
            aria-disabled={bar.busy}
            onClick={() => gui.variations('next')}
          />
          {/* Every label in one cell, so the bar is as wide as the longest and never jumps. */}
          <span aria-live="polite" className="grid min-w-0 px-1.5 tabular-nums">
            {bar.labels.map((label, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: the versions don't change order
                key={i}
                aria-hidden={i !== bar.index}
                data-variation-label={i === bar.index ? '' : undefined}
                className={cn(
                  'col-start-1 row-start-1 max-w-56 truncate',
                  i !== bar.index && 'invisible',
                )}
              >
                {label}
              </span>
            ))}
          </span>
          <Button
            variant="primary"
            className="shrink-0"
            aria-disabled={bar.busy}
            onClick={() => gui.variations('use')}
          >
            Use this
          </Button>
          <IconButton
            icon={X}
            label="Discard versions"
            loading={bar.busy}
            onClick={() => gui.variations('discard')}
          />
        </div>
      )}
      {bar.error && (
        <p role="alert" className="max-w-72 px-2 pt-1 pb-1.5 text-pretty text-danger">
          {bar.error}
        </p>
      )}
    </div>
  )
}

/** Beside the user's pointer, kept inside the view. */
function notePlace(at: Point) {
  const left = Math.min(at.x + HELD_NOTE_OFFSET, Math.max(8, window.innerWidth - CAPTION_WIDTH - 8))
  const below = at.y + HELD_NOTE_OFFSET
  if (below + CAPTION_HEIGHT <= window.innerHeight) return { top: below, left: Math.max(8, left) }
  return { bottom: window.innerHeight - at.y + HELD_NOTE_OFFSET, left: Math.max(8, left) }
}

/**
 * Under what's pointed at, like a tooltip, so it never hides the controls beside it (often the
 * walkthrough's next step); over it when there's no room under. It keeps clear of the
 * outline's ring and inside the view.
 */
function captionPlace(rect: Rect | null) {
  if (!rect) return { top: 12, left: 12 }
  const { innerWidth: width, innerHeight: height } = window
  const x = Math.min(
    Math.max(CAPTION_EDGE, rect.x),
    Math.max(CAPTION_EDGE, width - CAPTION_WIDTH - CAPTION_EDGE),
  )
  const below = height - CAPTION_EDGE - (rect.y + rect.height + CAPTION_GAP)
  const above = rect.y - CAPTION_GAP - CAPTION_EDGE
  if (below >= CAPTION_HEIGHT || (below >= above && below > 0))
    return { top: rect.y + rect.height + CAPTION_GAP, left: x }
  if (above >= CAPTION_HEIGHT) return { bottom: height - rect.y + CAPTION_GAP, left: x }
  // Bigger than the view: inside its top edge.
  return { top: Math.max(CAPTION_EDGE, rect.y + CAPTION_GAP), left: x }
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
        kind === 'hover'
          ? 'border bg-accent-soft'
          : 'motion-safe:animate-fade-in motion-reduce:animate-row-fade border-2',
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
  const right = Math.max(2, window.innerWidth - rect.x - rect.width)
  const left = Math.max(2, rect.x)
  // Never past the view's far edge: a long name truncates instead.
  const horizontal = nearRight
    ? { right, maxWidth: window.innerWidth - right - 2 }
    : { left, maxWidth: window.innerWidth - left - 2 }
  return (
    <div
      data-label=""
      className="pointer-events-none absolute flex h-5 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-sm bg-accent px-1.5 text-caption text-accent-fg shadow-raised"
      style={{ top, ...horizontal }}
    >
      {children}
    </div>
  )
}

function Hint({ shown }: { shown: boolean }) {
  return (
    <div
      aria-hidden={!shown}
      className={cn(
        // As wide as its words, up to the overlay's width less the margins (a phone frame is
        // narrow): then whole phrases wrap to a second row, never a phrase across two.
        'pointer-events-none absolute top-2 right-2 left-2 flex w-fit flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-overlay px-2.5 py-1.5 text-small text-muted shadow-popover transition-opacity duration-(--motion-panel) *:whitespace-nowrap',
        shown
          ? 'opacity-100'
          : 'opacity-0 duration-(--motion-exit) ease-in motion-reduce:duration-(--motion-fade)',
      )}
    >
      {/* Gestures in words, keys as keycaps */}
      <span>
        <span className="font-medium text-fg">Click</span> an element
      </span>
      <span>
        <span className="font-medium text-fg">Drag</span> for a screenshot
      </span>
      <span>
        <span className="font-medium text-fg">Double-click</span> text to edit it
      </span>
      <span className="flex items-center gap-1">
        <Kbd>⇧</Kbd> to select more
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
