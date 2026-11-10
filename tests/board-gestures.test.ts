import { describe, expect, test } from 'bun:test'
import {
  clickOn,
  contextMenu,
  DOUBLE_CLICK_MS,
  dragGesture,
  endGesture,
  type Gesture,
  type GestureBoard,
  ignoredPress,
  landed,
  type Press,
  pressGesture,
} from '../src/renderer/src/board/gestures'
import { ZOOM_STEP } from '../src/renderer/src/board/keys'
import { FRAME_MAX, FRAME_MIN } from '../src/shared/board'
import { boardFromBoardView, boardViewPoint } from '../src/shared/coords'
import type { BoardFrame } from '../src/shared/types'

// What a press, a drag and a release on the canvas board do, as plain functions.

const frame = (id: string, x: number, y = 0): BoardFrame => ({
  id,
  name: id,
  x,
  y,
  width: 100,
  height: 80,
  version: 1,
  captured: true,
})
const frames = [frame('a', 0), frame('b', 200), frame('c', 400)]
const board = (selection: string[] = [], drawn = frames): GestureBoard => ({
  frames,
  drawn,
  sections: [{ id: 's', name: 'Hero', frames: ['b', 'c'] }],
  selection,
})
/** 1:1, so board-view pixels are board pixels. */
const camera = { x: 0, y: 0, zoom: 1 }
/** The board's size on screen */
const view = { width: 800, height: 600 }
const at = boardViewPoint(10, 10)
const press = (target: Press['target'], extra: Partial<Press> = {}): Press => ({
  at,
  shiftKey: false,
  pan: false,
  zoom: false,
  altKey: false,
  target,
  ...extra,
})

describe('a press on the board', () => {
  test('a right-click, or a ⌃-click on a Mac, starts nothing', () => {
    expect(ignoredPress(2, false, false)).toBe(true)
    expect(ignoredPress(0, true, true)).toBe(true)
    expect(ignoredPress(0, true, false)).toBe(false)
    expect(ignoredPress(0, false, true)).toBe(false)
    expect(ignoredPress(1, false, true)).toBe(false)
  })

  test('with the Hand, Space or the middle button it pans from the camera there is', () => {
    const started = pressGesture(press({ frame: 'a' }, { pan: true }), board(), camera)
    expect(started).toEqual({ gesture: { kind: 'pan', start: at, from: camera }, select: null })
  })

  test("a section's name picks the section and drags all its frames", () => {
    const started = pressGesture(press({ section: 's', frame: 'b' }), board(['a']), camera)
    expect(started.select).toEqual({ ids: ['b', 'c'], section: 's' })
    expect(started.gesture).toMatchObject({
      kind: 'move',
      ids: ['b', 'c'],
      hit: null,
      section: 's',
    })
  })

  test('the handle resizes the frame as drawn, and a handle with no frame starts nothing', () => {
    const drawn = [frame('a', 30), frame('b', 200), frame('c', 400)]
    const started = pressGesture(press({ resize: 'a', frame: 'a' }), board(['a'], drawn), camera)
    expect(started).toEqual({
      gesture: { kind: 'resize', start: at, id: 'a', from: drawn[0] },
      select: null,
    })
    const gone = pressGesture(press({ resize: 'z', frame: 'a' }), board(['a']), camera)
    expect(gone).toEqual({ gesture: null, select: null })
  })

  test('a frame not selected is selected alone, or added to the selection with ⇧', () => {
    const alone = pressGesture(press({ frame: 'b' }), board(['a']), camera)
    expect(alone.select).toEqual({ ids: ['b'], section: null })
    expect(alone.gesture).toMatchObject({ ids: ['b'], hit: 'b', narrow: false, toggle: null })
    const added = pressGesture(press({ frame: 'b' }, { shiftKey: true }), board(['a']), camera)
    expect(added.select).toEqual({ ids: ['a', 'b'], section: null })
  })

  test('one of several selected drags them all, and a click on it narrows to it', () => {
    const selection = ['a', 'b']
    const started = pressGesture(press({ frame: 'b' }), board(selection), camera)
    expect(started.select).toBeNull()
    expect(started.gesture).toMatchObject({ ids: selection, hit: 'b', narrow: true })
  })

  test('⇧ on a selected frame deselects it on release, not at once', () => {
    const started = pressGesture(press({ frame: 'a' }, { shiftKey: true }), board(['a']), camera)
    expect(started.select).toBeNull()
    expect(started.gesture).toMatchObject({ toggle: 'a', narrow: false })
  })

  test('empty board starts a marquee, which adds to the selection with ⇧', () => {
    expect(pressGesture(press({}), board(['a']), camera).gesture).toEqual({
      kind: 'marquee',
      start: at,
      now: at,
      add: [],
    })
    const shifted = pressGesture(press({}, { shiftKey: true }), board(['a']), camera)
    expect(shifted.gesture).toMatchObject({ add: ['a'] })
  })
})

