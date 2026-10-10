import { useEffect, useState } from 'react'
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

/** Advances by `dt` seconds; true once it's done and can leave the loop. */
type Tick = (dt: number) => boolean

/** Each running tick, and the time it was last stepped to (when it started, at first). */
const ticks = new Map<Tick, number>()
let frame = 0

function loop(now: number) {
  // Real time, from where each one last left off, so a late frame catches up rather than
  // slowing the motion down (the spring is exact for any step), and a first frame steps only
  // the time since it started, whatever the refresh rate; a stall longer than 0.1 s is taken
  // as 0.1 s.
  for (const [tick, since] of [...ticks]) {
    if (!ticks.has(tick)) continue
    ticks.set(tick, now)
    if (tick(Math.min(Math.max(0, now - since) / 1000, 0.1))) ticks.delete(tick)
  }
  frame = ticks.size > 0 ? requestAnimationFrame(loop) : 0
}

// A hidden page gets no frames: whatever is moving lands now, rather than playing out the rest
// when the page is shown again (a tab switched back to, a chat shown again).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return
  for (let pass = 0; pass < 10 && ticks.size > 0; pass++) {
    for (const tick of [...ticks.keys()]) {
      if (tick(10)) ticks.delete(tick)
    }
  }
})

/** Runs `tick` every animation frame until it returns true or the returned stop is called. */
export function onFrames(tick: Tick): () => void {
  ticks.set(tick, performance.now())
  if (!frame) frame = requestAnimationFrame(loop)
  return () => {
    ticks.delete(tick)
  }
}

/**
 * Steps `spring` every frame, calling `update` with its value, until it rests (`precision`, in
 * the spring's units), then lands it on its target and calls `rest`. The spring stays the
 * caller's: retarget it while this runs and the animation follows, keeping its velocity. A
 * hidden page has no frames, so there it lands at once, calls `rest` before returning, and
 * returns null: there's nothing running to stop.
 */
export function animateSpring(
  spring: Spring,
  {
    precision = 0.5,
    update,
    rest,
  }: { precision?: number; update: (value: number) => void; rest?: () => void },
): (() => void) | null {
  const land = () => {
    spring.finish()
    update(spring.value)
    rest?.()
  }
  if (document.visibilityState === 'hidden') {
    land()
    return null
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
 * movement, just opacity changing linearly. Null when it's done at once (a hidden page).
 */
export function animateFade(
  from: number,
  to: number,
  duration: number,
  { update, rest }: { update: (value: number) => void; rest?: () => void },
): (() => void) | null {
  if (document.visibilityState === 'hidden' || duration <= 0) {
    update(to)
    rest?.()
    return null
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

/**
 * Keeps something mounted for `exitMs` after `open` turns false, so its close can play (a
 * popover going back the way it came). Opening again meanwhile keeps it.
 */
export function usePresence(open: boolean, exitMs: number) {
  const [closing, setClosing] = useState(false)
  const [wasOpen, setWasOpen] = useState(open)
  // Closed just now: stays mounted while it closes.
  if (wasOpen !== open) {
    setWasOpen(open)
    setClosing(!open)
  }
  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(() => setClosing(false), exitMs)
    return () => clearTimeout(timer)
  }, [closing, exitMs])
  return open || closing
}

/**
 * A motion duration from styles.css (`--motion-exit`, `--motion-fade`…) in ms, for script that
 * has to wait for a CSS transition or run its own, so the two can't drift apart.
 */
export function motionMs(name: `--motion-${string}`): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const ms = Number.parseFloat(value)
  return value.endsWith('s') && !value.endsWith('ms') ? ms * 1000 : ms
}
