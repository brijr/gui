import { describe, expect, test } from 'bun:test'
import { FRAME_GAP, MAX_FRAMES } from '../src/shared/board'
import {
  assetRefs,
  copiedFramesText,
  parseCopiedFrames,
  pastePlaces,
} from '../src/shared/board-clipboard'

// Canvas frames on the clipboard: Gui's own format, read back as untrusted, and where a paste puts them.

const frame = (id: string, x = 0, y = 0) => ({
  id,
  name: id,
  x,
  y,
  width: 100,
  height: 80,
  html: '<p>',
})

describe('frames on the clipboard', () => {
  test('what is copied reads back as it was', () => {
    const frames = [frame('a'), frame('b', 200)]
    expect(parseCopiedFrames(copiedFramesText('canvas1', frames))).toEqual({
      version: 1,
      canvas: 'canvas1',
      frames,
    })
  })

  test('anything else on the clipboard is not frames', () => {
    const text = (value: unknown) => parseCopiedFrames(JSON.stringify(value))
    expect(parseCopiedFrames('hello')).toBeNull()
    expect(text(null)).toBeNull()
    expect(text({ version: 2, canvas: 'c', frames: [frame('a')] })).toBeNull()
    expect(text({ version: 1, canvas: 'c', frames: [] })).toBeNull()
    expect(text({ version: 1, canvas: 'c', frames: [{ ...frame('a'), html: 3 }] })).toBeNull()
    expect(text({ version: 1, canvas: 'c', frames: [{ ...frame('a'), x: 'left' }] })).toBeNull()
    const many = Array.from({ length: MAX_FRAMES + 1 }, (_, i) => frame(`f${i}`))
    expect(text({ version: 1, canvas: 'c', frames: many })).toBeNull()
  })

  test('only the fields a frame has are kept', () => {
    const extra = { ...frame('a'), sneaky: true }
    const read = parseCopiedFrames(JSON.stringify({ version: 1, canvas: 'c', frames: [extra] }))
    expect(read?.frames[0]).toEqual(frame('a'))
  })
})

describe('where a paste goes', () => {
  test('together as they were copied, right of the frames they follow, clear of the rest', () => {
    const copied = [frame('a', 1000, 1000), frame('b', 1000, 1200)]
    const taken = [{ x: 0, y: 0, width: 400, height: 300 }]
    expect(pastePlaces(copied, taken, taken)).toEqual([
      { x: 400 + FRAME_GAP, y: 0 },
      { x: 400 + FRAME_GAP, y: 200 },
    ])
    // A frame in the way moves them further right.
    const blocked = [...taken, { x: 500, y: 0, width: 100, height: 100 }]
    expect(pastePlaces(copied, blocked, taken)[0]).toEqual({ x: 600 + FRAME_GAP, y: 0 })
    // An empty canvas: at its origin.
    expect(pastePlaces(copied, [], [])).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 200 },
    ])
  })
})

describe('the shared files a page uses', () => {
  test('each ../assets/ file once, decoded, and none outside assets/', () => {
    const html = `<img src="../assets/logo.png"><link href='../assets/brand/a%20b.css'>
      <div style="background:url(../assets/logo.png)"></div>
      <img src="../assets/../canvas.json"><img src="../assets/x/./y.png"><img src="../assets/%ZZ">
      <img src="assets/plain.png"><img src="../assets/q.png?v=2#top">`
    expect(assetRefs(html)).toEqual(['logo.png', 'brand/a b.css', 'q.png'])
  })
})
