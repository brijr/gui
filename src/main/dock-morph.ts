import { performance } from 'node:perf_hooks'
import type { WebContents } from 'electron'
import { SPRINGS, Spring } from '../shared/motion'
import type { Point, Rect } from '../shared/types'
import { motionStep, onDisplayFrames } from './panel-flight'

const KEYS = ['x', 'y', 'width', 'height'] as const
type Key = (typeof KEYS)[number]

/** Close enough to rest: a thousandth of the way, and half a pixel for the offset. */
const PRECISION = { sidebar: 0.001, offset: 0.5 } as const

interface DockMorphOptions {
  /** The page whose frames it steps on: the window's own */
  frames: WebContents
  /** Where it starts: 0 the floating card, 1 the sidebar */
  from: 0 | 1
  /** After every step: lay the chat out where it has got to */
  frame: () => void
  /** Once it rests at its target */
  rest: () => void
}

/**
 * The chat turning from the floating card into the sidebar, or back, as one shape: `sidebar`
 * springs between 0 (the card) and 1 (the sidebar) on the default spring, the one the
 * preview's own morph uses, started on the same frame, so the chat and the page beside it
 * move as one. The chat is drawn between the two rects (`place`), its corners and shadow
 * going as it becomes the sidebar.
 *
 * An offset on springs of its own takes up any jump in where the two ends are (the other edge
 * chosen mid-way, a drag taking over, a shortcut), and the speed of a release, so the shape
 * never jumps and a throw carries on into it. Retargeting keeps the speed, so it can be turned
 * back mid-way.
 */
export class DockMorph {
  private readonly progress: Spring
  private readonly offset: Record<Key, Spring>
  private stopFrames: (() => void) | null
  private last = performance.now()
  /** Waiting for the preview to start moving (`hold`), so the two set off on the same frame */
  private held = false

  constructor(private readonly options: DockMorphOptions) {
    this.progress = new Spring(options.from, { config: SPRINGS.default })
    this.offset = {
      x: new Spring(0, { config: SPRINGS.default }),
      y: new Spring(0, { config: SPRINGS.default }),
      width: new Spring(0, { config: SPRINGS.default }),
      height: new Spring(0, { config: SPRINGS.default }),
    }
    this.stopFrames = onDisplayFrames(options.frames, () => {
      try {
        this.tick()
      } catch (error) {
        // A window gone mid-morph: stop here rather than fail at the display's rate.
        this.stop()
        console.error('[gui] dock morph stopped', error)
      }
    })
  }

  /** How much of the sidebar it is now, 0 to 1. */
  get sidebar() {
    return Math.min(1, Math.max(0, this.progress.value))
  }

  /** Becoming the sidebar (true) or the card. */
  get docking() {
    return this.progress.target === 1
  }

  /** Heads for the sidebar (1) or the card (0), from where it is and as fast as it's going. */
  to(target: 0 | 1) {
    this.progress.retarget(target)
  }

  /** Waits where it is until `release`: for the preview's morph to start moving with it. */
  hold() {
    this.held = true
  }

  /** Sets off from here, now. */
  release() {
    if (!this.held) return
    this.held = false
    this.last = performance.now()
  }

  /** The speed of a release (px/s), carried on by the shape until it settles. */
  push(velocity: Point) {
    this.offset.x.velocity += velocity.x
    this.offset.y.velocity += velocity.y
  }

  /** The ends moved at once, from `before` to `after`: the shape stays put and eases over. */
  absorb(before: Rect, after: Rect) {
    for (const key of KEYS) this.offset[key].value += before[key] - after[key]
  }

  /** Where the chat is drawn now, between the `card` and the `sidebar` rects (not rounded). */
  place(card: Rect, sidebar: Rect): Rect {
    const t = this.sidebar
    const between = (key: Key) =>
      card[key] + (sidebar[key] - card[key]) * t + this.offset[key].value
    return { x: between('x'), y: between('y'), width: between('width'), height: between('height') }
  }

  /** Lands on its target now, without the rest of the motion. */
  finish() {
    if (!this.stopFrames) return
    this.stop()
    this.progress.finish()
    for (const key of KEYS) this.offset[key].finish()
    this.options.rest()
  }

  /** Stops where it is. */
  stop() {
    this.stopFrames?.()
    this.stopFrames = null
  }

  private tick() {
    if (!this.stopFrames) return
    const now = performance.now()
    const dt = motionStep((now - this.last) / 1000)
    this.last = now
    if (this.held) return
    this.progress.step(dt)
    for (const key of KEYS) this.offset[key].step(dt)
    const resting =
      this.progress.atRest(PRECISION.sidebar) &&
      KEYS.every((key) => this.offset[key].atRest(PRECISION.offset))
    if (resting) return this.finish()
    this.options.frame()
  }
}
