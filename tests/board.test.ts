import { expect, test } from 'bun:test'
import {
  boardBounds,
  cleanSections,
  exportPaths,
  FRAME_GAP,
  FRAME_MAX,
  FRAME_MIN,
  fitCamera,
  frameId,
  MAX_FRAMES,
  parseManifest,
  placeFrame,
  placeInSection,
  regroupSections,
  SECTION_PAD,
  SECTION_TOP,
  sectionBounds,
  ZOOM_MAX,
} from '../src/shared/board'

// BoardSession itself (file sync, the frame server, thumbnails) needs Electron; what's pure is
// how a canvas's manifest is read and where frames go on it.

test('a manifest round-trips as Gui writes it', () => {
  const manifest = parseManifest(
    JSON.stringify({
      version: 1,
      name: 'Pricing ideas',
      createdAt: 5,
      frames: [{ id: 'tiers', name: 'Three tiers', x: 10, y: 20, width: 1440, height: 900 }],
      camera: { x: -64, y: -64, zoom: 0.5 },
    }),
    'Untitled canvas',
  )
  expect(manifest).toEqual({
    version: 1,
    name: 'Pricing ideas',
    createdAt: 5,
    frames: [{ id: 'tiers', name: 'Three tiers', x: 10, y: 20, width: 1440, height: 900 }],
    sections: [],
    camera: { x: -64, y: -64, zoom: 0.5 },
  })
  expect(parseManifest(JSON.stringify(manifest), 'Other')).toEqual(manifest)
})

test('a corrupt or hand-edited manifest is repaired rather than failing the canvas', () => {
  expect(parseManifest('{not json', 'Fallback')).toMatchObject({ name: 'Fallback', frames: [] })
  expect(parseManifest(null, 'Fallback').frames).toEqual([])
  const manifest = parseManifest(
    JSON.stringify({
      name: '   ',
      frames: [
        { id: 'ok', name: '  Hero\n page ', x: 1.6, y: 'x', width: 10, height: 99999 },
        { id: 'ok', name: 'Duplicate id' },
        { id: '../escape', name: 'Path' },
        { id: 'UPPER', name: 'Bad id' },
        'not a frame',
      ],
      camera: { x: 0, y: 0, zoom: 50 },
    }),
    'Fallback',
  )
  expect(manifest.name).toBe('Fallback')
  expect(manifest.frames).toEqual([
    { id: 'ok', name: 'Hero page', x: 2, y: 0, width: FRAME_MIN, height: FRAME_MAX },
  ])
  expect(manifest.camera?.zoom).toBe(ZOOM_MAX)
  const many = Array.from({ length: MAX_FRAMES + 10 }, (_, i) => ({ id: `f${i}`, name: 'F' }))
  expect(parseManifest(JSON.stringify({ frames: many }), 'x').frames).toHaveLength(MAX_FRAMES)
})

test('new frames go right of what they follow and never overlap a frame', () => {
  const size = { width: 400, height: 300 }
  expect(placeFrame([], size)).toEqual({ x: 0, y: 0 })
  const a = { x: 0, y: 0, width: 400, height: 300 }
  const b = { x: 480, y: 0, width: 400, height: 300 }
  // Beside everything
  expect(placeFrame([a, b], size)).toEqual({ x: 880 + FRAME_GAP, y: 0 })
  // Beside `a`, where `b` already is: moved past it
  const spot = placeFrame([a, b], size, [a])
  expect(spot).toEqual({ x: 880 + FRAME_GAP, y: 0 })
  // Brute force: many frames of mixed sizes, each placed after a random one, never overlap.
  const frames: { x: number; y: number; width: number; height: number }[] = []
  let seed = 7
  const random = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  for (let i = 0; i < 40; i++) {
    const next = {
      width: 200 + Math.round(random() * 1200),
      height: 200 + Math.round(random() * 900),
    }
    const after = frames.length ? [frames[Math.floor(random() * frames.length)]] : []
    const placed = { ...placeFrame(frames, next, after), ...next }
    for (const other of frames) {
      const apart =
        placed.x >= other.x + other.width ||
        other.x >= placed.x + placed.width ||
        placed.y >= other.y + other.height ||
        other.y >= placed.y + placed.height
      expect(apart).toBe(true)
    }
    frames.push(placed)
  }
})

