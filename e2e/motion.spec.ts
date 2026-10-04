import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { project, SPRINGS, Spring, springEasing } from '../src/shared/motion'
import { REPO_ROOT } from './helpers/env'

// The spring and the momentum projection behind every animation the user can touch
// (src/shared/motion.ts). Pure functions: no app to launch.

/** Steps `spring` at `hz` until it rests; every value it passed through. */
function run(spring: Spring, hz = 120, limit = 5) {
  const values: number[] = []
  for (let t = 0; t < limit && !spring.atRest(); t += 1 / hz) {
    spring.step(1 / hz)
    values.push(spring.value)
  }
  return values
}

test('a critically damped spring lands without overshooting', () => {
  const spring = new Spring(0, { target: 100 })
  const values = run(spring)
  expect(Math.max(...values)).toBeLessThanOrEqual(100)
  // Never moves backwards on the way.
  for (let i = 1; i < values.length; i++) {
    expect(values[i]).toBeGreaterThanOrEqual(values[i - 1] ?? 0)
  }
  // Response 0.35 s: within half a pixel of 100 px in about 0.5 s.
  const seconds = values.length / 120
  expect(seconds).toBeGreaterThan(0.35)
  expect(seconds).toBeLessThan(0.7)
  spring.finish()
  expect(spring.value).toBe(100)
  expect(spring.velocity).toBe(0)
})

test('a step is exact whatever the frame rate', () => {
  for (const config of [SPRINGS.default, SPRINGS.thrown, { damping: 1.4, response: 0.3 }]) {
    const fine = new Spring(0, { target: 300, velocity: -800, config })
    for (let i = 0; i < 250; i++) fine.step(0.001)
    const coarse = new Spring(0, { target: 300, velocity: -800, config })
    coarse.step(0.25)
    expect(coarse.value).toBeCloseTo(fine.value, 6)
    expect(coarse.velocity).toBeCloseTo(fine.velocity, 4)
  }
})

test('a thrown spring keeps the release velocity and overshoots only a little', () => {
  const spring = new Spring(0, { target: 400, velocity: 2000, config: SPRINGS.thrown })
  spring.step(1 / 120)
  // Moving at the throw's speed from the first frame, not starting from rest.
  expect(spring.value).toBeGreaterThan(2000 / 120 - 2)
  const values = run(spring)
  const peak = Math.max(...values)
  expect(peak).toBeGreaterThan(400)
  expect(peak).toBeLessThan(400 * 1.06)
  expect(spring.value).toBeCloseTo(400, 0)
})

test('retargeting mid-flight keeps the value and the velocity', () => {
  const spring = new Spring(0, { target: 100 })
  for (let i = 0; i < 10; i++) spring.step(1 / 120)
  const { value, velocity } = spring
  expect(velocity).toBeGreaterThan(0)
  spring.retarget(-100, SPRINGS.thrown)
  expect(spring.value).toBe(value)
  expect(spring.velocity).toBe(velocity)
  // Still carried forward for a moment before turning toward the new target.
  spring.step(1 / 120)
  expect(spring.value).toBeGreaterThan(value)
  run(spring)
  expect(spring.value).toBeCloseTo(-100, 0)
})

test('momentum projects where a flick would come to rest', () => {
  // UIScrollView's normal deceleration: 0.998 per ms, so v · 0.499 s further on.
  expect(project(100, 1000)).toBeCloseTo(599, 6)
  expect(project(100, -2000)).toBeCloseTo(-898, 6)
  expect(project(100, 0)).toBe(100)
  // A faster deceleration carries it less far.
  expect(project(0, 1000, 0.99)).toBeCloseTo(99, 6)
})

test("the CSS spring easing is the default spring's curve", () => {
  const { duration, easing } = springEasing()
  expect(duration).toBeGreaterThan(300)
  expect(duration).toBeLessThan(600)
  // Whitespace aside: the formatter wraps the curve over several lines.
  const css = readFileSync(join(REPO_ROOT, 'src/renderer/src/styles.css'), 'utf8').replace(
    /\s+/g,
    '',
  )
  expect(css).toContain(`--ease-spring:${easing.replace(/\s+/g, '')};`)
  expect(css).toContain(`--motion-spring:${duration}ms;`)
})
