import { expect, test } from 'bun:test'
import { scrubSize } from '../src/shared/theme-tokens'

test('scrubbing moves a size by steps, ten with Shift, a tenth with Alt', () => {
  expect(scrubSize('12px', 4, false, false)).toBe('16px')
  expect(scrubSize('12px', -3, false, false)).toBe('9px')
  expect(scrubSize('12px', 2, true, false)).toBe('32px')
  expect(scrubSize('12px', 5, false, true)).toBe('12.5px')
  expect(scrubSize('1rem', 4, false, false)).toBe('1.5rem')
})

test('a partial step does nothing, and a positive size stops at 0', () => {
  expect(scrubSize('12px', 0.9, false, false)).toBe('12px')
  expect(scrubSize('4px', -10, false, false)).toBe('0px')
  expect(scrubSize('-2px', -3, false, false)).toBe('-5px')
})

test('only sizes scrub', () => {
  expect(scrubSize('Inter, sans-serif', 3, false, false)).toBeNull()
  expect(scrubSize('#fff', 3, false, false)).toBeNull()
})
