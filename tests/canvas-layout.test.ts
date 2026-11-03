import { expect, test } from 'bun:test'
import { mergeLayout, nextFrameName, sameLayout } from '../src/main/canvas-layout'
import type { BoardFrameLayout, BoardManifest } from '../src/shared/board'

const frame = (id: string, x: number, more: Partial<BoardFrameLayout> = {}): BoardFrameLayout => ({
  id,
  name: id,
  x,
  y: 0,
  width: 1440,
  height: 900,
  ...more,
})

const manifest = (
  frames: BoardFrameLayout[],
  more: Partial<BoardManifest> = {},
): BoardManifest => ({
  version: 1,
  name: 'Canvas',
  createdAt: 1,
  frames,
  sections: [],
  camera: null,
  ...more,
})

test('undoing a turn takes back its moves and frames, and keeps the user’s later ones', () => {
  // Before the turn: a and b. The turn moved a, made c and deleted d.
  const before = manifest([frame('a', 0), frame('b', 2000), frame('d', 4000, { name: 'Kept' })])
  const after = manifest([frame('a', 9000), frame('b', 2000), frame('c', 6000)])
  // Since: the user moved b, and added e. The board took in the pages the undo put back: c is
  // gone, d is back where the board placed it, named for its file.
  const now = manifest([frame('a', 9000), frame('b', 3000), frame('e', 8000), frame('d', 12000)], {
    camera: { x: 5, y: 6, zoom: 0.5 },
  })
  const merged = mergeLayout(now, after, before)
  expect(merged.frames).toEqual([
    frame('a', 0),
    frame('b', 3000),
    frame('e', 8000),
    frame('d', 4000, { name: 'Kept' }),
  ])
  expect(merged.camera).toEqual({ x: 5, y: 6, zoom: 0.5 })
})

test('a frame the user moved after the turn stays where they put it', () => {
  const before = manifest([frame('a', 0)])
  const after = manifest([frame('a', 9000, { width: 390 })])
  const now = manifest([frame('a', 500, { width: 390 })])
  // Its place is the user's; its size is still the turn's, which goes back.
  expect(mergeLayout(now, after, before).frames).toEqual([frame('a', 500)])
})

test('redo brings back frames the board placed anew where the turn had them', () => {
  const before = manifest([])
  const after = manifest([frame('a', 100, { name: 'Hero' })], {
    sections: [{ id: 'ideas', name: 'Ideas', frames: ['a'] }],
  })
  const now = manifest([frame('a', 0)])
  const merged = mergeLayout(now, before, after)
  expect(merged.frames).toEqual([frame('a', 100, { name: 'Hero' })])
  expect(merged.sections).toEqual([{ id: 'ideas', name: 'Ideas', frames: ['a'] }])
})

test('sections follow the same rule', () => {
  const before = manifest([frame('a', 0), frame('b', 2000)], {
    sections: [{ id: 's', name: 'One', frames: ['a'] }],
  })
  const after = manifest([frame('a', 0), frame('b', 2000)], {
    sections: [
      { id: 's', name: 'Two', frames: ['a', 'b'] },
      { id: 'new', name: 'New', frames: ['b'] },
    ],
  })
  const now = manifest([frame('a', 0), frame('b', 2000)], {
    sections: [
      { id: 's', name: 'Renamed by the user', frames: ['a', 'b'] },
      { id: 'new', name: 'New', frames: ['b'] },
    ],
  })
  expect(mergeLayout(now, after, before).sections).toEqual([
    { id: 's', name: 'Renamed by the user', frames: ['a'] },
  ])
})

test('the camera alone is no change to the layout', () => {
  const a = manifest([frame('a', 0)])
  expect(sameLayout(a, { ...a, camera: { x: 1, y: 2, zoom: 1 } })).toBe(true)
  expect(sameLayout(a, manifest([frame('a', 1)]))).toBe(false)
  expect(sameLayout(null, a)).toBe(false)
})

test('new frames take the next number past every one in use', () => {
  expect(nextFrameName('Desktop', [])).toBe('Desktop')
  expect(nextFrameName('Desktop', [{ name: 'Desktop' }])).toBe('Desktop 2')
  // Desktop, Desktop 2, Desktop 3, then 2 deleted: never Desktop 3 again.
  expect(nextFrameName('Desktop', [{ name: 'Desktop' }, { name: 'Desktop 3' }])).toBe('Desktop 4')
  expect(nextFrameName('Mobile', [{ name: 'Mobile copy' }, { name: 'Mobiles' }])).toBe('Mobile')
})
