import { describe, expect, test } from 'bun:test'
import {
  ExternalOpens,
  MAX_OPENS,
  mayOpenExternal,
  OPEN_AFTER_INPUT_MS,
  OPEN_WINDOW_MS,
} from '../src/main/external-opens'

describe('mayOpenExternal', () => {
  test('only soon after the user’s input', () => {
    expect(mayOpenExternal(0, 0)).toBe(true)
    expect(mayOpenExternal(OPEN_AFTER_INPUT_MS, 0)).toBe(true)
    expect(mayOpenExternal(OPEN_AFTER_INPUT_MS + 1, 0)).toBe(false)
    expect(mayOpenExternal(null, 0)).toBe(false)
    // A clock that went backwards is not input.
    expect(mayOpenExternal(-1, 0)).toBe(false)
  })

  test('at most a few in the window', () => {
    expect(mayOpenExternal(10, MAX_OPENS - 1)).toBe(true)
    expect(mayOpenExternal(10, MAX_OPENS)).toBe(false)
  })
})

describe('ExternalOpens', () => {
  const clock = () => {
    let now = 1_000_000
    return { now: () => now, advance: (ms: number) => (now += ms) }
  }

  test('a page cannot open a tab before the user does anything', () => {
    const time = clock()
    const opens = new ExternalOpens(time.now)
    expect(opens.take()).toBe(false)
  })

  test('a click opens one tab, and a second open needs another click', () => {
    const time = clock()
    const opens = new ExternalOpens(time.now)
    opens.userInput()
    time.advance(50)
    expect(opens.take()).toBe(true)
    expect(opens.take()).toBe(false)
    opens.userInput()
    expect(opens.take()).toBe(true)
  })

  test('an open long after the click is refused', () => {
    const time = clock()
    const opens = new ExternalOpens(time.now)
    opens.userInput()
    time.advance(OPEN_AFTER_INPUT_MS + 1)
    expect(opens.take()).toBe(false)
  })

  test('many clicks still open only a few tabs in the window, then more later', () => {
    const time = clock()
    const opens = new ExternalOpens(time.now)
    let opened = 0
    for (let i = 0; i < 10; i++) {
      opens.userInput()
      if (opens.take()) opened++
      time.advance(100)
    }
    expect(opened).toBe(MAX_OPENS)
    time.advance(OPEN_WINDOW_MS)
    opens.userInput()
    expect(opens.take()).toBe(true)
  })
})
