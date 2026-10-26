import { expect, test } from 'bun:test'
import { assetName } from '../src/main/board-tool-workflow'

test('website screenshots are saved under a plain name inside assets/', () => {
  expect(assetName('Stripe Home')).toBe('stripe-home.jpg')
  expect(assetName('ref.PNG')).toBe('ref.jpg')
  expect(assetName('ref.jpeg')).toBe('ref.jpg')
  expect(assetName('../../etc/passwd')).toBe('etc-passwd.jpg')
  expect(assetName('/abs/path')).toBe('abs-path.jpg')
  expect(assetName('...')).toBe('screenshot.jpg')
})
