import { expect, test } from 'bun:test'
import { isBrowserNoise } from '../src/renderer/src/lib/crash-reports'

test('the browser’s ResizeObserver note isn’t a crash; errors are', () => {
  const message = 'ResizeObserver loop completed with undelivered notifications.'
  expect(isBrowserNoise({ error: null, message })).toBe(true)
  expect(isBrowserNoise({ error: null, message: 'ResizeObserver loop limit exceeded' })).toBe(true)
  expect(isBrowserNoise({ error: new Error(message), message })).toBe(false)
  expect(isBrowserNoise({ error: new RangeError('offset is out of bounds'), message: '' })).toBe(
    false,
  )
})