test('a frame joining a section never grows it onto the next one', () => {
  const size = { width: 400, height: 300 }
  // Section one holds `a`; section two starts right where a frame beside `a` would go.
  const a = { id: 'a', x: 0, y: 0, width: 400, height: 300 }
  const b = { id: 'b', x: 400 + FRAME_GAP + SECTION_PAD * 2, y: 0, width: 400, height: 300 }
  const frames = [a, b]
  const two = sectionBounds({ id: 'two', name: 'Two', frames: ['b'] }, frames)
  expect(two).not.toBeNull()
  const others = two ? [two] : []
  const spot = placeInSection(frames, others, [a], size, [a])
  // Not past section two (as placeFrame would jump), but a new row below `a`.
  expect(spot).toEqual({ x: 0, y: 300 + FRAME_GAP })
  const grown = sectionBounds({ id: 'one', name: 'One', frames: ['a', 'new'] }, [
    ...frames,
    { id: 'new', ...size, x: spot?.x ?? 0, y: spot?.y ?? 0 },
  ])
  const apart =
    !grown ||
    !two ||
    grown.x + grown.width <= two.x ||
    two.x + two.width <= grown.x ||
    grown.y + grown.height <= two.y ||
    two.y + two.height <= grown.y
  expect(apart).toBe(true)
  // Free beside it: right there.
  expect(placeInSection([a], [], [a], size, [a])).toEqual({ x: 400 + FRAME_GAP, y: 0 })
  // A loose frame in the new row: past it along the row reaches section two, so a row lower.
  const below = { id: 'c', x: 0, y: 300 + FRAME_GAP, width: 400, height: 300 }
  expect(placeInSection([a, b, below], others, [a], size, [a])).toEqual({
    x: 0,
    y: 300 + FRAME_GAP + 300 + FRAME_GAP,
  })
  // Hemmed in right and below by other sections: no spot in it.
  const under = { x: -1000, y: 300 + SECTION_PAD, width: 4000, height: 1000 }
  expect(placeInSection(frames, [...others, under], [a], size, [a])).toBeNull()
})

test('frame ids are readable, file-safe and unique', () => {
  expect(frameId('Pricing — Three Tiers!', new Set())).toBe('pricing-three-tiers')
  expect(frameId('Pricing', new Set(['pricing', 'pricing-2']))).toBe('pricing-3')
  expect(frameId('../../etc', new Set())).toBe('etc')
  expect(frameId('   ', new Set())).toBe('frame')
  expect(frameId('Café crème', new Set())).toBe('cafe-creme')
})

test('zoom to fit shows every frame, never past 100%', () => {
  const frames = [
    { x: 0, y: 0, width: 1440, height: 900 },
    { x: 1520, y: 0, width: 390, height: 844 },
  ]
  const area = boardBounds(frames)
  expect(area).toEqual({ x: 0, y: 0, width: 1910, height: 900 })
  const view = { width: 1000, height: 700 }
  const camera = fitCamera(area, view)
  expect(camera.zoom).toBeCloseTo((1000 - 128) / 1910)
  // The area's center is the view's center.
  expect(((area?.width ?? 0) / 2 - camera.x) * camera.zoom).toBeCloseTo(500)
  expect(fitCamera({ x: 0, y: 0, width: 100, height: 100 }, view).zoom).toBe(1)
})

const frame = (id: string, x: number, y = 0, name = id) => ({
  id,
  name,
  x,
  y,
  width: 400,
  height: 300,
})

