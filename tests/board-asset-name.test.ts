import { expect, test } from 'bun:test'
import { assetName } from '../src/main/board-tool-workflow'

test('website screenshots are saved under a plain name inside assets/', () => {
  expect(assetName('Stripe Home')).toBe('stripe-home.png')
  expect(assetName('ref.PNG')).toBe('ref.png')
  expect(assetName('../../etc/passwd')).toBe('etc-passwd.png')
  expect(assetName('/abs/path')).toBe('abs-path.png')
  expect(assetName('...')).toBe('screenshot.png')
})