describe('a drag', () => {
  const move: Gesture = {
    kind: 'move',
    start: boardViewPoint(0, 0),
    ids: ['a', 'b'],
    hit: 'a',
    narrow: false,
    moved: false,
    toggle: null,
  }

  test('a frame moves only once the pointer has gone past the slop, then by whole pixels', () => {
    expect(dragGesture(move, boardViewPoint(2, 2), camera, frames)).toEqual({})
    const drag = dragGesture(move, boardViewPoint(10.4, 5.6), camera, frames)
    expect(drag.gesture).toMatchObject({ moved: true })
    expect(drag.overrides).toEqual({ a: { x: 10, y: 6 }, b: { x: 210, y: 6 } })
    // Once moving, it keeps following even back inside the slop.
    const back = dragGesture({ ...move, moved: true }, boardViewPoint(1, 0), camera, frames)
    expect(back.gesture).toBeUndefined()
    expect(back.overrides).toEqual({ a: { x: 1, y: 0 }, b: { x: 201, y: 0 } })
  })

  test('a drag moves board pixels at the zoom there is', () => {
    const half = { x: 0, y: 0, zoom: 0.5 }
    const drag = dragGesture(move, boardViewPoint(10, 0), half, frames)
    expect(drag.overrides?.a).toEqual({ x: 20, y: 0 })
  })

  test('a resize changes the size alone, within the frame limits', () => {
    const resize: Gesture = { kind: 'resize', start: at, id: 'a', from: frames[0] }
    expect(dragGesture(resize, boardViewPoint(60, 90), camera, frames)).toEqual({
      overrides: { a: { width: 150, height: 160 } },
    })
    const tiny = dragGesture(resize, boardViewPoint(-500, -500), camera, frames)
    expect(tiny.overrides?.a).toEqual({ width: FRAME_MIN, height: FRAME_MIN })
    const huge = dragGesture(resize, boardViewPoint(9000, 9000), camera, frames)
    expect(huge.overrides?.a).toEqual({ width: FRAME_MAX, height: FRAME_MAX })
  })

  test('a pan moves the camera with the pointer; a marquee follows it', () => {
    const pan: Gesture = { kind: 'pan', start: at, from: camera }
    expect(dragGesture(pan, boardViewPoint(30, 10), camera, frames)).toEqual({
      camera: { x: -20, y: 0, zoom: 1 },
    })
    const marquee: Gesture = { kind: 'marquee', start: at, now: at, add: [] }
    expect(dragGesture(marquee, boardViewPoint(50, 60), camera, frames).gesture).toMatchObject({
      now: { x: 50, y: 60 },
    })
  })
})

describe('a click', () => {
  test('a second click on the same thing within the double-click time is a double-click', () => {
    const first = clickOn(null, 'a', 1000)
    expect(first).toEqual({ twice: false, last: { id: 'a', at: 1000 } })
    expect(clickOn(first.last, 'a', 1000 + DOUBLE_CLICK_MS - 1)).toEqual({
      twice: true,
      last: null,
    })
    expect(clickOn(first.last, 'a', 1000 + DOUBLE_CLICK_MS).twice).toBe(false)
    expect(clickOn(first.last, 'b', 1001).twice).toBe(false)
  })
})

