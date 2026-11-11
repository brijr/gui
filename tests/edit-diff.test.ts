import { describe, expect, test } from 'bun:test'
import { MAX_DIFF_LINE_CHARS, MAX_PERMISSION_DIFF_LINES } from '../src/shared/bounded'
import { changedLines, editDiffs } from '../src/shared/edit-diff'

describe('changedLines', () => {
  test('keeps only what the edit removes and adds, in order', () => {
    const before = ['{', '  "name": "app",', '  "version": "1.0.0",', '  "private": true', '}']
    const after = ['{', '  "name": "app",', '  "version": "1.1.0",', '  "private": true', '}']
    expect(changedLines(before.join('\n'), after.join('\n'))).toEqual([
      { sign: '-', text: '  "version": "1.0.0",' },
      { sign: '+', text: '  "version": "1.1.0",' },
    ])
  })

  test('two edits apart leave the lines between them out', () => {
    expect(changedLines('a\nb\nc\nd\ne', 'A\nb\nc\nd\nE')).toEqual([
      { sign: '-', text: 'a' },
      { sign: '+', text: 'A' },
      { sign: '-', text: 'e' },
      { sign: '+', text: 'E' },
    ])
  })

  test('a new file is all added', () => {
    expect(changedLines(null, 'one\ntwo')).toEqual([
      { sign: '+', text: 'one' },
      { sign: '+', text: 'two' },
    ])
  })
})

describe('editDiffs', () => {
  test('keeps a bounded number of lines across files, each cut short', () => {
    const long = 'x'.repeat(MAX_DIFF_LINE_CHARS + 50)
    const many = Array.from({ length: MAX_PERMISSION_DIFF_LINES }, (_, i) => `line ${i}`)
    const diffs = editDiffs([
      { path: 'a.txt', oldText: '', newText: [long, ...many].join('\n') },
      { path: 'b.txt', oldText: 'old', newText: 'new' },
      { path: 'same.txt', oldText: 'same', newText: 'same' },
    ])
    expect(diffs.map((diff) => diff.path)).toEqual(['a.txt', 'b.txt'])
    const [a, b] = diffs
    expect(a?.lines[0]?.text).toBe(`${'x'.repeat(MAX_DIFF_LINE_CHARS)}…`)
    expect(a?.lines.length).toBe(MAX_PERMISSION_DIFF_LINES)
    // An empty file had no lines: all of the new one's are added, past the cap counted.
    expect(a?.more).toBe(1)
    expect(b).toEqual({ path: 'b.txt', lines: [], more: 2 })
  })
})
