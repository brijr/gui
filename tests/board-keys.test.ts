import { describe, expect, test } from 'bun:test'
import {
  type BoardKey,
  boardKey,
  type KeyBoard,
  nudged,
  nudgeLanding,
  ZOOM_STEP,
} from '../src/renderer/src/board/keys'
import type { BoardFrame } from '../src/shared/types'

// What a key does on the canvas board, as a plain function of the key and the board.

const frame = (id: string, x: number): BoardFrame => ({
  id,
  name: id,
  x,
  y: 0,
  width: 100,
  height: 80,
  version: 1,
  captured: true,
})
const frames = [frame('a', 0), frame('b', 200), frame('c', 400)]
const section = { id: 's', name: 'Hero', frames: ['b', 'c'] }
const board = (selection: string[] = [], picked = false): KeyBoard => ({
  frames,
  drawn: frames,
  sections: [section],
  selection,
  picked: picked ? section : undefined,
})
const key = (name: string, extra: Partial<BoardKey> = {}): BoardKey => ({
  key: name,
  code: name.length === 1 ? `Key${name.toUpperCase()}` : name,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
})
const meta = { metaKey: true }

describe('keys on the board', () => {
  test('Delete removes the selected frames, or the picked section alone', () => {
    expect(boardKey(key('Backspace'), board(['a']))).toEqual({ type: 'delete', ids: ['a'] })
    expect(boardKey(key('Delete'), board(['b', 'c'], true))).toEqual({
      type: 'deleteSection',
      id: 's',
    })
    expect(boardKey(key('Delete'), board())).toBeNull()
    // ⌘⌫ is the menu's.
    expect(boardKey(key('Backspace', meta), board(['a']))).toBeNull()
  })

  test('⌥⌘G, ⌥⌘D and ⇧⌘E act on the selection; ⌘D is left to the menu', () => {
    const selected = board(['a', 'b'])
    expect(boardKey(key('g', { ...meta, altKey: true }), selected)).toEqual({
      type: 'addSection',
      ids: ['a', 'b'],
    })
    expect(boardKey(key('d', { ...meta, altKey: true }), selected)).toEqual({
      type: 'duplicate',
      ids: ['a', 'b'],
    })
    expect(boardKey(key('e', { ...meta, shiftKey: true }), selected)).toEqual({
      type: 'export',
      ids: ['a', 'b'],
    })
    expect(boardKey(key('d', meta), selected)).toBeNull()
    expect(boardKey(key('g', { ...meta, altKey: true }), board())).toBeNull()
  })

  test('⌘A selects every frame; Esc nothing', () => {
    expect(boardKey(key('a', meta), board())).toEqual({
      type: 'pick',
      ids: ['a', 'b', 'c'],
      section: null,
    })
    expect(boardKey(key('Escape'), board(['a']))).toEqual({ type: 'pick', ids: [], section: null })
    expect(boardKey(key('Escape'), board())).toBeNull()
  })

  test('⌘0 fits, ⌘= and ⌘− zoom a step', () => {
    expect(boardKey(key('0', meta), board())).toEqual({ type: 'fit' })
    expect(boardKey(key('=', meta), board())).toEqual({ type: 'zoom', factor: ZOOM_STEP })
    expect(boardKey(key('+', meta), board())).toEqual({ type: 'zoom', factor: ZOOM_STEP })
    expect(boardKey(key('-', meta), board())).toEqual({ type: 'zoom', factor: 1 / ZOOM_STEP })
  })

  test('H and V pick the tool, by the key where they are on any layout', () => {
    expect(boardKey(key('h'), board())).toEqual({ type: 'tool', tool: 'hand' })
    expect(boardKey(key('v'), board())).toEqual({ type: 'tool', tool: 'move' })
    expect(boardKey(key('й', { code: 'KeyH' }), board())).toEqual({ type: 'tool', tool: 'hand' })
    expect(boardKey(key('h', meta), board())).toBeNull()
  })

  test('Enter opens the one frame selected', () => {
    expect(boardKey(key('Enter'), board(['a']))).toEqual({ type: 'open', id: 'a' })
    expect(boardKey(key('Enter'), board(['a', 'b']))).toBeNull()
  })

  test('F2 renames, and ⇧F10 or the menu key opens the menu, of the section or the frame', () => {
    expect(boardKey(key('F2'), board(['a']))).toEqual({ type: 'nameFrame', id: 'a' })
    expect(boardKey(key('F2'), board(['b', 'c'], true))).toEqual({ type: 'nameSection', id: 's' })
    expect(boardKey(key('F2'), board(['a', 'b']))).toBeNull()
    expect(boardKey(key('F10', { shiftKey: true }), board(['a']))).toEqual({
      type: 'menu',
      of: 'frame',
      id: 'a',
      area: frames[0],
    })
    expect(boardKey(key('ContextMenu'), board(['b', 'c'], true))).toEqual({
      type: 'menu',
      of: 'section',
      id: 's',
      // Around its frames, with room above for its name.
      area: expect.objectContaining({ x: expect.any(Number), width: expect.any(Number) }),
    })
  })

  test('Tab steps through each section before its frames, then the rest; past the end, it goes on', () => {
    const step = (selection: string[], picked = false, back = false) =>
      boardKey(key('Tab', { shiftKey: back }), board(selection, picked))
    expect(step([])).toEqual({ type: 'step', ids: ['a'], section: null, reveal: frames[0] })
    expect(step(['a'])).toMatchObject({ type: 'step', ids: ['b', 'c'], section: 's' })
    expect(step(['b', 'c'], true)).toMatchObject({ ids: ['b'], section: null })
    expect(step(['b'])).toMatchObject({ ids: ['c'] })
    expect(step(['c'])).toBeNull()
    expect(step([], false, true)).toMatchObject({ ids: ['c'] })
    expect(step(['b'], false, true)).toMatchObject({ ids: ['b', 'c'], section: 's' })
    expect(step(['a'], false, true)).toBeNull()
  })

  test('arrows nudge the selection by 1, or 10 with ⇧', () => {
    expect(boardKey(key('ArrowLeft'), board(['a']))).toEqual({
      type: 'nudge',
      ids: ['a'],
      dx: -1,
      dy: 0,
    })
    expect(boardKey(key('ArrowDown', { shiftKey: true }), board(['a']))).toMatchObject({
      dx: 0,
      dy: 10,
    })
    expect(boardKey(key('ArrowLeft'), board())).toBeNull()
    expect(boardKey(key('ArrowLeft', { altKey: true }), board(['a']))).toBeNull()
  })

  test('other keys are not the board’s', () => {
    expect(boardKey(key('x'), board(['a']))).toBeNull()
    expect(boardKey(key('s', meta), board(['a']))).toBeNull()
  })
})

