import { describe, expect, test } from 'bun:test'
import {
  APPEAR_MS,
  CHAR_MS,
  cubicBezier,
  EASE_IN_OUT,
  GLIDE_MAX_MS,
  GLIDE_MIN_MS,
  glideMs,
  MAX_TYPING_MS,
  MAX_TYPING_STEPS,
  SCROLL_MAX_MS,
  SCROLL_MIN_MS,
  scrollMs,
  typingPlan,
  WHEEL_STEP_MS,
  wheelPlan,
} from '../src/main/input-pace'

// How the agent's input moves while the user watches: bounded, so the agent stays fast.

describe('the pointer glides', () => {
  test('in where it first shows, it fades in instead', () => {
    expect(glideMs(null, { x: 10, y: 10 })).toBe(APPEAR_MS)
  })

  test('already there, it doesn’t move', () => {
    expect(glideMs({ x: 10, y: 10 }, { x: 11, y: 10 })).toBe(0)
  })

  test('longer for a longer way, within its bounds', () => {
    const near = glideMs({ x: 0, y: 0 }, { x: 40, y: 0 })
    const middle = glideMs({ x: 0, y: 0 }, { x: 400, y: 0 })
    const far = glideMs({ x: 0, y: 0 }, { x: 4000, y: 0 })
    expect(near).toBeGreaterThanOrEqual(GLIDE_MIN_MS)
    expect(middle).toBeGreaterThan(near)
    expect(far).toBe(GLIDE_MAX_MS)
  })
})

test('the page scrolls longer for a longer way, within its bounds', () => {
  expect(scrollMs(0)).toBe(SCROLL_MIN_MS)
  expect(scrollMs(1000)).toBeGreaterThan(SCROLL_MIN_MS)
  expect(scrollMs(-50_000)).toBe(SCROLL_MAX_MS)
})

describe('typing', () => {
  test('short text goes a character at a time, at a typist’s pace', () => {
    const plan = typingPlan('hello')
    expect(plan.chunks).toEqual(['h', 'e', 'l', 'l', 'o'])
    expect(plan.stepMs).toBe(CHAR_MS)
  })

  test('long text goes in bigger pieces, never longer in all than the cap', () => {
    const text = 'x'.repeat(10_000)
    const plan = typingPlan(text)
    expect(plan.chunks.length).toBe(MAX_TYPING_STEPS)
    expect(plan.chunks.join('')).toBe(text)
    expect(plan.stepMs * plan.chunks.length).toBeLessThanOrEqual(MAX_TYPING_MS)
  })

  test('every length stays within the cap', () => {
    for (const length of [2, 7, 19, 20, 21, 33, 100, 999]) {
      const plan = typingPlan('a'.repeat(length))
      expect(plan.stepMs * plan.chunks.length).toBeLessThanOrEqual(MAX_TYPING_MS)
      expect(plan.chunks.join('').length).toBe(length)
    }
  })

  test('a character drawn from several code points goes in whole', () => {
    const plan = typingPlan('hi 👩🏽‍💻 é')
    expect(plan.chunks).toContain('👩🏽‍💻')
    expect(plan.chunks).toContain('é')
    expect(plan.chunks.join('')).toBe('hi 👩🏽‍💻 é')
  })

  test('nothing, or one character, goes at once', () => {
    expect(typingPlan('')).toEqual({ chunks: [], stepMs: 0 })
    expect(typingPlan('a')).toEqual({ chunks: ['a'], stepMs: 0 })
  })
})

describe('the wheel', () => {
  test('adds up to exactly the scroll asked for, both ways', () => {
    const { deltas } = wheelPlan(-37.5, 1234)
    const sum = deltas.reduce((total, d) => ({ x: total.x + d.x, y: total.y + d.y }), {
      x: 0,
      y: 0,
    })
    expect(sum.x).toBeCloseTo(-37.5, 6)
    expect(sum.y).toBeCloseTo(1234, 6)
  })

  test('slows to a stop, a frame apart, within the scroll’s time', () => {
    const { deltas, stepMs } = wheelPlan(0, 2000)
    expect(stepMs).toBe(WHEEL_STEP_MS)
    expect(deltas[0].y).toBeGreaterThan(deltas[deltas.length - 1].y)
    expect(deltas.length * stepMs).toBeLessThanOrEqual(SCROLL_MAX_MS + WHEEL_STEP_MS)
  })
})

test('the curve runs from 0 to 1 and never goes back', () => {
  const ease = cubicBezier(...EASE_IN_OUT)
  expect(ease(0)).toBe(0)
  expect(ease(1)).toBe(1)
  let last = 0
  for (let t = 0.05; t < 1; t += 0.05) {
    expect(ease(t)).toBeGreaterThanOrEqual(last)
    last = ease(t)
  }
  // Ease-in-out: slow at both ends.
  expect(ease(0.1)).toBeLessThan(0.1)
  expect(ease(0.9)).toBeGreaterThan(0.9)
})
