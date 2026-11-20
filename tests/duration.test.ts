import { expect, test } from 'bun:test'
import { duration } from '../src/renderer/src/lib/time'

test('durations read in the largest units that fit', () => {
  expect(duration(null)).toBeNull()
  expect(duration(400)).toBeNull()
  expect(duration(12_000)).toBe('12s')
  expect(duration(59_000)).toBe('59s')
  expect(duration(60_000)).toBe('1m 0s')
  expect(duration(1_254_000)).toBe('20m 54s')
  expect(duration(3_599_000)).toBe('59m 59s')
  expect(duration(3_600_000)).toBe('1h 0m')
  expect(duration(5_025_000)).toBe('1h 23m')
})