describe('a nudge', () => {
  test('presses add up, and the frames are drawn where they have gone', () => {
    const first = nudged(null, { ids: ['a', 'b'], dx: 1, dy: 0 }, frames)
    expect(first.land).toBe(false)
    const second = nudged(first.nudge, { ids: ['a', 'b'], dx: 0, dy: 10 }, frames)
    expect(second.nudge).toEqual({ ids: ['a', 'b'], dx: 1, dy: 10 })
    expect(second.overrides).toEqual({ a: { x: 1, y: 10 }, b: { x: 201, y: 10 } })
    expect(nudgeLanding(second.nudge, frames)).toEqual([
      { id: 'a', x: 1, y: 10 },
      { id: 'b', x: 201, y: 10 },
    ])
  })

  test('a nudge of other frames lands before a new one starts', () => {
    const held = { ids: ['a'], dx: 5, dy: 0 }
    const next = nudged(held, { ids: ['b'], dx: 1, dy: 0 }, frames)
    expect(next.land).toBe(true)
    expect(next.nudge).toEqual({ ids: ['b'], dx: 1, dy: 0 })
  })

  test('back where it began, nothing lands', () => {
    expect(nudgeLanding({ ids: ['a'], dx: 0, dy: 0 }, frames)).toBeNull()
  })
})
