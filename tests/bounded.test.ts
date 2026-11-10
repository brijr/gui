import { describe, expect, test } from 'bun:test'
import { bounded } from '../src/shared/bounded'

describe('bounded growth', () => {
  test('keeps the newest items', () => {
    expect(bounded([1, 2, 3, 4], 2)).toEqual([3, 4])
    expect(bounded([1, 2], 5)).toEqual([1, 2])
  })
})
