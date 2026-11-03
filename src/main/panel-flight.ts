import { performance } from 'node:perf_hooks'
import { app, ipcMain, systemPreferences, type WebContents } from 'electron'
import { Events, Send } from '../shared/ipc'
import { Spring, type SpringConfig } from '../shared/motion'

/*
 * The main process's side of src/shared/motion.ts. The floating chat is a native view, so its
 * motion is main's: a pair of springs stepped on the display's frames, each step moving the
 * view with `setBounds`.
 */

export interface Point {
  x: number
  y: number
}

/**
 * The system's Reduce motion setting, read when an animation starts. Unpackaged builds take
 * GUI_E2E_REDUCED_MOTION=1 or 0 over it, so the end-to-end tests don't depend on the machine
 * they run on (CI's runner has Reduce motion on).
 */
export function prefersReducedMotion() {
  const forced = app.isPackaged ? undefined : process.env.GUI_E2E_REDUCED_MOTION
  if (forced === '1') return true
  if (forced === '0') return false
  try {
    return systemPreferences.getAnimationSettings().prefersReducedMotion
  } catch {
    return false
  }
}

/**
 * Without the page's frames for this long (it's hidden, or busy), a timer steps in, at about
 * 60 Hz, until they come back.
 */
const FALLBACK_MS = 34
const FALLBACK_INTERVAL_MS = 1000 / 60

const frameTicks = new Map<WebContents, Set<() => void>>()
let listening = false

/**
 * Runs `tick` once per frame the display shows, until the returned stop is called. Main has no
 * vsync of its own, and a timer at the refresh rate beats against it (timers land on whole
 * milliseconds and drift), so a moving view judders: a frame repeated, then a double step.
 * Instead `contents`' page (the preload) sends a message from each of its animation frames
 * while asked to. A timer covers for it while it has none.
 */
export function onDisplayFrames(contents: WebContents, tick: () => void): () => void {
  if (!listening) {
    listening = true
    ipcMain.on(Send.displayFrame, (event) => {
      for (const each of [...(frameTicks.get(event.sender) ?? [])]) each()
    })
  }
  let ticks = frameTicks.get(contents)
  if (!ticks) {
    ticks = new Set()
    frameTicks.set(contents, ticks)
    if (!contents.isDestroyed()) contents.send(Events.displayFrames, true)
  }
  /** When the page last sent a frame; the timer's own steps don't count, so once it takes
   *  over it steps on every tick, not every third, until the page's frames come back. */
  let lastFrame = performance.now()
  const step = () => {
    lastFrame = performance.now()
    tick()
  }
  ticks.add(step)
  const fallback = setInterval(() => {
    if (performance.now() - lastFrame > FALLBACK_MS) tick()
  }, FALLBACK_INTERVAL_MS)
  return () => {
    clearInterval(fallback)
    const set = frameTicks.get(contents)
    if (!set?.delete(step) || set.size > 0) return
    frameTicks.delete(contents)
    if (!contents.isDestroyed()) contents.send(Events.displayFrames, false)
  }
}

/**
 * Steps follow real time, so a late tick catches up (the springs are exact for any step); a
 * stall longer than this is taken as this long.
 */
const MAX_STEP = 0.1

interface FlightOptions {
  /** The page whose frames it steps on: the window's own */
  frames: WebContents
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
 * their own. Steps on the display's frames until both rest, then lands exactly on the
 * target and stops its timer. `stop` leaves it where it is, for a grab mid-flight.
 */
export class Flight {
  private readonly x: Spring
  private readonly y: Spring
  private unsubscribe: (() => void) | null
  private last = performance.now()
  private readonly options: FlightOptions

  constructor(options: FlightOptions) {
    this.options = options
    const { from, velocity, config } = options
    const target = options.target()
    this.x = new Spring(from.x, { target: target.x, velocity: velocity.x, config })
    this.y = new Spring(from.y, { target: target.y, velocity: velocity.y, config })
    this.unsubscribe = onDisplayFrames(options.frames, () => {
      try {
        this.tick()
      } catch (error) {
        // A window gone mid-flight: stop here rather than fail at the display's rate.
        this.stop()
        console.error('[gui] panel flight stopped', error)
      }
    })
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
    return this.unsubscribe !== null
  }

  /** Stops where it is. */
  stop() {
    this.unsubscribe?.()
    this.unsubscribe = null
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
    if (!this.running) return
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