test('sections keep only frames on the board, each in one section, and none empty', () => {
  const frames = [frame('a', 0), frame('b', 500)]
  expect(
    cleanSections(
      [
        { id: 'one', name: 'One', frames: ['a', 'gone'] },
        { id: 'two', name: 'Two', frames: ['a', 'b'] },
        { id: 'one', name: 'Again', frames: ['b'] },
        { id: 'empty', name: 'Empty', frames: ['gone'] },
      ],
      frames,
    ),
  ).toEqual([
    { id: 'one', name: 'One', frames: ['a'] },
    { id: 'two', name: 'Two', frames: ['b'] },
  ])
  const manifest = parseManifest(
    JSON.stringify({
      frames,
      sections: [{ id: 'ads', name: 'Ads', frames: ['a', 'missing'] }, { id: 'bad id!' }],
    }),
    'Canvas',
  )
  expect(manifest.sections).toEqual([{ id: 'ads', name: 'Ads', frames: ['a'] }])
})

test('a section is sized to its frames, with room for its name', () => {
  const frames = [frame('a', 0), frame('b', 500, 100)]
  expect(sectionBounds({ id: 's', name: 'S', frames: ['a', 'b'] }, frames)).toEqual({
    x: -SECTION_PAD,
    y: -SECTION_TOP,
    width: 900 + SECTION_PAD * 2,
    height: 400 + SECTION_TOP + SECTION_PAD,
  })
  expect(sectionBounds({ id: 's', name: 'S', frames: ['missing'] }, frames)).toBeNull()
})

test('a frame dropped on a section joins it, and one dragged out of its own leaves it', () => {
  const sections = [
    { id: 'left', name: 'Left', frames: ['a', 'b'] },
    { id: 'right', name: 'Right', frames: ['c'] },
  ]
  const start = [frame('a', 0), frame('b', 500), frame('c', 3000)]
  const at = (moves: Record<string, number>) =>
    start.map((f) => (moves[f.id] === undefined ? f : { ...f, x: moves[f.id] }))
  const drop = (moves: Record<string, number>, ids: string[]) =>
    regroupSections(sections, at(moves), ids, start)
  // b onto c's section
  expect(drop({ b: 3100 }, ['b'])).toEqual([
    { id: 'left', name: 'Left', frames: ['a'] },
    { id: 'right', name: 'Right', frames: ['c', 'b'] },
  ])
  // b out into empty board
  expect(drop({ b: 1600 }, ['b'])).toEqual([
    { id: 'left', name: 'Left', frames: ['a'] },
    { id: 'right', name: 'Right', frames: ['c'] },
  ])
  // b nudged within its own section
  expect(drop({ b: 300 }, ['b'])).toEqual(sections)
  // A section's only frame can't leave it: it carries the section along.
  expect(drop({ c: 6000 }, ['c'])).toEqual(sections)
  // The whole section dragged, even over another, keeps its frames.
  expect(drop({ a: 2900, b: 3400 }, ['a', 'b'])).toEqual(sections)
})

test('an export names files for their frames, in a folder per section when there are several', () => {
  const frames = [
    frame('a', 0, 0, 'Summer sale'),
    frame('b', 500, 0, 'Summer sale'),
    frame('c', 1000, 0, 'Story'),
    frame('d', 1500, 0, 'Loose'),
  ]
  const sections = [
    { id: 'feed', name: 'Feed ads', frames: ['a', 'b'] },
    { id: 'stories', name: 'Stories', frames: ['c'] },
  ]
  expect(exportPaths(['a', 'b'], frames, sections)).toEqual([
    { id: 'a', path: 'summer-sale.png' },
    { id: 'b', path: 'summer-sale-2.png' },
  ])
  expect(exportPaths(['a', 'b', 'c', 'd'], frames, sections)).toEqual([
    { id: 'a', path: 'feed-ads/summer-sale.png' },
    { id: 'b', path: 'feed-ads/summer-sale-2.png' },
    { id: 'c', path: 'stories/story.png' },
    { id: 'd', path: 'loose.png' },
  ])
})
