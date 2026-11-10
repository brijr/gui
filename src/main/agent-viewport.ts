import { VIEWPORTS, type Viewport } from '../shared/types'

/**
 * How long the agent's viewport stays after a width check before the user's comes back. Long
 * enough that a run of checks (390, then 768, then 1440) glides from size to size and returns
 * once, short enough that the preview is soon the user's again once the agent moves on.
 */
export const AGENT_VIEWPORT_HOLD_MS = 2500

/**
 * The viewport the agent's check at `width` (CSS px) shows, as the user would pick it: the
 * device that wide (390 is Mobile), or a frame of that width as tall as the device nearest it.
 */
export function viewportForWidth(width: number): Viewport {
  const devices = VIEWPORTS.flatMap(({ id, size }) => (size ? [{ id, size }] : []))
  const device = devices.find(({ size }) => size.width === width)
  if (device) return device.id
  const nearest = devices.reduce((best, next) =>
    Math.abs(next.size.width - width) < Math.abs(best.size.width - width) ? next : best,
  )
  return `${Math.round(width)}x${nearest.size.height}`
}

/** The tab whose preview the agent resizes. */
export interface AgentViewportHost {
  /** The viewport the preview shows now */
  current(): Viewport
  /** Shows `viewport` as the user's pick would, resizing into it when `morph` (and it can) */
  show(viewport: Viewport, morph: boolean): void
  /** Resolves once the preview rests at the viewport it was last shown */
  settle(): Promise<void>
}

export interface Timers {
  set: (fn: () => void, ms: number) => unknown
  clear: (timer: unknown) => void
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (timer) => clearTimeout(timer as NodeJS.Timeout),
}

/**
 * The agent checking the page at a width, the way the user would: the preview resizes into
 * that viewport, the check runs there, and a moment after the last check the user's viewport
 * comes back, so a run of checks moves from size to size and returns once. The user wins: once
 * they pick a viewport, or anything else changes it, nothing is put back over it.
 */
export class AgentViewport {
  /** The agent's viewport showing, and the user's to come back to */
  private held: { user: Viewport; shown: Viewport } | null = null
  /** Checks running now; the hold starts once the last ends */
  private checks = 0
  /** Bumped when the hold is let go at once, so a check still running doesn't start a new one */
  private epoch = 0
  private timer: unknown = null

  constructor(
    private readonly host: AgentViewportHost,
    private readonly holdMs = AGENT_VIEWPORT_HOLD_MS,
    private readonly timers: Timers = realTimers,
  ) {}

  /** The agent's viewport, while it shows in place of the user's */
  get shown() {
    return this.held?.shown ?? null
  }

  /** The user's viewport, while the agent's shows in its place */
  get user() {
    return this.held?.user ?? null
  }

  /** Shows `viewport`, runs `run` once the preview rests there, then holds it a moment. */
  async check<T>(viewport: Viewport, run: () => Promise<T>): Promise<T> {
    const epoch = this.epoch
    this.cancelTimer()
    this.checks++
    try {
      if (this.show(viewport)) await this.host.settle()
      return await run()
    } finally {
      if (epoch === this.epoch) {
        this.checks--
        if (this.checks === 0 && this.held) {
          this.timer = this.timers.set(() => {
            this.timer = null
            this.restore()
          }, this.holdMs)
        }
      }
    }
  }

  /** The user chose a viewport: it's theirs, and stays. */
  userChose() {
    this.cancelTimer()
    this.held = null
  }

  /**
   * The user's viewport again, now (the hold lapsed, the turn ended, the tab went to the
   * background, the project is closing). Not when something else changed it meanwhile.
   */
  restore(morph = true) {
    this.cancelTimer()
    this.epoch++
    this.checks = 0
    const held = this.held
    this.held = null
    if (held && this.host.current() === held.shown) this.host.show(held.user, morph)
  }

  dispose() {
    this.cancelTimer()
    this.epoch++
    this.checks = 0
    this.held = null
  }

  /** Shows `viewport` when it isn't already; whether it had to. */
  private show(viewport: Viewport) {
    const current = this.host.current()
    // Changed since the agent showed its own (another canvas frame opened): that one stays.
    if (this.held && current !== this.held.shown) this.held = null
    if (current === viewport) return false
    this.held = { user: this.held?.user ?? current, shown: viewport }
    this.host.show(viewport, true)
    return true
  }

  private cancelTimer() {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }
}
