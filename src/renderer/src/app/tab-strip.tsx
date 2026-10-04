import { Plus, X } from 'lucide-react'
import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react'
import { TAB_ROW_HEIGHT, TRAFFIC_LIGHTS_INSET } from '../../../shared/layout'
import type { TabInfo, TabStatus, WindowState } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { StatusDot } from '../lib/status'
import { IconButton, Spinner } from '../lib/ui'

/** How far a pressed tab moves before it's dragged rather than clicked. */
const DRAG_THRESHOLD = 4

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
  const { from, step, count } = press
  const dx = Math.min(Math.max(clientX - press.startX, -from * step), (count - 1 - from) * step)
  return { from, index: Math.round(from + dx / step), dx, step }
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
  const list = useRef<HTMLDivElement>(null)
  const press = useRef<Press | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  // The order a drop asked for, shown until main's state says otherwise.
  const [dropped, setDropped] = useState<{ ids: string[]; over: string } | null>(null)

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
    const slots = [...(list.current?.querySelectorAll('[data-tab]') ?? [])].map((slot) =>
      slot.getBoundingClientRect(),
    )
    const [first, second] = slots
    if (!first) return
    event.currentTarget.setPointerCapture(event.pointerId)
    press.current = {
      id,
      pointerId: event.pointerId,
      from: ordered.findIndex((tab) => tab.id === id),
      startX: event.clientX,
      step: Math.max(1, second ? second.left - first.left : first.width),
      count: ordered.length,
      dragging: false,
    }
  }

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = press.current
    if (!current || current.pointerId !== event.pointerId) return
    if (!current.dragging && Math.abs(event.clientX - current.startX) < DRAG_THRESHOLD) return
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
    const { index } = dragAt(current, event.clientX)
    if (index === current.from) return
    const order = ordered.map((tab) => tab.id)
    setDropped({ ids: moved(order, current.id, index), over: ids.join() })
    gui.moveTab(current.id, index)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = ordered.length
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const tab = ordered[index]
      if (!tab) return
      event.preventDefault()
      // Main shows the next tab (or the previous one); keep the keyboard on it.
      const neighbor = ordered[index + 1] ?? ordered[index - 1]
      if (neighbor) focusTab(neighbor.id)
      gui.closeTab(tab.id)
      return
    }
    const targets: Record<string, number> = {
      ArrowRight: (index + 1) % count,
      ArrowLeft: (index - 1 + count) % count,
      Home: 0,
      End: count - 1,
    }
    const target = targets[event.key]
    const next = target === undefined ? undefined : ordered[target]
    if (!next) return
    event.preventDefault()
    select(next.id)
    focusTab(next.id)
  }

  const focusTab = (id: string) =>
    list.current?.querySelector<HTMLElement>(`[data-tab="${id}"] [role="tab"]`)?.focus()

  return (
    <nav
      aria-label="Tabs"
      className="drag flex shrink-0 items-center gap-1 border-b border-line bg-surface pr-2"
      // The traffic lights sit in this row, left of the tabs.
      style={{ height: TAB_ROW_HEIGHT, paddingLeft: TRAFFIC_LIGHTS_INSET }}
    >
      <div
        ref={list}
        role="tablist"
        aria-label="Open projects"
        className="flex min-w-0 shrink items-center gap-1 overflow-hidden"
      >
        {ordered.map((tab, index) => {
          const active = tab.id === activeTab
          const dragged = drag?.from === index
          const shift = shiftOf(drag, index)
          const name = tabName(tab)
          return (
            <div
              key={tab.id}
              role="presentation"
              data-tab={tab.id}
              style={shift ? { transform: `translateX(${shift}px)` } : undefined}
              className={cn(
                'no-drag group relative flex h-7 w-56 min-w-20 shrink items-center rounded-md border',
                active
                  ? 'border-line bg-raised text-fg shadow-raised'
                  : 'border-transparent text-muted hover:bg-hover hover:text-fg',
                // The others slide aside; the dragged one follows the pointer as is.
                drag && !dragged && 'transition-transform',
                dragged && 'z-10 shadow-popover',
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
                onKeyDown={(event) => onKeyDown(event, index)}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md pr-7 pl-2.5 text-left text-small font-medium"
              >
                <StatusMark status={tab.status} />
                <span className="truncate">{name}</span>
              </button>
              {/* The pointer's way to close; the keyboard's is Delete on the tab, or ⌘W. */}
              <IconButton
                label={`Close ${name}`}
                icon={X}
                size="sm"
                aria-hidden="true"
                tabIndex={-1}
                // Keeps focus where it was rather than on a button hidden from assistive tech.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => gui.closeTab(tab.id)}
                className={cn(
                  'absolute right-0.5',
                  active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                )}
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
 * The agent working, a permission card waiting for an answer (an accent dot, the size of a
 * StatusDot), or something that failed, in one 12px slot so names line up whichever it is.
 * The tab's name says which to assistive tech.
 */
function StatusMark({ status }: { status: TabStatus }) {
  if (status === 'idle') return null
  return (
    <span aria-hidden="true" className="flex size-3 shrink-0 items-center justify-center">
      {status === 'working' && <Spinner className="text-muted" />}
      {status === 'error' && <StatusDot status="error" />}
      {status === 'attention' && <span className="size-1.5 rounded-full bg-accent" />}
    </span>
  )
}