describe('the release', () => {
  const move = (extra: Partial<Extract<Gesture, { kind: 'move' }>>): Gesture => ({
    kind: 'move',
    start: at,
    ids: ['a'],
    hit: 'a',
    narrow: false,
    moved: false,
    toggle: null,
    ...extra,
  })
  const end = (done: Gesture, overrides = {}, last: { id: string; at: number } | null = null) =>
    endGesture(done, board(['a', 'b']), overrides, camera, view, last, 5000)

  test('frames dragged land as one arrangement of where they are', () => {
    expect(end(move({ moved: true, ids: ['a', 'b'] }), { a: { x: 7, y: 8 } })).toEqual({
      clear: false,
      intents: [{ type: 'arrange', frames: [{ id: 'a', x: 7, y: 8 }] }],
    })
  })

  test('a drag back to where it began lands nothing, and clears what was drawn', () => {
    expect(end(move({ moved: true }), { a: { x: 0, y: 0 } })).toEqual({ clear: true, intents: [] })
    expect(landed(['a'], frames, { a: { x: 0, y: 0 }, b: { x: 3 } })).toEqual([])
    expect(landed(['b'], frames, { b: { x: 3 } })).toEqual([{ ...frames[1], x: 3 }])
  })

  test('a ⇧-click on a selected frame deselects it', () => {
    expect(end(move({ toggle: 'a' })).select).toEqual({ ids: ['b'], section: null })
  })

  test('a click on one of several narrows to it; a second opens it', () => {
    const first = end(move({ narrow: true }))
    expect(first).toEqual({
      select: { ids: ['a'], section: null },
      intents: [],
      click: { id: 'a', at: 5000 },
    })
    const second = end(move({}), {}, { id: 'a', at: 4800 })
    expect(second.intents).toEqual([{ type: 'open', id: 'a' }])
    expect(second.click).toBeNull()
  })

  test("a second click on a section's name renames it", () => {
    const named = move({ hit: null, section: 's' })
    expect(end(named).renameSection).toBeUndefined()
    expect(end(named, {}, { id: 'section:s', at: 4900 }).renameSection).toBe('s')
    // A frame's click doesn't count toward its section's double-click.
    expect(end(named, {}, { id: 's', at: 4900 }).renameSection).toBeUndefined()
  })

  test('a resize sends the size alone', () => {
    const resize: Gesture = { kind: 'resize', start: at, id: 'a', from: frames[0] }
    expect(end(resize, { a: { width: 150, height: 80 } })).toEqual({
      intents: [{ type: 'arrange', frames: [{ id: 'a', width: 150, height: 80 }] }],
    })
    expect(end(resize, { a: { width: 100, height: 80 } })).toEqual({ clear: true, intents: [] })
  })

  test('a pan leaves the camera where it is', () => {
    expect(end({ kind: 'pan', start: at, from: camera })).toEqual({ rest: true, intents: [] })
  })

  test('a marquee selects what it touches as drawn; a click on empty board deselects', () => {
    const marquee = (now: { x: number; y: number }, add: string[] = []): Gesture => ({
      kind: 'marquee',
      start: boardViewPoint(-10, -10),
      now: boardViewPoint(now.x, now.y),
      add,
    })
    expect(end(marquee({ x: 250, y: 10 })).select).toEqual({ ids: ['a', 'b'], section: null })
    expect(end(marquee({ x: 250, y: 10 }, ['c'])).select).toEqual({
      ids: ['c', 'a', 'b'],
      section: null,
    })
    // Smaller than the slop both ways: a click.
    expect(end(marquee({ x: -8, y: -8 })).select).toEqual({ ids: [], section: null })
    // With ⇧, a click keeps the selection.
    expect(end(marquee({ x: -8, y: -8 }, ['a'])).select).toBeUndefined()
    // As drawn: a frame dragged ahead of main is caught where it shows.
    const drawn = [frame('a', 600), frames[1], frames[2]]
    const ending = endGesture(
      marquee({ x: 50, y: 10 }),
      board([], drawn),
      {},
      camera,
      view,
      null,
      0,
    )
    expect(ending.select).toEqual({ ids: [], section: null })
  })
})

