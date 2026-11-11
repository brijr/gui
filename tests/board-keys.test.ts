import { describe, expect, test } from 'bun:test'
import {
  type BoardKey,
  boardKey,
  type HeldKey,
  heldKeys,
  type KeyBoard,
  NO_KEYS_HELD,
  nudged,
  nudgeLanding,
  pointerTool,
  selectionArea,
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
  rendering: false,
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

  test('+ and − zoom a step without ⌘ too, as in Figma', () => {
    expect(boardKey(key('='), board())).toEqual({ type: 'zoom', factor: ZOOM_STEP })
    expect(boardKey(key('+', { shiftKey: true }), board())).toEqual({
      type: 'zoom',
      factor: ZOOM_STEP,
    })
    expect(boardKey(key('-'), board())).toEqual({ type: 'zoom', factor: 1 / ZOOM_STEP })
    expect(boardKey(key('-', { altKey: true }), board())).toBeNull()
  })

  test('⇧0 is 100%, ⇧1 fits everything, ⇧2 the selection, by the key where it is', () => {
    const shift = (digit: string, selection: string[] = [], picked = false) =>
      boardKey(
        // ⇧ makes them ")", "!" and "@" on a US layout, and other things elsewhere.
        key('?', { code: `Digit${digit}`, shiftKey: true }),
        board(selection, picked),
      )
    expect(shift('0')).toEqual({ type: 'actualSize' })
    expect(shift('1')).toEqual({ type: 'fit' })
    expect(shift('2', ['a', 'b'])).toEqual({
      type: 'fitSelection',
      area: { x: 0, y: 0, width: 300, height: 80 },
    })
    // The section picked by its name: its area, with its name's room above.
    expect(shift('2', ['b', 'c'], true)).toMatchObject({
      type: 'fitSelection',
      area: { x: 200 - 64, width: 300 + 128 },
    })
    // Nothing selected: nothing, as in Figma.
    expect(shift('2')).toBeNull()
    // Without ⇧, or with ⌘, they aren't these.
    expect(boardKey(key('1', { code: 'Digit1' }), board())).toBeNull()
    expect(
      boardKey(key('2', { code: 'Digit2', shiftKey: true, metaKey: true }), board(['a'])),
    ).toBeNull()
  })

  test('the selection is drawn where it is mid-nudge', () => {
    const drawn = frames.map((f) => (f.id === 'a' ? { ...f, x: 10 } : f))
    expect(selectionArea({ ...board(['a']), drawn })).toEqual({
      x: 10,
      y: 0,
      width: 100,
      height: 80,
    })
    expect(selectionArea(board())).toBeNull()
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

  test('⌘C and ⌘X copy and cut the selection; ⌘V pastes, selected or not', () => {
    const selected = board(['a', 'b'])
    expect(boardKey(key('c', meta), selected)).toEqual({
      type: 'copy',
      ids: ['a', 'b'],
      cut: false,
    })
    expect(boardKey(key('x', meta), selected)).toEqual({ type: 'copy', ids: ['a', 'b'], cut: true })
    expect(boardKey(key('v', meta), board())).toEqual({ type: 'paste' })
    // A section picked by its name: its frames.
    expect(boardKey(key('c', meta), board(['b', 'c'], true))).toMatchObject({ ids: ['b', 'c'] })
    // Nothing selected, nothing to copy: the key goes on.
    expect(boardKey(key('c', meta), board())).toBeNull()
    expect(boardKey(key('x', meta), board())).toBeNull()
    // ⇧⌘C is Design Mode's; ⌥⇧⌘V the menu's.
    expect(boardKey(key('c', { ...meta, shiftKey: true }), selected)).toBeNull()
    expect(boardKey(key('v', { ...meta, shiftKey: true, altKey: true }), selected)).toBeNull()
    expect(boardKey(key('c'), selected)).toBeNull()
  })

  test('other keys are not the board’s', () => {
    expect(boardKey(key('x'), board(['a']))).toBeNull()
    expect(boardKey(key('s', meta), board(['a']))).toBeNull()
  })
})

describe('keys held: Space the Hand, Z the Zoom tool', () => {
  const press = (type: HeldKey['type'], code: string, extra: Partial<HeldKey> = {}): HeldKey => ({
    type,
    code,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...extra,
  })
  const down = (code: string, extra: Partial<HeldKey> = {}) => press('keydown', code, extra)
  const up = (code: string, extra: Partial<HeldKey> = {}) => press('keyup', code, extra)
  const run = (keys: HeldKey[], forBoard = true) =>
    keys.reduce((held, key) => heldKeys(held, key, forBoard), NO_KEYS_HELD)

  test('Z held is the Zoom tool, and letting go gives back the tool there was', () => {
    const held = run([down('KeyZ')])
    expect(held).toEqual({ space: false, zoom: true, alt: false })
    expect(pointerTool('move', held)).toBe('zoom')
    expect(pointerTool('hand', held)).toBe('zoom')
    const released = run([down('KeyZ'), up('KeyZ')])
    expect(pointerTool('move', released)).toBe('move')
    expect(pointerTool('hand', released)).toBe('hand')
  })

  test('⌥ held with it zooms out, pressed before Z or after', () => {
    expect(run([down('KeyZ'), down('AltLeft', { altKey: true })]).alt).toBe(true)
    expect(run([down('AltLeft', { altKey: true }), down('KeyZ', { altKey: true })])).toEqual({
      space: false,
      zoom: true,
      alt: true,
    })
    expect(run([down('KeyZ'), down('AltLeft', { altKey: true }), up('AltLeft')]).alt).toBe(false)
  })

  test('⌘Z and ⌃Z are not the Zoom tool, and ⌘ pressed while Z is held ends it', () => {
    expect(run([down('MetaLeft', { metaKey: true }), down('KeyZ', { metaKey: true })]).zoom).toBe(
      false,
    )
    expect(run([down('KeyZ', { ctrlKey: true })]).zoom).toBe(false)
    // macOS sends no key-up for Z while ⌘ is down.
    expect(run([down('KeyZ'), down('MetaLeft', { metaKey: true })]).zoom).toBe(false)
  })

  test('typed in a field, Space and Z do nothing here; they come up from anywhere', () => {
    expect(run([down('KeyZ'), down('Space')], false)).toBe(NO_KEYS_HELD)
    const held = run([down('KeyZ'), down('Space')])
    expect(heldKeys(held, up('KeyZ'), false).zoom).toBe(false)
    expect(heldKeys(held, up('Space'), false).space).toBe(false)
  })

  test('Space over Z: both held, a press pans', () => {
    const both = run([down('KeyZ'), down('Space')])
    expect(pointerTool('move', both)).toBe('hand')
    expect(pointerTool('move', heldKeys(both, up('Space'), true))).toBe('zoom')
  })

  test('nothing changed, the same keys back', () => {
    const held = run([down('KeyZ')])
    expect(heldKeys(held, down('KeyZ'), true)).toBe(held)
    expect(heldKeys(NO_KEYS_HELD, down('KeyX'), true)).toBe(NO_KEYS_HELD)
  })

  test('Z alone is no command of the board’s: a tap switches nothing', () => {
    expect(boardKey(key('z'), board(['a']))).toBeNull()
    expect(boardKey(key('z', meta), board(['a']))).toBeNull()
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
