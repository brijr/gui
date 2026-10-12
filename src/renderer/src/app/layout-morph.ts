import { type RefObject, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { FRAME_LABEL_HEIGHT } from '../../../shared/layout'
import { Spring } from '../../../shared/motion'
import { frameLabel, type MorphEvent, type Viewport } from '../../../shared/types'
import { gui } from '../lib/api'
import { animateFade, animateSpring, prefersReducedMotion } from '../lib/motion'

/*
 * The chrome's side of the preview's layout morphs (main/preview-morph.ts): main resizes the
 * live view into its new layout on a spring, like a window being resized, and tells the chrome
 * where it is on every frame. The chrome draws the device frame's edge and label around it
 * there, over the canvas and under the toolbar and the drawer, which slide with the same
 * spring from the same moment (`useLayoutSlide`), so their edges move as one.
 */

/** Reduce motion: how long the toolbar and the drawer fade in and out (--motion-fade). */
const REDUCED_FADE_MS = 150

// What moves with the morph: the canvas leaves its own device frame out while the morph draws
// it, and the drawer and the toolbar wait for it to start moving.

interface Status {
  id: number
  moving: boolean
  /** The morph draws the device frame */
  drawsFrame: boolean
}

let status: Status | null = null
const listeners = new Set<() => void>()
const waiting = new Set<() => void>()

function setStatus(next: Status | null) {
  status = next
  for (const listener of [...listeners]) listener()
  if (next && !next.moving) return
  const starts = [...waiting]
  waiting.clear()
  for (const start of starts) start()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Runs `start` once the preview's morph starts moving (or ends without moving), or now when
 * none is coming. Returns a function that drops it.
 */
export function whenMorphMoves(start: () => void): () => void {
  if (!status || status.moving) {
    start()
    return () => undefined
  }
  waiting.add(start)
  return () => {
    waiting.delete(start)
  }
}

/** True while a morph draws the device frame, which the canvas then leaves out. */
export function useMorphDrawsFrame() {
  return useSyncExternalStore(subscribe, () => status?.drawsFrame ?? false)
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** The device frame's edge and label around the live view, for one morph. */
class MorphFrame {
  private readonly el = document.createElement('div')
  private readonly edge = document.createElement('div')
  private readonly label = document.createElement('p')
  private labelled: { viewport: Viewport; text: string } | null = null

  constructor(
    readonly id: number,
    root: HTMLElement,
  ) {
    this.el.className = 'pointer-events-none absolute inset-0'
    this.el.dataset.morph = String(id)
    this.edge.dataset.morphFrame = ''
    this.edge.className = 'absolute top-0 left-0 border border-line-strong shadow-popover'
    this.label.className =
      'absolute top-0 left-0 flex items-center text-caption whitespace-nowrap text-subtle tabular-nums'
    this.label.style.height = `${FRAME_LABEL_HEIGHT}px`
    this.el.append(this.edge, this.label)
    root.append(this.el)
  }

  draw({ rect, scale, viewport, opacity }: Extract<MorphEvent, { type: 'frame' }>) {
    const { x, y, width, height } = rect
    const shown = viewport ? String(clamp01(opacity)) : '0'
    this.edge.style.opacity = shown
    this.edge.style.transform = `translate(${x - 1}px, ${y - 1}px)`
    this.edge.style.width = `${width + 2}px`
    this.edge.style.height = `${height + 2}px`
    this.label.style.opacity = shown
    this.label.style.transform = `translate(${x}px, ${y - FRAME_LABEL_HEIGHT}px)`
    if (viewport) this.setLabel(viewport, scale)
  }

  dispose() {
    this.el.remove()
  }

  /** The label above a device frame, as canvas.tsx draws it. */
  private setLabel(viewport: Viewport, scale: number) {
    const { name, detail } = frameLabel(viewport, scale)
    const text = name + detail
    if (this.labelled?.viewport === viewport && this.labelled.text === text) return
    this.labelled = { viewport, text }
    const strong = document.createElement('span')
    strong.className = 'font-medium text-muted'
    strong.textContent = name
    const line = document.createElement('span')
    line.append(strong, detail)
    this.label.replaceChildren(line)
  }
}

/** The morphs the chrome draws, one at a time, from main's `MorphEvent`s. */
class MorphLayer {
  private frame: MorphFrame | null = null

  constructor(private readonly root: HTMLElement) {}

  handle(event: MorphEvent) {
    switch (event.type) {
      case 'pending':
        // The canvas keeps drawing the device frame where it is until the morph does.
        this.replace(null)
        setStatus({ id: event.id, moving: false, drawsFrame: false })
        break
      case 'frame':
        if (this.frame?.id !== event.id) {
          this.replace(new MorphFrame(event.id, this.root))
          setStatus({ id: event.id, moving: true, drawsFrame: true })
        }
        this.frame?.draw(event)
        break
      case 'end':
        if (this.frame?.id === event.id) this.replace(null)
        if (status?.id === event.id) setStatus(null)
        break
    }
  }

  dispose() {
    this.replace(null)
    setStatus(null)
  }

  private replace(frame: MorphFrame | null) {
    this.frame?.dispose()
    this.frame = frame
  }
}

/**
 * Draws the morphs of the window's active `tab` in `ref`: over the canvas, under the toolbar
 * and the drawer. Another tab starts with none (main stops the old tab's morph when it goes).
 */
export function useLayoutMorphs(ref: RefObject<HTMLElement | null>, tab: string | null) {
  useLayoutEffect(() => {
    const root = ref.current
    if (!root || tab === null) return
    const layer = new MorphLayer(root)
    const off = gui.onMorph((event) => layer.handle(event))
    return () => {
      off()
      layer.dispose()
    }
  }, [ref, tab])
}

interface Slide {
  /** 1 in its place, 0 out of the way */
  spring: Spring
  stop: (() => void) | null
  wait: (() => void) | null
}

interface SlideOptions {
  /** The edge of the window it goes out by: the drawer the bottom, the toolbar the top */
  edge: 'top' | 'bottom'
  /** Its height that stays in the window: focus mode's title bar, under the toolbar */
  keep?: number
  /** Fades as it goes, as well as moving */
  fade?: boolean
}

/**
 * Slides an element of the chrome in and out with the preview's morph: `shown`, it comes in
 * by its edge of the window into its place; hidden, it goes back out. On the default spring,
 * starting when the morph does (or at once, without one), so its edge and the preview's move as
 * one. With Reduce motion on, it fades instead. True while it's on its way out: it's drawn out
 * of the layout then, since the canvas already has its room.
 */
export function useLayoutSlide(
  shown: boolean,
  ref: RefObject<HTMLElement | null>,
  { edge, keep = 0, fade = false }: SlideOptions,
) {
  const [leaving, setLeaving] = useState(false)
  const [wasShown, setWasShown] = useState(shown)
  const slide = useRef<Slide | null>(null)
  const initial = useRef(shown)
  if (wasShown !== shown) {
    setWasShown(shown)
    setLeaving(!shown)
  }

  useLayoutEffect(() => {
    slide.current ??= { spring: new Spring(initial.current ? 1 : 0), stop: null, wait: null }
    const current = slide.current
    const target = shown ? 1 : 0
    const el = ref.current
    // Already there (the first render, or shown and hidden again before it moved): in place,
    // with nothing left of a pose it was held at.
    if (!el || (current.spring.value === target && current.spring.target === target)) {
      current.spring.retarget(target)
      current.spring.finish()
      if (el) {
        el.style.transform = ''
        el.style.opacity = ''
      }
      if (!shown) setLeaving(false)
      return
    }
    const reduced = prefersReducedMotion()
    const travel = (edge === 'bottom' ? 1 : -1) * Math.max(0, el.offsetHeight - keep)
    const draw = (value: number) => {
      const away = value < 1
      el.style.transform = away && !reduced ? `translateY(${(1 - value) * travel}px)` : ''
      el.style.opacity = away && (fade || reduced) ? String(clamp01(value)) : ''
    }
    const rest = () => {
      current.stop = null
      if (shown) return draw(1)
      el.style.transform = ''
      el.style.opacity = ''
      setLeaving(false)
    }
    // Where it is now, held there until the preview starts moving.
    draw(current.spring.value)
    current.wait = whenMorphMoves(() => {
      current.wait = null
      const { spring } = current
      const from = spring.value
      spring.retarget(target)
      current.stop = reduced
        ? animateFade(from, target, REDUCED_FADE_MS, {
            update: (value) => {
              spring.value = value
              spring.velocity = 0
              draw(value)
            },
            rest,
          })
        : animateSpring(spring, { precision: 0.001, update: draw, rest })
    })
    return () => {
      current.wait?.()
      current.wait = null
      current.stop?.()
      current.stop = null
    }
  }, [shown, ref, edge, keep, fade])

  return leaving
}
