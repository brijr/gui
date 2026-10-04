import { useSyncExternalStore } from 'react'
import { REDUCED_MOTION_QUERY, type Spring } from '../../../shared/motion'

/*
 * The renderers' side of src/shared/motion.ts: one requestAnimationFrame loop that steps every
 * running spring, and the user's reduced-motion setting. Springs here write styles straight to
 * the element each frame (transform and opacity only), never through React state.
 */

const reducedMotion = matchMedia(REDUCED_MOTION_QUERY)

/** Read when an animation starts, so a change to the setting applies from the next one. */
export function prefersReducedMotion() {
  return reducedMotion.matches
}

function subscribe(onChange: () => void) {
  reducedMotion.addEventListener('change', onChange)
  return () => reducedMotion.removeEventListener('change', onChange)
}

/** For rendering: true while the user asks for reduced motion. */
export function useReducedMotion() {
  return useSyncExternalStore(subscribe, prefersReducedMotion)
}

/** Advances by `dt` seconds; true once it's done and can leave the loop. */
type Tick = (dt: number) => boolean

const ticks = new Set<Tick>()
let frame = 0
let last = 0

function loop(now: number) {
  // A frame that comes late (a busy main thread) steps by at most 1/30 s: the spring is exact
  // for any step, but a jump that large would read as a skip rather than motion.
  const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60
  last = now
  for (const tick of [...ticks]) {
    if (tick(dt)) ticks.delete(tick)
  }
  if (ticks.size > 0) {
    frame = requestAnimationFrame(loop)
  } else {
    frame = 0
    last = 0
  }
}

/** Runs `tick` every animation frame until it returns true or the returned stop is called. */
export function onFrames(tick: Tick): () => void {
  ticks.add(tick)
  if (!frame) frame = requestAnimationFrame(loop)
  return () => {
    ticks.delete(tick)
  }
}

/**
 * Steps `spring` every frame, calling `update` with its value, until it rests (`precision`, in
 * the spring's units), then lands it on its target and calls `rest`. The spring stays the
 * caller's: retarget it while this runs and the animation follows, keeping its velocity. A
 * hidden page has no frames, so there it lands at once.
 */
export function animateSpring(
  spring: Spring,
  {
    precision = 0.5,
    update,
    rest,
  }: { precision?: number; update: (value: number) => void; rest?: () => void },
): () => void {
  const land = () => {
    spring.finish()
    update(spring.value)
    rest?.()
  }
  if (document.visibilityState === 'hidden') {
    land()
    return () => undefined
  }
  return onFrames((dt) => {
    spring.step(dt)
    if (!spring.atRest(precision)) {
      update(spring.value)
      return false
    }
    land()
    return true
  })
}

/**
 * A plain fade of `duration` ms from `from` to `to`, for reduced motion: no spring, no
 * movement, just opacity changing linearly.
 */
export function animateFade(
  from: number,
  to: number,
  duration: number,
  { update, rest }: { update: (value: number) => void; rest?: () => void },
): () => void {
  if (document.visibilityState === 'hidden' || duration <= 0) {
    update(to)
    rest?.()
    return () => undefined
  }
  let elapsed = 0
  return onFrames((dt) => {
    elapsed += dt * 1000
    const done = elapsed >= duration
    update(done ? to : from + ((to - from) * elapsed) / duration)
    if (done) rest?.()
    return done
  })
}
