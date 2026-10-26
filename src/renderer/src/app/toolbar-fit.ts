import { type RefObject, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

/*
 * How a toolbar fits its window. One part of it stretches (the address field, or the room
 * before the canvas's zoom), marked `data-fit-flex`; everything else keeps its size. When the
 * stretching part would get narrower than its minimum, the toolbar makes room in a fixed
 * order of steps: a tool first drops its keys (`compact`), and later goes into the toolbar's
 * "…" menu (`hidden`). With room again, the steps come undone, last first.
 *
 * Any button can join: give it a step, render it by `fit(id)`, and say what it is in the "…"
 * menu while it's hidden. Buttons with no step (the project menu, Record, the chat) are
 * measured as they are and never give way.
 */

/** One way a toolbar makes room. */
export interface FitStep {
  /** The tool's id, as `fit` is asked for it */
  tool: string
  to: 'compact' | 'hidden'
}

export type ToolFit = 'full' | 'compact' | 'hidden'

interface FitOptions {
  /** The room the stretching part keeps before any tool gives way, in px */
  min: number
  /** The bar's padding where it comes to rest: the sidebar beside it may be sliding */
  padding: { left: number; right: number }
  /**
   * While the chat sidebar slides, tools only give way: they come back once it's at rest, so
   * nothing pops in mid-slide.
   */
  sliding: boolean
  /** Another set of steps (a canvas's board, or a frame opened on it) starts over */
  key?: string
}

/** Room given up, or taken back, by less than this doesn't undo a step: no flicker at the edge. */
const HYSTERESIS = 4

/** The width of everything in `bar` but its stretching part, with the gaps between them. */
function naturalWidth(bar: HTMLElement) {
  const children = [...bar.children] as HTMLElement[]
  const first = children[0]
  const last = children.at(-1)
  if (!first || !last) return 0
  const flex = children.find((child) => child.dataset.fitFlex !== undefined)
  return (
    last.getBoundingClientRect().right -
    first.getBoundingClientRect().left -
    (flex?.getBoundingClientRect().width ?? 0)
  )
}

/**
 * Fits the toolbar `ref` by taking `steps` in order, as many as it needs. Returns how each
 * tool shows now, and whether any is in the "…" menu.
 */
export function useToolbarFit(
  ref: RefObject<HTMLElement | null>,
  steps: readonly FitStep[],
  { min, padding, sliding, key = '' }: FitOptions,
) {
  const [taken, setTaken] = useState({ key, count: 0 })
  const count = taken.key === key ? taken.count : 0
  /** What each step gave back when it was taken, in px */
  const gains = useRef<{ key: string; widths: number[] }>({ key, widths: [] })
  if (gains.current.key !== key) gains.current = { key, widths: [] }
  /** The natural width before the step being taken, measured once it's on screen */
  const pending = useRef<{ step: number; natural: number } | null>(null)
  const [, remeasure] = useReducer((n: number) => n + 1, 0)

  // After every render, before it's painted: one step further, or one back, if it's due.
  useLayoutEffect(() => {
    const bar = ref.current
    if (!bar) return
    const natural = naturalWidth(bar)
    const last = pending.current
    pending.current = null
    if (last && last.step === count - 1) gains.current.widths[last.step] = last.natural - natural
    const room = bar.clientWidth - padding.left - padding.right - natural
    if (room < min && count < steps.length) {
      pending.current = { step: count, natural }
      setTaken({ key, count: count + 1 })
      return
    }
    const gain = gains.current.widths[count - 1]
    if (!sliding && count > 0 && gain !== undefined && room - gain >= min + HYSTERESIS) {
      setTaken({ key, count: count - 1 })
    }
  })

  // The window resizing, or a tool that keeps its place changing size (Record while it
  // records), fits it again at once. Not the stretching part: it changes with every frame of
  // the sidebar's slide, and fitting goes by where the sidebar is going.
  const observed = useRef<{ observer: ResizeObserver; elements: Set<Element> } | null>(null)
  useLayoutEffect(() => {
    const bar = ref.current
    if (!bar) return
    observed.current ??= {
      observer: new ResizeObserver(() => flushSync(remeasure)),
      elements: new Set(),
    }
    const { observer, elements } = observed.current
    const wanted = new Set<Element>([bar])
    for (const child of bar.children) {
      if (!(child instanceof HTMLElement) || child.dataset.fitFlex === undefined) wanted.add(child)
    }
    for (const element of elements) {
      if (wanted.has(element)) continue
      observer.unobserve(element)
      elements.delete(element)
    }
    for (const element of wanted) {
      if (elements.has(element)) continue
      observer.observe(element, { box: 'border-box' })
      elements.add(element)
    }
  })
  useLayoutEffect(
    () => () => {
      observed.current?.observer.disconnect()
      observed.current = null
    },
    [],
  )

  const fit = (tool: string): ToolFit => {
    let state: ToolFit = 'full'
    for (const step of steps.slice(0, count)) if (step.tool === tool) state = step.to
    return state
  }
  const overflowing = steps.slice(0, count).some((step) => step.to === 'hidden')
  return { fit, overflowing }
}
