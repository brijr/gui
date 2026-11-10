import { describe, expect, test } from 'bun:test'
import {
  applyFindAction,
  CLOSED_FIND,
  findArea,
  findInLines,
  findStatus,
  stepMatch,
} from '../src/shared/find'

describe('Edit → Find goes to what has the keyboard', () => {
  test('a terminal with the keyboard searches itself', () => {
    expect(findArea({ focus: 'chrome', inTerminal: true, previewShown: true })).toBe('terminal')
    expect(findArea({ focus: 'chrome', inTerminal: true, previewShown: false })).toBe('terminal')
  })

  test('the rest of the chrome, the preview and the chat search the preview', () => {
    for (const focus of ['chrome', 'preview', 'chat', 'none'] as const)
      expect(findArea({ focus, inTerminal: false, previewShown: true })).toBe('preview')
    // Only the chrome's page has the terminals: the chat's text fields aren't one.
    expect(findArea({ focus: 'chat', inTerminal: true, previewShown: true })).toBe('preview')
  })

  test('nothing to search without a page in the preview', () => {
    for (const focus of ['chrome', 'preview', 'chat', 'none'] as const)
      expect(findArea({ focus, inTerminal: false, previewShown: false })).toBeNull()
  })
})

describe('the find bar', () => {
  test('⌘F opens it with the keyboard in it; again, selects its text again', () => {
    const opened = applyFindAction(CLOSED_FIND, 'show')
    expect(opened).toEqual({ state: { open: true, query: '', focusKey: 1 }, step: null })
    const typed = { ...opened.state, query: 'hello' }
    expect(applyFindAction(typed, 'show')).toEqual({
      state: { open: true, query: 'hello', focusKey: 2 },
      step: null,
    })
  })

  test('⌘G and ⇧⌘G step through matches, leaving the keyboard where it is', () => {
    const open = { open: true, query: 'hello', focusKey: 3 }
    expect(applyFindAction(open, 'next')).toEqual({ state: open, step: 1 })
    expect(applyFindAction(open, 'previous')).toEqual({ state: open, step: -1 })
  })

  test('⌘G with it closed opens it with what was typed, and steps', () => {
    const closed = { open: false, query: 'hello', focusKey: 3 }
    expect(applyFindAction(closed, 'next')).toEqual({
      state: { open: true, query: 'hello', focusKey: 4 },
      step: 1,
    })
    // Nothing typed: nothing to step to.
    expect(applyFindAction(CLOSED_FIND, 'previous').step).toBeNull()
  })

  test('says what it found', () => {
    expect(findStatus('', { active: 1, total: 3 })).toBe('')
    expect(findStatus('a', null)).toBe('')
    expect(findStatus('a', { active: 0, total: 0 })).toBe('No matches')
    expect(findStatus('a', { active: 2, total: 12 })).toBe('2 of 12')
    expect(findStatus('a', { active: 0, total: 4 })).toBe('4 matches')
  })
})

describe('finding in a terminal', () => {
  const lines = ['$ npm run dev', 'Error: port in use', '', 'error again, ERROR', 'done']

  test('every match, ignoring case, in reading order', () => {
    expect(findInLines(lines, 'error')).toEqual([
      { row: 1, col: 0, length: 5 },
      { row: 3, col: 0, length: 5 },
      { row: 3, col: 13, length: 5 },
    ])
    expect(findInLines(lines, 'nothing')).toEqual([])
    expect(findInLines(lines, '')).toEqual([])
  })

  test('matches never overlap', () => {
    expect(findInLines(['aaaa'], 'aa')).toEqual([
      { row: 0, col: 0, length: 2 },
      { row: 0, col: 2, length: 2 },
    ])
  })

  test('starts at the newest match, at the bottom, and steps around', () => {
    const matches = findInLines(lines, 'error')
    expect(stepMatch(matches, null, 1)).toBe(2)
    const [first, second, third] = matches
    if (!first || !second || !third) throw new Error('three matches')
    expect(stepMatch(matches, first, 1)).toBe(1)
    expect(stepMatch(matches, third, 1)).toBe(0)
    expect(stepMatch(matches, second, -1)).toBe(0)
    expect(stepMatch(matches, first, -1)).toBe(2)
    expect(stepMatch([], first, 1)).toBe(-1)
  })

  test('steps on from a match that has gone, by where it was', () => {
    const matches = findInLines(lines, 'error')
    const gone = { row: 2, col: 0, length: 5 }
    expect(stepMatch(matches, gone, 1)).toBe(1)
    expect(stepMatch(matches, gone, -1)).toBe(0)
  })
})
