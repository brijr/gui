import { describe, expect, test } from 'bun:test'
import { CLOSED_TAB_LIMIT, type ClosedTab, ClosedTabs, reopenIndex } from '../src/main/closed-tabs'

const closed = (root: string, index = 0): ClosedTab => ({ kind: 'project', root, index })

describe('File → Reopen Closed Tab', () => {
  test('reopens the tab closed last first, each once', () => {
    const tabs = new ClosedTabs()
    expect(tabs.size).toBe(0)
    expect(tabs.pop()).toBeUndefined()
    tabs.push(closed('/a', 1))
    tabs.push({ kind: 'canvas', root: '/boards/b', index: 0 })
    expect(tabs.size).toBe(2)
    expect(tabs.pop()).toEqual({ kind: 'canvas', root: '/boards/b', index: 0 })
    expect(tabs.pop()).toEqual(closed('/a', 1))
    expect(tabs.pop()).toBeUndefined()
    expect(tabs.size).toBe(0)
  })

  test('remembers only the most recent ones', () => {
    const tabs = new ClosedTabs(3)
    for (const root of ['/1', '/2', '/3', '/4', '/5']) tabs.push(closed(root))
    expect(tabs.size).toBe(3)
    expect([tabs.pop(), tabs.pop(), tabs.pop(), tabs.pop()].map((tab) => tab?.root)).toEqual([
      '/5',
      '/4',
      '/3',
      undefined,
    ])
  })

  test('keeps a handful by default', () => {
    const tabs = new ClosedTabs()
    for (let n = 0; n < CLOSED_TAB_LIMIT + 5; n++) tabs.push(closed(`/${n}`))
    expect(tabs.size).toBe(CLOSED_TAB_LIMIT)
  })

  test('goes back where it was, or at the end of a shorter strip', () => {
    expect(reopenIndex(closed('/a', 1), 3)).toBe(1)
    expect(reopenIndex(closed('/a', 0), 1)).toBe(0)
    expect(reopenIndex(closed('/a', 4), 2)).toBe(2)
    expect(reopenIndex(closed('/a', -1), 2)).toBe(0)
  })
})
