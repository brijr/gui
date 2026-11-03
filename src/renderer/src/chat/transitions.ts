import { flushSync } from 'react-dom'
import type { Turn } from '../../../shared/types'
import { prefersReducedMotion } from '../lib/motion'

/*
 * Moves between chat states with the View Transitions API: a sent message rising from the
 * composer into the transcript, a queued message moving into the transcript when its turn
 * starts, a permission card collapsing into the line that records the answer, queued messages
 * coming and going. Only the elements that move are named, and only while they're fully in
 * sight: a transition draws its snapshots above everything, unclipped by their scroller.
 *
 * Also the registry of transcript rows already shown, so a row fades up once, when it first
 * appears live, and not when history loads or the panel comes back.
 */

/** An element before the update and its counterpart after; either may be missing. */
export interface Move {
  name: string
  from: () => Element | null
  to: () => Element | null
  /** New with this update (a queued message arriving), so it fades in with no `from` */
  enters?: boolean
  /**
   * Changes shape on the way (the message box into a bubble, a permission card into its line):
   * its pictures keep their size, clipped by the box that moves, rather than being stretched
   * to fit it (styles.css, `.reflow`).
   */
  reflow?: boolean
}

/** Names `el` for a move, or clears it (`null`). */
function name(el: Element, move: Move | null) {
  const style = (el as HTMLElement).style
  style.viewTransitionName = move?.name ?? ''
  if (move?.reflow) style.setProperty('view-transition-class', 'reflow')
  else style.removeProperty('view-transition-class')
}

/** Rows (`rowKeys`) that have been on screen, or arrived while the transcript wasn't. */
const seen = new Set<string>()

/** False once a row has been shown: it fades up only the first time. */
export function isNewRow(key: string) {
  return !seen.has(key)
}

export function markSeen(keys: Iterable<string>) {
  for (const key of keys) seen.add(key)
}

/** A new chat: the old one's rows are gone for good. */
export function forgetSeen() {
  seen.clear()
}

/** Every row a turn has now: its message, each block of items, and its ending. */
export function rowKeys(turn: Turn) {
  return [`${turn.id}:user`, `${turn.id}:end`, ...turn.items.map((item) => item.id)]
}

let current: ViewTransition | null = null
/**
 * A transition's update normally applies at its next frame; if it hasn't in this long, the
 * transition is skipped so the updates waiting on it apply.
 */
const UPDATE_DEADLINE_MS = 500
/** Updates that came in while a transition waited to apply its own; applied right after it. */
let deferred: (() => void)[] | null = null

/** Runs `update` now, or after the transition about to apply its own, so none land out of order. */
export function applyInOrder(update: () => void) {
  if (deferred) deferred.push(update)
  else update()
}

/** Fully inside the window and the scroller it's in (`data-clip`, the transcript). */
function inSight(el: Element) {
  const box = el.getBoundingClientRect()
  if (box.width === 0 || box.height === 0) return false
  const clip = el.closest('[data-clip]')?.getBoundingClientRect()
  const area = clip ?? { top: 0, left: 0, bottom: innerHeight, right: innerWidth }
  return (
    box.top >= area.top - 1 &&
    box.left >= area.left - 1 &&
    box.bottom <= area.bottom + 1 &&
    box.right <= area.right + 1
  )
}

/**
 * Applies `update` (store changes) inside a view transition that carries each move's element
 * to its counterpart, or straight away when there's nothing in sight to move, a transition is
 * already running, the page can't show one, or the user asks for reduced motion (new rows
 * still fade in). `rows` are rows the transition shows arriving, which mustn't fade too.
 */
export function transition(update: () => void, moves: Move[], rows: string[] = []) {
  const supported = typeof document.startViewTransition === 'function'
  // Only while the panel's transcript and composer are drawn (not the pill, the bubble or the
  // pull-request sheet): elsewhere there's nothing to move, and a transition would only hold
  // back the next updates.
  const able =
    supported &&
    !current &&
    !deferred &&
    !prefersReducedMotion() &&
    document.visibilityState === 'visible' &&
    document.querySelector('[data-composer]') !== null
  const named = able
    ? moves.flatMap((move) => {
        const el = move.from()
        return el && inSight(el) ? [{ el, move }] : []
      })
    : []
  const entering = able && moves.some((move) => move.enters)
  if (named.length === 0 && !entering) {
    applyInOrder(update)
    return
  }
  for (const { el, move } of named) name(el, move)
  markSeen(rows)
  deferred = []
  const after: HTMLElement[] = []
  try {
    current = document.startViewTransition(() => {
      for (const { el } of named) name(el, null)
      const queued = deferred ?? []
      deferred = null
      flushSync(() => {
        update()
        for (const run of queued) run()
      })
      for (const move of moves) {
        const el = move.to()
        if (!(el instanceof HTMLElement) || !inSight(el)) continue
        name(el, move)
        after.push(el)
      }
    })
  } catch {
    for (const { el } of named) name(el, null)
    const queued = deferred ?? []
    deferred = null
    update()
    for (const run of queued) run()
    return
  }
  const transition = current
  const settled = () => {
    for (const el of after) name(el, null)
    if (current === transition) current = null
  }
  transition.finished.then(settled, settled)
  setTimeout(() => {
    if (deferred && current === transition) transition.skipTransition()
  }, UPDATE_DEADLINE_MS)
}
