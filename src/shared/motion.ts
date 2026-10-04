/**
 * Motion for everything the user can touch, after Apple's "Designing Fluid Interfaces": springs
 * rather than fixed durations, started from wherever the thing is and however fast it's already
 * going, so any animation can be grabbed or redirected mid-flight.
 *
 * Springs use Apple's parametrisation: a damping ratio (1 settles as fast as possible without
 * overshooting; below 1 it bounces) and a response, the period in seconds of the undamped
 * oscillation, which sets how quickly it gets there. They're solved exactly rather than
 * integrated, so a step is right whatever the frame rate and a late tick can't make one
 * overshoot. Pure: main steps them from a timer (panel-flight.ts), the renderers from
 * requestAnimationFrame (renderer/src/lib/motion.ts).
 */

export interface SpringConfig {
  /** Damping ratio: 1 is critically damped, below 1 overshoots and settles back. */
  damping: number
  /** Seconds: the period of the undamped oscillation (Apple's "response"). */
  response: number
}

/**
 * Critically damped by default: nothing bounces unless the user threw it. A throw's spring is
 * a little underdamped (about 1.5% overshoot from rest, more with the throw's speed handed to
 * it) and a little slower, so the momentum reads as carried into the landing rather than cut
 * off, without a wobble.
 */
export const SPRINGS = {
  default: { damping: 1, response: 0.35 },
  thrown: { damping: 0.8, response: 0.4 },
} as const satisfies Record<string, SpringConfig>

/**
 * How fast scrolling decelerates on Apple platforms (UIScrollView's normal rate): the share of
 * velocity left after each millisecond.
 */
export const DECELERATION_RATE = 0.998

/** Matches when the user asked for less motion: movement goes, short cross-fades stay. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * Where something released at `velocity` (units per second) would come to rest if it slowed
 * down like a scroll view: `position + (v / 1000) · d / (1 − d)`. Choosing the landing spot
 * from this, rather than from where the pointer let go, is what makes a flick feel thrown.
 */
export function project(position: number, velocity: number, decelerationRate = DECELERATION_RATE) {
  return position + ((velocity / 1000) * decelerationRate) / (1 - decelerationRate)
}

/**
 * The spring's displacement from its target and its velocity after `t` seconds, from `x0` and
 * `v0`: the damped harmonic oscillator's closed form for each damping regime.
 */
function solve(x0: number, v0: number, { damping, response }: SpringConfig, t: number) {
  const w0 = (2 * Math.PI) / response
  if (Math.abs(damping - 1) < 1e-6) {
    const decay = Math.exp(-w0 * t)
    const b = v0 + w0 * x0
    return { x: decay * (x0 + b * t), v: decay * (v0 - w0 * b * t) }
  }
  if (damping < 1) {
    const wd = w0 * Math.sqrt(1 - damping * damping)
    const decay = Math.exp(-damping * w0 * t)
    const b = (v0 + damping * w0 * x0) / wd
    const cos = Math.cos(wd * t)
    const sin = Math.sin(wd * t)
    const x = decay * (x0 * cos + b * sin)
    return { x, v: -damping * w0 * x + decay * wd * (b * cos - x0 * sin) }
  }
  const root = w0 * Math.sqrt(damping * damping - 1)
  const r1 = -damping * w0 + root
  const r2 = -damping * w0 - root
  const c2 = (v0 - r1 * x0) / (r2 - r1)
  const c1 = x0 - c2
  const e1 = Math.exp(r1 * t)
  const e2 = Math.exp(r2 * t)
  return { x: c1 * e1 + c2 * e2, v: c1 * r1 * e1 + c2 * r2 * e2 }
}

/**
 * One value on a spring. Retargeting keeps its value and velocity, so redirecting it mid-flight
 * is continuous; the config can change on retarget too (a throw after a drop).
 */
export class Spring {
  value: number
  /** Units per second */
  velocity: number
  target: number
  config: SpringConfig

  constructor(
    value: number,
    {
      target = value,
      velocity = 0,
      config = SPRINGS.default,
    }: { target?: number; velocity?: number; config?: SpringConfig } = {},
  ) {
    this.value = value
    this.target = target
    this.velocity = velocity
    this.config = config
  }

  retarget(target: number, config: SpringConfig = this.config) {
    this.target = target
    this.config = config
  }

  /** Advances `dt` seconds. */
  step(dt: number) {
    if (dt <= 0) return
    const { x, v } = solve(this.value - this.target, this.velocity, this.config, dt)
    this.value = this.target + x
    this.velocity = v
  }

  /**
   * Close enough to its target, and slow enough, that the rest of the way can't be seen:
   * within `precision` (half a pixel for positions) and moving under 20 precisions a second.
   */
  atRest(precision = 0.5) {
    return (
      Math.abs(this.value - this.target) <= precision && Math.abs(this.velocity) <= precision * 20
    )
  }

  /** Lands on the target and stops. */
  finish() {
    this.value = this.target
    this.velocity = 0
  }
}

/**
 * A spring from 0 to 1 as a CSS `linear()` easing and the duration it takes to come within
 * `precision` of the end, for transitions CSS runs itself (styles.css `--ease-spring`).
 */
export function springEasing(config: SpringConfig = SPRINGS.default, precision = 0.005) {
  const spring = new Spring(0, { target: 1, config })
  const frame = 1 / 120
  let duration = 0
  while (!spring.atRest(precision) && duration < 5) {
    spring.step(frame)
    duration += frame
  }
  const steps = 20
  const points: string[] = []
  for (let i = 0; i <= steps; i++) {
    const { x } = solve(-1, 0, config, (duration * i) / steps)
    points.push(String(Math.round((1 + x) * 1000) / 1000))
  }
  points[steps] = '1'
  return { duration: Math.round(duration * 1000), easing: `linear(${points.join(', ')})` }
}