describe('the Zoom tool (Z held)', () => {
  const zoom = (now: { x: number; y: number }, out = false): Gesture => ({
    kind: 'zoom',
    start: at,
    now: boardViewPoint(now.x, now.y),
    out,
  })
  const end = (done: Gesture) => endGesture(done, board(['a']), {}, camera, view, null, 0)

  test('a press anywhere starts it, on a frame or a name too, and selects nothing', () => {
    for (const target of [{}, { frame: 'a' }, { section: 's' }, { resize: 'a' }]) {
      expect(pressGesture(press(target, { zoom: true }), board(['b']), camera)).toEqual({
        gesture: { kind: 'zoom', start: at, now: at, out: false },
        select: null,
      })
    }
    // ⌥ held as it's pressed: it zooms out.
    const out = pressGesture(press({}, { zoom: true, altKey: true }), board(), camera)
    expect(out.gesture).toEqual({ kind: 'zoom', start: at, now: at, out: true })
    // Space held as well, or the middle button: it pans.
    expect(pressGesture(press({}, { zoom: true, pan: true }), board(), camera).gesture?.kind).toBe(
      'pan',
    )
  })

  test('a drag draws its box, and moves nothing', () => {
    expect(dragGesture(zoom(at), boardViewPoint(90, 70), camera, frames)).toEqual({
      gesture: zoom({ x: 90, y: 70 }),
    })
  })

  test('a click zooms one step in about the point, or out with ⌥', () => {
    const inward = end(zoom({ x: 11, y: 11 }))
    expect(inward).toEqual({ camera: expect.any(Object), intents: [] })
    expect(inward.camera?.zoom).toBeCloseTo(ZOOM_STEP)
    // What was under the click stays under it.
    expect(boardFromBoardView(at, inward.camera ?? camera)).toEqual(boardFromBoardView(at, camera))
    const outward = end(zoom({ x: 11, y: 11 }, true))
    expect(outward.camera?.zoom).toBeCloseTo(1 / ZOOM_STEP)
    expect(boardFromBoardView(at, outward.camera ?? camera).x).toBeCloseTo(at.x)
  })

  test('a drag zooms to fit its box, with ⌥ too', () => {
    // At 50%, 10,10 to 410,210 is 400 × 200 on screen, into 800 × 600: 2× more, so 100%,
    // centred on what was at 210,110 (board 420,220).
    const half = { x: 0, y: 0, zoom: 0.5 }
    for (const out of [false, true]) {
      const ending = endGesture(zoom({ x: 410, y: 210 }, out), board(), {}, half, view, null, 0)
      expect(ending.camera?.zoom).toBeCloseTo(1)
      const centre = boardFromBoardView(boardViewPoint(400, 300), ending.camera ?? half)
      expect(centre.x).toBeCloseTo(420)
      expect(centre.y).toBeCloseTo(220)
    }
  })
})

describe('a right-click', () => {
  const sections = board().sections
  test("on a section's name picks it and opens its menu", () => {
    expect(contextMenu({ section: 's', frame: 'b' }, undefined, sections)).toEqual({
      select: { ids: ['b', 'c'], section: 's' },
      intent: { type: 'sectionMenu', id: 's' },
    })
  })
  test("on a frame or its name opens the frame's menu; elsewhere nothing", () => {
    expect(contextMenu({ frame: 'a' }, undefined, sections)).toEqual({
      intent: { type: 'frameMenu', id: 'a' },
    })
    expect(contextMenu({}, 'b', sections)).toEqual({ intent: { type: 'frameMenu', id: 'b' } })
    expect(contextMenu({}, undefined, sections)).toBeNull()
  })
})
