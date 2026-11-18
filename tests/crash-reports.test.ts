import { describe, expect, test } from 'bun:test'
import { scrubPaths } from '../src/main/crash-reports'
import { isBrowserNoise } from '../src/renderer/src/lib/crash-reports'

test('the browser’s ResizeObserver note isn’t a crash; errors are', () => {
  const message = 'ResizeObserver loop completed with undelivered notifications.'
  expect(isBrowserNoise({ error: null, message })).toBe(true)
  expect(isBrowserNoise({ error: null, message: 'ResizeObserver loop limit exceeded' })).toBe(true)
  expect(isBrowserNoise({ error: new Error(message), message: `Uncaught Error: ${message}` })).toBe(
    true,
  )
  expect(isBrowserNoise({ error: null, message: 'Uncaught TypeError: x is undefined' })).toBe(false)
  expect(isBrowserNoise({ error: new RangeError('offset is out of bounds'), message: '' })).toBe(
    false,
  )
})

describe('crash reports leave out whose folder a path is in', () => {
  test('a Mac home and other users’ folders', () => {
    const home = '/Users/ada'
    expect(scrubPaths('at /Users/ada/Projects/x.ts:1', home)).toBe('at ~/Projects/x.ts:1')
    expect(scrubPaths('at /Users/bob/x.ts', home)).toBe('at /Users/~/x.ts')
  })

  test('a Windows home in each way it is written', () => {
    const home = 'C:\\Users\\Ada Lovelace'
    const cases: [string, string][] = [
      ['at C:\\Users\\Ada Lovelace\\gui\\x.js:1:2', 'at ~\\gui\\x.js:1:2'],
      ['"C:\\\\Users\\\\Ada Lovelace\\\\gui"', '"~\\\\gui"'],
      ['at file:///C:/Users/Ada%20Lovelace/gui/x.js', 'at file:///~/gui/x.js'],
      ['at C:/Users/Ada Lovelace/gui/x.js', 'at ~/gui/x.js'],
      ['at c:\\users\\ada lovelace\\gui', 'at ~\\gui'],
    ]
    for (const [text, scrubbed] of cases) expect(scrubPaths(text, home)).toBe(scrubbed)
  })

  test('other Windows users’ folders, names with spaces included', () => {
    const home = 'C:\\Users\\ada'
    expect(scrubPaths('C:\\Users\\Bob Smith\\AppData\\x', home)).toBe('C:\\Users\\~\\AppData\\x')
    expect(scrubPaths('D:\\\\Users\\\\bob\\\\x', home)).toBe('D:\\\\Users\\\\~\\\\x')
    expect(scrubPaths('file:///C:/Users/Bob Smith/x', home)).toBe('file:///C:/Users/~/x')
    expect(scrubPaths('C:\\Documents and Settings\\bob\\x', home)).toBe(
      'C:\\Documents and Settings\\~\\x',
    )
    // A path whose name ends the text.
    expect(scrubPaths("open 'C:\\Users\\bob'", home)).toBe("open 'C:\\Users\\~'")
  })
})
