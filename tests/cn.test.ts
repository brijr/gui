import { expect, test } from 'bun:test'
import { cn } from '../src/renderer/src/lib/cn'

test('a later class overrides an earlier one that sets the same thing', () => {
  expect(cn('h-9 pl-3 pr-1.5', 'pl-1.5')).toBe('h-9 pr-1.5 pl-1.5')
  expect(cn('whitespace-nowrap', 'whitespace-normal')).toBe('whitespace-normal')
  expect(cn('rounded-md bg-raised', false, 'bg-accent-soft')).toBe('rounded-md bg-accent-soft')
})

test("Gui's own scales are told apart", () => {
  // A text size and a text color are different things, so both stay.
  expect(cn('text-small text-muted', 'text-fg')).toBe('text-small text-fg')
  expect(cn('text-small', 'text-caption')).toBe('text-caption')
  expect(cn('shadow-control', 'shadow-popover')).toBe('shadow-popover')
  expect(cn('z-chrome', 'z-popover')).toBe('z-popover')
  expect(cn('ease-out', 'ease-spring')).toBe('ease-spring')
  expect(cn('animate-spin', 'animate-row-in')).toBe('animate-row-in')
  // Its own utilities pass through.
  expect(cn('scroll-fade tint inline-code', 'scroll-stable')).toBe(
    'scroll-fade tint inline-code scroll-stable',
  )
})
