/*
 * How the agent's input moves while the user watches the preview: its pointer's glide, the
 * page scrolling to a target, typing and the wheel. Each is bounded, so the agent stays fast,
 * and none of it runs with Reduce motion or while the page is out of sight
 * (preview-interactions.ts). Times in milliseconds, distances in the page's CSS pixels.
 */

import type { Point } from '../shared/types'

/** The pointer rests this long on its target before the input lands, so the eye sees where. */
export const DWELL_MS = 90
/** The pointer's first appearance in a turn: it fades in on its target instead of gliding. */
export const APPEAR_MS = 160
/** The shortest and longest glide; between them, longer for a longer way. */
export const GLIDE_MIN_MS = 160
export const GLIDE_MAX_MS = 420
/** The page scrolling (to a target, or by the wheel): longer for a longer way, within these. */
export const SCROLL_MIN_MS = 180
export const SCROLL_MAX_MS = 380
/** Typing: a quick typist's pace, within MAX_TYPING_MS in all and MAX_TYPING_STEPS pieces. */
export const CHAR_MS = 40
export const MAX_TYPING_MS = 800
export const MAX_TYPING_STEPS = 32
/** Between the wheel's events, about a frame. */
export const WHEEL_STEP_MS = 16

/** The overlay's curves (styles.css --ease-in-out and --ease-out), as [x1, y1, x2, y2]. */
export const EASE_IN_OUT = [0.645, 0.045, 0.355, 1] as const
export const EASE_OUT = [0.2, 0, 0, 1] as const

/**
 * How long the pointer takes from `from` to `to` (CSS pixels): it appears where it has no
 * spot yet, doesn't move for a pixel or two, and otherwise takes longer for longer ways,
 * slowing as they grow (as a hand does).
 */
export function glideMs(from: Point | null, to: Point) {
  if (!from) return APPEAR_MS
  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  if (distance < 2) return 0
  return clamp(Math.round(110 + 10 * Math.sqrt(distance)), GLIDE_MIN_MS, GLIDE_MAX_MS)
}

/** How long the page takes to scroll `distance` CSS pixels. */
export function scrollMs(distance: number) {
  return clamp(Math.round(SCROLL_MIN_MS + 0.1 * Math.abs(distance)), SCROLL_MIN_MS, SCROLL_MAX_MS)
}

/**
 * `text` typed a few characters at a time: the pieces in order (whole characters, never half
 * an emoji), and the pause after each but the last. Short text goes a character at a time;
 * long text in bigger pieces, so the whole stays within MAX_TYPING_MS.
 */
export function typingPlan(text: string): { chunks: string[]; stepMs: number } {
  const characters = graphemes(text)
  if (characters.length <= 1) return { chunks: text ? [text] : [], stepMs: 0 }
  const steps = Math.min(characters.length, MAX_TYPING_STEPS)
  const chunks: string[] = []
  for (let i = 0; i < steps; i++) {
    const start = Math.round((i * characters.length) / steps)
    const end = Math.round(((i + 1) * characters.length) / steps)
    chunks.push(characters.slice(start, end).join(''))
  }
  const total = Math.min(characters.length * CHAR_MS, MAX_TYPING_MS)
  return { chunks, stepMs: Math.round(total / steps) }
}

/**
 * A wheel scroll of (`deltaX`, `deltaY`) spread over `scrollMs` of its length as a run of smaller
 * deltas that slow toward the end (EASE_OUT), adding up to exactly the whole, a frame apart.
 */
export function wheelPlan(deltaX: number, deltaY: number): { deltas: Point[]; stepMs: number } {
  const ms = scrollMs(Math.hypot(deltaX, deltaY))
  const steps = Math.max(1, Math.round(ms / WHEEL_STEP_MS))
  const progress = easedSteps(steps, EASE_OUT)
  const deltas: Point[] = []
  let done = { x: 0, y: 0 }
  for (const p of progress) {
    const delta = { x: deltaX * p - done.x, y: deltaY * p - done.y }
    // A step too small to move the page joins the next (the last takes what's left).
    if (Math.abs(delta.x) < 0.5 && Math.abs(delta.y) < 0.5 && p < 1) continue
    if (delta.x || delta.y) deltas.push(delta)
    done = { x: done.x + delta.x, y: done.y + delta.y }
  }
  return { deltas, stepMs: WHEEL_STEP_MS }
}

/** Progress along `curve` at the end of each of `steps` equal steps in time: the last is 1. */
export function easedSteps(steps: number, curve: readonly [number, number, number, number]) {
  const ease = cubicBezier(...curve)
  return Array.from({ length: steps }, (_, i) => (i === steps - 1 ? 1 : ease((i + 1) / steps)))
}

/** `curve` sampled evenly in time, from 0 to 1, for page JavaScript to interpolate. */
export function curveSamples(curve: readonly [number, number, number, number], count = 32) {
  const ease = cubicBezier(...curve)
  return Array.from({ length: count + 1 }, (_, i) => Math.round(ease(i / count) * 1e4) / 1e4)
}

/** A CSS cubic-bezier() timing function: progress at time `t`, both from 0 to 1. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (a: number, b: number, t: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3
  return (t: number) => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    // x is increasing in the curve's parameter: halve the interval until it meets `t`.
    let low = 0
    let high = 1
    for (let i = 0; i < 30; i++) {
      const mid = (low + high) / 2
      if (at(x1, x2, mid) < t) low = mid
      else high = mid
    }
    return at(y1, y2, (low + high) / 2)
  }
}

function graphemes(text: string) {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return Array.from(segmenter.segment(text), (each) => each.segment)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
