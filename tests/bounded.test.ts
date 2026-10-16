import { describe, expect, test } from 'bun:test'
import { BoundedQueue, bounded, chunked } from '../src/shared/bounded'

describe('bounded growth', () => {
  test('keeps the newest items', () => {
    expect(bounded([1, 2, 3, 4], 2)).toEqual([3, 4])
    expect(bounded([1, 2], 5)).toEqual([1, 2])
  })

  test('chunks a list without copying the tail twice', () => {
    expect([...chunked([1, 2, 3, 4, 5], 2)]).toEqual([[1, 2], [3, 4], [5]])
  })

  test('a queue drops the oldest past its cap', () => {
    const queue = new BoundedQueue<number>(2)
    queue.push(1)
    queue.push(2)
    queue.push(3)
    expect(queue.toArray()).toEqual([2, 3])
    expect(queue.shift()).toBe(2)
    expect(queue.size).toBe(1)
  })
})
