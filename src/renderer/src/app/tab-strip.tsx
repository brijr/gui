import { type PointerEvent, useLayoutEffect, useRef, useState } from 'react'
import { TAB_ROW_HEIGHT } from '../../../shared/layout'
import { Spring } from '../../../shared/motion'
import type { TabInfo, TabStatus, WindowState } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { Plus } from '../lib/icons'
import { animateFade, animateSpring, motionMs, prefersReducedMotion } from '../lib/motion'
import { StatusDot } from '../lib/status'
import {
  rovingTabKeyDown,
  SCROLLING_TABLIST,
  TAB_LABEL,
  TabCloseButton,
  tabClass,
  useScrollingTabs,
} from '../lib/tabs'
import { IconButton, PRESS, Spinner } from '../lib/ui'
import { sidebarRoom, useSidebarBar } from './layout-morph'

/** How far a pressed tab moves before it's dragged rather than clicked. */
const DRAG_THRESHOLD = 4
/** The pointer's velocity as a dragged tab is dropped is measured over this much of its path (ms). */
const VELOCITY_WINDOW = 100
/** A new tab grows in from this scale, out of its left edge. */
const NEW_TAB_SCALE = 0.96

/** How a tab's status reads after its name. */
const STATUS_LABEL: Record<TabStatus, string> = {
  idle: '',
  working: 'working',
  attention: 'waiting for your answer',
  error: 'something went wrong',
}

/** A tab being pressed, and dragged once it has moved far enough. */
interface Press {
  id: string
  pointerId: number
  /** Its slot when pressed, and the pointer's x then */
  from: number
  startX: number
  /** Slots are this far apart (tabs share the row equally) */
  step: number
  count: number
  dragging: boolean
  /** Where it was still sliding when grabbed (px from its slot): the drag starts from there */
  offset: number
  /** The pointer's recent path, for the velocity it's dropped with */
  path: { x: number; t: number }[]
}

/**
 * A tab being dragged: it follows the pointer (`dx` from its own slot) and the tabs between
 * its slot and `index`, where it would drop, move aside. The tabs stay in their order until
 * the drop, so the dragged one keeps the pointer.
 */
interface Drag {
  from: number
  index: number
  dx: number
  step: number
}

const tabName = (tab: TabInfo) => tab.title ?? 'New tab'

/** The drag with the pointer at `clientX`, kept between the first and last slots. */
function dragAt(press: Press, clientX: number): Drag {
  const { from, step, count, offset } = press
  const moved = offset + clientX - press.startX
  const dx = Math.min(Math.max(moved, -from * step), (count - 1 - from) * step)
  return { from, index: Math.round(from + dx / step), dx, step }
}

/** The pointer's velocity (px/s) along the strip as it let go at `t`; 0 if it had stopped. */
function releaseVelocity(path: { x: number; t: number }[], t: number) {
  const recent = path.filter((sample) => t - sample.t <= VELOCITY_WINDOW)
  const first = recent[0]
  const last = recent.at(-1)
  if (!first || !last || t - last.t > VELOCITY_WINDOW / 2 || last.t - first.t < 8) return 0
  return ((last.x - first.x) / (last.t - first.t)) * 1000
}

/** A tab sliding to its slot: its offset from the slot, on a spring. */
interface Slide {
  spring: Spring
  stop: () => void
}

/** How far the tab in slot `slot` is shifted while `drag` is under way. */
function shiftOf(drag: Drag | null, slot: number) {
  if (!drag) return 0
  const { from, index, dx, step } = drag
  if (slot === from) return dx
  if (from < slot && slot <= index) return -step
  if (index <= slot && slot < from) return step
  return 0
}

/** `ids` with `id` moved to `index`. */
function moved(ids: string[], id: string, index: number) {
  const rest = ids.filter((other) => other !== id)
  rest.splice(index, 0, id)
  return rest
}

/**
 * The window's tabs, in the title bar next to the traffic lights; only while there are two or
 * more, so a window with one project looks as it always has. Each tab is a project with its
 * own preview, chat and dev server. Drag to reorder, middle-click to close, right-click for
 * more. The row itself drags the window.
 *
 * The tablist holds tabs only. A tab's close button is for the pointer and hidden from
 * assistive tech; from the keyboard, Delete closes the focused tab, ⌘W the shown one, and
 * the context menu key opens the tab's menu.
 */
