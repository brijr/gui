import { type KeyboardEvent, type RefObject, useEffect, useLayoutEffect, useRef } from 'react'
import { cn } from './cn'
import { X } from './icons'
import { prefersReducedMotion } from './motion'
import { IconButton } from './ui'

/*
 * Tabs: a tablist of buttons, each in a presentational wrapper that also holds its close
 * button. Two looks, one per kind of tablist:
 *
 * - document: the window's tab strip, where each tab is a whole project. The shown tab is a
 *   raised page with an edge, like a browser's, rather than the accent-soft of every other
 *   selection; it's the one exception to that rule, so use it nowhere else.
 * - segment: tabs that switch what a panel shows (the drawer's dev server and terminals).
 *   Selected is accent-soft with accent text, as any other selection.
 *
 * Either way the rest are muted and fill as the pointer passes. Only the selected tab is in
 * the tab order (roving focus); the arrow keys, Home and End move the keyboard and the
 * selection together (rovingTabKeyDown). A tab's close button is for the pointer and hidden
 * from assistive tech; from the keyboard, Delete on a tab closes it. Not Backspace: pressed
 * by habit, as if in a field, it would end a whole project.
 *
 * Transitions are the caller's, as the tab strip's change while a tab is dragged: give a tab
 * `transition-[color,background-color]` at least, and its label TAB_LABEL's opacity one.
 */

export type TabLook = 'document' | 'segment'

/** A tab's wrapper, 28px: `group` so its close button can show with the pointer or focus. */
export const TAB = 'group relative flex h-7 min-w-0 shrink items-center rounded-md'

const LOOK: Record<TabLook, { selected: string; rest: string }> = {
  document: {
    selected: 'border border-line bg-raised text-fg shadow-raised',
    rest: 'border border-transparent text-muted hover:bg-hover hover:text-fg',
  },
  segment: {
    selected: 'bg-accent-soft text-accent-text',
    rest: 'text-muted hover:bg-hover hover:text-fg',
  },
}

/** A tab's wrapper in `look`, selected or not. */
export function tabClass(look: TabLook, selected: boolean) {
  return cn(TAB, selected ? LOOK[look].selected : LOOK[look].rest)
}

/**
 * The tab itself (the button with role="tab"): its mark and name, filling the wrapper. Add the
 * inset (pr-7 where a close button sits over the end) and PRESS.
 */
export const TAB_LABEL =
  'flex h-full min-w-0 items-center gap-1.5 rounded-md text-left text-small font-medium transition-opacity'

/**
 * A tablist whose tabs can outgrow it: it scrolls sideways (the trackpad, or the mouse wheel
 * with useScrollingTabs) with no scrollbar, and fades at an edge with more tabs past it. Tabs
 * are laid out from it (`relative`), so scrolling doesn't move their slots.
 */
export const SCROLLING_TABLIST =
  'relative flex min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain scrollbar-none scroll-fade-x'

/** How far inside the list's edge a revealed tab lands, clear of the fade. */
const REVEAL_INSET = 24

/**
 * For a SCROLLING_TABLIST: keeps the selected tab in view (`selected` names it, so a change
 * scrolls to it), and turns the mouse wheel's up and down into the list's sideways scroll.
 */
export function useScrollingTabs(ref: RefObject<HTMLElement | null>, selected: string | null) {
  const placed = useRef(false)
  useLayoutEffect(() => {
    if (selected === null) return
    // Keep keyboard selection immediate; pointer selection may reveal an offscreen tab.
    revealSelected(
      ref.current,
      !placed.current || prefersReducedMotion() || !!ref.current?.matches(':focus-within'),
    )
    placed.current = true
  }, [ref, selected])

  const shown = selected !== null
  useEffect(() => {
    const list = ref.current
    if (!list || !shown) return
    const onWheel = (event: WheelEvent) => {
      // A trackpad scrolls sideways itself; a wheel only goes up and down.
      if (event.deltaX !== 0 || list.scrollWidth <= list.clientWidth) return
      event.preventDefault()
      list.scrollLeft += event.deltaY
    }
    // The window narrowing keeps the selected tab in the row.
    const resized = new ResizeObserver(() => revealSelected(list, true))
    list.addEventListener('wheel', onWheel, { passive: false })
    resized.observe(list)
    return () => {
      list.removeEventListener('wheel', onWheel)
      resized.disconnect()
    }
  }, [ref, shown])
}

