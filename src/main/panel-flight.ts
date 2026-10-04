import { performance } from 'node:perf_hooks'
import { type BrowserWindow, screen, systemPreferences } from 'electron'
import { Spring, type SpringConfig } from '../shared/motion'

/*
 * The main process's side of src/shared/motion.ts. The floating chat is a native view, so its
 * motion is main's: a pair of springs stepped from a timer at the display's refresh rate, each
 * step moving the view with `setBounds`.
 */

export interface Point {
  x: number
  y: number
}

/** The system's Reduce motion setting, read when an animation starts. */
export function prefersReducedMotion() {
  try {
    return systemPreferences.getAnimationSettings().prefersReducedMotion
  } catch {
    return false
  }
}

/** The refresh rate of the display the window is on; 60 when it doesn't say. */
function refreshRate(win: BrowserWindow) {
  try {
    const hz = screen.getDisplayMatching(win.getBounds()).displayFrequency
    return hz >= 30 && hz <= 240 ? hz : 60
  } catch {
    return 60
  }
}

/** A step that late (the main thread was busy) is cut short so it reads as motion, not a jump. */
const MAX_STEP = 1 / 30

interface FlightOptions {
  win: BrowserWindow
  from: Point
  /** Units per second: the release velocity of a throw, or a flight's that was redirected */
  velocity: Point
  config: SpringConfig
  /**
   * Where it's going, asked again before every step: the window, the canvas or the panel's
   * size can change mid-flight, and the flight follows.
   */
  target: () => Point
  /** After every step: lay the view out at `point` */
  frame: () => void
  /** Once it's landed on its target */
  rest: () => void
}

/**
 * A point (the floating panel's anchored corner) springing to a target, X and Y on springs of
 * their own. Steps at the display's refresh rate until both rest, then lands exactly on the
 * target and stops its timer. `stop` leaves it where it is, for a grab mid-flight.
 */
export class Flight {
  private readonly x: Spring
  private readonly y: Spring
  private timer: NodeJS.Timeout | null
  private last = performance.now()
  private readonly options: FlightOptions

  constructor(options: FlightOptions) {
    this.options = options
    const { from, velocity, config } = options
    const target = options.target()
    this.x = new Spring(from.x, { target: target.x, velocity: velocity.x, config })
    this.y = new Spring(from.y, { target: target.y, velocity: velocity.y, config })
    this.timer = setInterval(() => this.tick(), 1000 / refreshRate(options.win))
  }

  /** Where it is now. */
  get point(): Point {
    return { x: this.x.value, y: this.y.value }
  }

  /** How fast it's moving, in units per second. */
  get velocity(): Point {
    return { x: this.x.velocity, y: this.y.velocity }
  }

  get running() {
    return this.timer !== null
  }

  /** Stops where it is. */
  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Lands on its target now, without the rest of the motion. */
  finish() {
    if (!this.running) return
    this.stop()
    const target = this.options.target()
    this.x.retarget(target.x)
    this.y.retarget(target.y)
    this.x.finish()
    this.y.finish()
    this.options.rest()
  }

  private tick() {
    const now = performance.now()
    const dt = Math.min((now - this.last) / 1000, MAX_STEP)
    this.last = now
    const target = this.options.target()
    this.x.retarget(target.x)
    this.y.retarget(target.y)
    this.x.step(dt)
    this.y.step(dt)
    if (this.x.atRest() && this.y.atRest()) {
      this.stop()
      this.x.finish()
      this.y.finish()
      this.options.rest()
      return
    }
    this.options.frame()
  }
}