export function TabStrip({ state }: { state: WindowState }) {
  const nav = useRef<HTMLElement>(null)
  const list = useRef<HTMLDivElement>(null)
  // The traffic lights sit in this row, left of the tabs, unless the chat sidebar has them;
  // full screen hides them.
  useSidebarBar(nav, sidebarRoom(state, !state.fullScreen))
  // More tabs than fit: the row scrolls, and the shown one is always in it.
  useScrollingTabs(list, state.tabs.length > 1 ? state.activeTab : null)
  const press = useRef<Press | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  // The order a drop asked for, shown until main's state says otherwise.
  const [dropped, setDropped] = useState<{ ids: string[]; over: string } | null>(null)
  /** Each tab's slot (its layout position) as last laid out, to tell where it moved from. */
  const slots = useRef(new Map<string, number>())
  const slides = useRef(new Map<string, Slide>())
  /** Where every tab was drawn as a drag let go, and how fast the dropped one was moving. */
  const released = useRef<{ lefts: Map<string, number>; id: string; velocity: number } | null>(null)

  // After every layout: a tab whose slot moved (a tab closed, opened or was dropped) slides
  // from where it was drawn to its new slot on a spring, carrying on if it was already
  // sliding; a new tab grows in. Translate and scale only, so a drag's transform still applies.
  useLayoutEffect(() => {
    const els = [...(list.current?.querySelectorAll<HTMLElement>('[data-tab]') ?? [])]
    const initial = slots.current.size === 0
    const drop = released.current
    released.current = null
    const present = new Set<string>()
    for (const el of els) {
      const id = el.dataset.tab ?? ''
      present.add(id)
      const slot = el.offsetLeft
      const previous = slots.current.get(id)
      const drawn =
        drop?.lefts.get(id) ??
        (previous === undefined
          ? undefined
          : previous + (slides.current.get(id)?.spring.value ?? 0))
      slots.current.set(id, slot)
      if (drag) continue
      if (drawn === undefined) {
        if (!initial) growIn(el)
        continue
      }
      const isDropped = drop?.id === id
      if (Math.abs(drawn - slot) >= 0.5 || slides.current.has(id)) {
        slide(el, id, drawn - slot, isDropped ? drop.velocity : 0, isDropped)
      }
    }
    for (const id of [...slots.current.keys()]) {
      if (present.has(id)) continue
      slots.current.delete(id)
      slides.current.get(id)?.stop()
      slides.current.delete(id)
    }
  })

  /**
   * Slides a tab from `offset` px off its slot back to it, at `velocity` px/s to start; the
   * one just dropped (`front`) stays above the ones it passes, as it was while dragged.
   */
  const slide = (el: HTMLElement, id: string, offset: number, velocity: number, front: boolean) => {
    const running = slides.current.get(id)
    if (prefersReducedMotion()) {
      running?.stop()
      slides.current.delete(id)
      el.style.translate = ''
      return
    }
    const draw = (value: number) => {
      el.style.translate = `${value}px 0`
    }
    if (running) {
      // Re-based on the new slot; it keeps its speed.
      running.spring.value = offset
      draw(offset)
      return
    }
    const spring = new Spring(offset, { target: 0, velocity })
    draw(offset)
    if (front) el.style.zIndex = '10'
    const stop = animateSpring(spring, {
      update: draw,
      rest: () => {
        el.style.translate = ''
        el.style.zIndex = ''
        slides.current.delete(id)
      },
    })
    // Landed already (a hidden page): nothing to keep.
    if (stop) slides.current.set(id, { spring, stop })
  }

  const { tabs, activeTab } = state
  if (tabs.length < 2) return null

  const ids = tabs.map((tab) => tab.id)
  const shown =
    dropped?.over === ids.join() && dropped.ids.length === ids.length ? dropped.ids : ids
  const ordered = shown.flatMap((id) => tabs.find((tab) => tab.id === id) ?? [])

  const select = (id: string) => {
    if (id !== activeTab) gui.selectTab(id)
  }

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0) return
    // Like a browser, a tab is chosen as it's pressed.
    select(id)
    // Their slots, not where they're drawn: some may still be sliding.
    const [first, second] = list.current?.querySelectorAll<HTMLElement>('[data-tab]') ?? []
    if (!first) return
    event.currentTarget.setPointerCapture(event.pointerId)
    press.current = {
      id,
      pointerId: event.pointerId,
      from: ordered.findIndex((tab) => tab.id === id),
      startX: event.clientX,
      step: Math.max(1, second ? second.offsetLeft - first.offsetLeft : first.offsetWidth),
      count: ordered.length,
      dragging: false,
      offset: 0,
      path: [{ x: event.clientX, t: event.timeStamp }],
    }
  }

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = press.current
    if (!current || current.pointerId !== event.pointerId) return
    current.path = [...current.path, { x: event.clientX, t: event.timeStamp }].filter(
      (sample) => event.timeStamp - sample.t <= VELOCITY_WINDOW * 2,
    )
    if (!current.dragging && Math.abs(event.clientX - current.startX) < DRAG_THRESHOLD) return
    if (!current.dragging) {
      // Caught mid-slide: the drag carries on from where the tab is drawn.
      const sliding = slides.current.get(current.id)
      current.offset = sliding?.spring.value ?? 0
      sliding?.stop()
      slides.current.delete(current.id)
      const el = list.current?.querySelector<HTMLElement>(`[data-tab="${current.id}"]`)
      if (el) el.style.translate = ''
    }
    current.dragging = true
    setDrag(dragAt(current, event.clientX))
  }

  /** Drops a dragged tab where it is; a cancelled press (`drop` false) leaves the order. */
  const onPointerEnd = (event: PointerEvent<HTMLButtonElement>, drop: boolean) => {
    const current = press.current
    if (!current || current.pointerId !== event.pointerId) return
    press.current = null
    setDrag(null)
    if (!current.dragging || !drop) return
    // Where each tab is drawn now: the dropped one springs from there into its slot.
    const lefts = new Map<string, number>()
    for (const el of list.current?.querySelectorAll<HTMLElement>('[data-tab]') ?? []) {
      lefts.set(el.dataset.tab ?? '', drawnLeft(el))
    }
    const velocity = releaseVelocity(current.path, event.timeStamp)
    released.current = { lefts, id: current.id, velocity }
    const { index } = dragAt(current, event.clientX)
    if (index === current.from) return
    const order = ordered.map((tab) => tab.id)
    setDropped({ ids: moved(order, current.id, index), over: ids.join() })
    gui.moveTab(current.id, index)
  }

  return (
    <nav
      ref={nav}
      aria-label="Tabs"
      className="drag flex shrink-0 items-center gap-1 border-b border-line bg-surface"
      style={{ height: TAB_ROW_HEIGHT }}
    >
      <div
        ref={list}
        role="tablist"
        // Each tab is a project or a canvas.
        aria-label="Projects and canvases"
        className={cn(SCROLLING_TABLIST, 'shrink')}
      >
        {ordered.map((tab, index) => {
          const active = tab.id === activeTab
          const dragged = drag?.from === index
          // A hairline between two tabs at rest, so a row of them reads as tabs, not loose
          // names; the active tab's own border does that on either side of it.
          const divided = index > 0 && !active && ordered[index - 1]?.id !== activeTab && !drag
          const shift = shiftOf(drag, index)
          const name = tabName(tab)
          return (
            <div
              key={tab.id}
              role="presentation"
              data-tab={tab.id}
              style={shift ? { transform: `translateX(${shift}px)` } : undefined}
              className={cn(
                // Like a browser's tabs, the shown one is a raised page with an edge (the
                // document look). Its transitions leave opacity out: a new tab's grow-in
                // draws it from script.
                tabClass('document', active),
                'no-drag w-56 min-w-20',
                // The others slide aside; the dragged one follows the pointer as is.
                drag && !dragged
                  ? 'transition-[color,background-color,transform] motion-reduce:transition-[color,background-color]'
                  : 'transition-[color,background-color]',
                // Lifted off the row while it's carried, above the tabs it passes.
                dragged && 'z-popover shadow-popover',
                // The hairline sits in the 4px gap before the tab, just outside its border.
                divided &&
                  "before:absolute before:-left-0.75 before:h-3.5 before:w-px before:bg-line before:content-['']",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                // The status follows the name, for screen readers ("foo, working").
                aria-label={
                  tab.status === 'idle' ? undefined : `${name}, ${STATUS_LABEL[tab.status]}`
                }
                title={name}
                onPointerDown={(event) => onPointerDown(event, tab.id)}
                onPointerMove={onPointerMove}
                onPointerUp={(event) => onPointerEnd(event, true)}
                onPointerCancel={(event) => onPointerEnd(event, false)}
                onLostPointerCapture={(event) => onPointerEnd(event, false)}
                // A pointer chooses the tab as it's pressed; this is Enter or Space.
                onClick={(event) => {
                  if (event.detail === 0) select(tab.id)
                }}
                // The middle button closes, rather than starting to scroll.
                onMouseDown={(event) => {
                  if (event.button === 1) event.preventDefault()
                }}
                onAuxClick={(event) => {
                  if (event.button === 1) gui.closeTab(tab.id)
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  gui.showTabMenu(tab.id)
                }}
                onKeyDown={(event) =>
                  rovingTabKeyDown(event, {
                    index,
                    count: ordered.length,
                    select: (target) => {
                      const next = ordered[target]
                      if (next) select(next.id)
                    },
                    // Main shows the next tab (or the previous one), which has the keyboard.
                    close: () => gui.closeTab(tab.id),
                  })
                }
                className={cn(
                  TAB_LABEL,
                  'flex-1 pr-7 pl-2.5',
                  // Carried, it stays solid rather than dimmed as pressed.
                  !dragged && PRESS,
                )}
              >
                {tab.status !== 'idle' && <StatusMark status={tab.status} />}
                <span className="truncate">{name}</span>
              </button>
              {/* The pointer's way to close; the keyboard's is Delete on the tab, or ⌘W. On a
                  tab that isn't shown it fades in with the pointer, and while the tab has focus. */}
              <TabCloseButton
                name={name}
                onClose={() => gui.closeTab(tab.id)}
                reveal={active ? 'always' : 'hover'}
              />
            </div>
          )
        })}
      </div>
      <IconButton label="New tab" shortcut="newTab" icon={Plus} onClick={() => gui.newTab()} />
    </nav>
  )
}

/**
 * Where a tab is drawn, in its slot's (`offsetLeft`'s) terms: its slot plus any transform. Its
 * offset parent is the tablist, which may be scrolled.
 */
function drawnLeft(el: HTMLElement) {
  const parent = el.offsetParent
  const origin = parent ? parent.getBoundingClientRect().left + parent.clientLeft : 0
  return el.getBoundingClientRect().left - origin + (parent?.scrollLeft ?? 0)
}

/** A tab that just opened grows in from its left edge; with reduced motion it fades in. */
function growIn(el: HTMLElement) {
  el.style.transformOrigin = 'left center'
  const draw = (presence: number) => {
    el.style.opacity = String(presence)
    el.style.scale = prefersReducedMotion()
      ? ''
      : String(NEW_TAB_SCALE + (1 - NEW_TAB_SCALE) * presence)
  }
  const done = () => {
    el.style.opacity = ''
    el.style.scale = ''
  }
  draw(0)
  if (prefersReducedMotion())
    animateFade(0, 1, motionMs('--motion-fade'), { update: draw, rest: done })
  else animateSpring(new Spring(0, { target: 1 }), { precision: 0.002, update: draw, rest: done })
}

/**
 * The agent working, a permission card waiting for an answer (an accent dot, the size of a
 * StatusDot), or something that failed, in one 12px slot so names line up whichever it is.
 * An idle tab has none, so its name starts at the tab's inset rather than after an empty
 * slot. The tab's name says which to assistive tech.
 */
function StatusMark({ status }: { status: TabStatus }) {
  return (
    <span aria-hidden="true" className="flex size-3 shrink-0 items-center justify-center">
      {status === 'working' && <Spinner className="text-muted" />}
      {status === 'error' && <StatusDot status="error" />}
      {status === 'attention' && <span className="size-1.5 rounded-full bg-accent" />}
    </span>
  )
}