/** Scrolls `list` as little as it takes to show its selected tab, clear of the faded edges. */
function revealSelected(list: HTMLElement | null, instant: boolean) {
  const tab = list
    ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
    ?.closest<HTMLElement>('[role="presentation"]')
  if (!list || !tab) return
  const left = tab.offsetLeft - REVEAL_INSET
  const right = tab.offsetLeft + tab.offsetWidth + REVEAL_INSET - list.clientWidth
  // As far as the tabs' own slots reach. A tab sliding into place is drawn past its slot, which
  // the list could scroll to; following it there would jolt the whole row as it lands.
  const end = Math.max(
    0,
    ...[...list.children].map((child) =>
      child instanceof HTMLElement ? child.offsetLeft + child.offsetWidth : 0,
    ),
  )
  const most = Math.max(0, end - list.clientWidth)
  const to = Math.min(most, Math.max(right, Math.min(left, list.scrollLeft)))
  if (Math.abs(to - list.scrollLeft) < 1) return
  list.scrollTo({ left: to, behavior: instant ? 'instant' : 'smooth' })
}

interface TabKeys {
  /** The focused tab's place in the tablist */
  index: number
  /** How many tabs there are */
  count: number
  /** Shows the tab at `index`; the keyboard follows it there */
  select: (index: number) => void
  /** Closes the focused tab; leave it out for one that can't be closed */
  close?: () => void
}

/**
 * The keys on a tab, per the WAI-ARIA tabs pattern with selection following focus: ← and →
 * move to the previous and next tab (wrapping), Home and End to the first and last. Delete
 * closes the tab, with the keyboard moving to the next one (or the previous),
 * the one that's shown after. Tabs are found in the tablist the key was pressed in.
 */
export function rovingTabKeyDown(
  event: KeyboardEvent<HTMLElement>,
  { index, count, select, close }: TabKeys,
) {
  const tabs = event.currentTarget
    .closest('[role="tablist"]')
    ?.querySelectorAll<HTMLElement>('[role="tab"]')
  if (event.key === 'Delete') {
    if (!close) return
    event.preventDefault()
    // Moved before it closes, while the neighbor is still where it was.
    ;(tabs?.[index + 1] ?? tabs?.[index - 1])?.focus()
    close()
    return
  }
  const targets: Record<string, number> = {
    ArrowRight: (index + 1) % count,
    ArrowLeft: (index - 1 + count) % count,
    Home: 0,
    End: count - 1,
  }
  const target = targets[event.key]
  if (target === undefined || count === 0) return
  event.preventDefault()
  select(target)
  tabs?.[target]?.focus()
}

interface TabCloseButtonProps {
  /** What it closes, read as "Close {name}" in its tooltip */
  name: string
  onClose: () => void
  /**
   * always (default): shown whenever the tab is. hover: faded out until the pointer is over
   * the tab or it has focus, for a row of fixed-width tabs where most aren't shown (the tab
   * strip's). Tabs as wide as their names keep it, or a hidden one would leave a gap.
   */
  reveal?: 'always' | 'hover'
}

/**
 * A tab's ×, over the end of its label (which keeps pr-7 for it). Hidden from assistive tech
 * and out of the tab order: the keyboard closes a tab with Delete instead.
 */
export function TabCloseButton({ name, onClose, reveal = 'always' }: TabCloseButtonProps) {
  return (
    <IconButton
      label={`Close ${name}`}
      icon={X}
      size="sm"
      aria-hidden="true"
      tabIndex={-1}
      // Keeps focus where it was rather than on a button hidden from assistive tech.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClose}
      className={cn(
        'absolute right-0.5 duration-(--motion-fade)',
        reveal === 'hover' && 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100',
      )}
    />
  )
}
