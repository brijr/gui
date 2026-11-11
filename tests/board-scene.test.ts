import { expect, test } from 'bun:test'
import {
  activeFrame,
  buildScene,
  drawnSection,
  INK,
  LABEL_HEIGHT,
  overlayScene,
  QUAD,
  QUAD_STRIDE,
  QuadList,
  type SceneInput,
  SECTION_INSET,
  SECTION_LABEL_HEIGHT,
  sectionAreas,
  selectionSaid,
  thumbTier,
} from '../src/renderer/src/board/scene'
import { boardViewRect } from '../src/shared/coords'

// The WebGL board's scene is plain data: what it draws can be read without a GPU.

const frame = (id: string, x: number, y: number, captured = true) => ({
  id,
  x,
  y,
  width: 1440,
  height: 900,
  version: 1,
  captured,
})

const input = (over: Partial<SceneInput> = {}): SceneInput => ({
  frames: [frame('a', 0, 0), frame('b', 1540, 0)],
  sections: [],
  selected: new Set(),
  handle: null,
  hovered: null,
  marquee: null,
  ...over,
})

/** Each quad as [kind, fill, stroke, x, y, width, height]. */
function quads(list: QuadList) {
  return Array.from({ length: list.count }, (_, index) => {
    const at = index * QUAD_STRIDE
    const [x, y, width, height] = list.data.subarray(at, at + 4)
    return {
      kind: list.data[at + 7],
      fill: list.data[at + 8],
      stroke: list.data[at + 9],
      rect: [x, y, width, height],
    }
  })
}

test('a frame wants the smallest texture a little wider than it is drawn', () => {
  // 1.2 times as wide as drawn, from the small file while that holds enough.
  expect(thumbTier(1440, 260)).toEqual({ width: 360, source: 'small', sourceWidth: 360 })
  expect(thumbTier(1440, 300)).toEqual({ width: 360, source: 'small', sourceWidth: 360 })
  expect(thumbTier(1440, 301)).toEqual({ width: 512, source: 'full', sourceWidth: 1440 })
  expect(thumbTier(1440, 4000)).toEqual({ width: 1440, source: 'full', sourceWidth: 1440 })
  // Far out, less than the small file holds: resized as it's decoded.
  expect(thumbTier(1440, 60)).toEqual({ width: 90, source: 'small', sourceWidth: 360 })
  expect(thumbTier(1440, 144)).toEqual({ width: 180, source: 'small', sourceWidth: 360 })
  // A narrow frame's thumbnail is twice its width at most, for a Retina screen at 100%.
  expect(thumbTier(390, 700)).toEqual({ width: 780, source: 'full', sourceWidth: 780 })
  expect(thumbTier(390, 2000)).toEqual({ width: 780, source: 'full', sourceWidth: 780 })
  expect(thumbTier(1000, 2000)).toEqual({ width: 1440, source: 'full', sourceWidth: 1440 })
  expect(thumbTier(100, 700)).toEqual({ width: 200, source: 'small', sourceWidth: 200 })
})

test('only what reaches into the view is drawn, in paint order', () => {
  const list = new QuadList()
  const view = { width: 800, height: 600 }
  // Frame b starts at 1540 × 0.5 = 770: its first 30 pixels show.
  const both = buildScene(input(), { x: 0, y: 0, zoom: 0.5 }, view, 2, list)
  expect(both.grid).toEqual({ size: 12, x: -0, y: -0 })
  const drawn = quads(list)
  // Shadows first, then each frame over them.
  expect(drawn.map((quad) => quad.kind)).toEqual([QUAD.shadow, QUAD.shadow, QUAD.thumb, QUAD.thumb])
  expect(drawn[2].rect).toEqual([0, 0, 720, 450])
  expect(list.thumbs[2]).toMatchObject({ id: 'a', width: 1440, source: 'full' })

  // Panned right: frame a is out of view, and is not listed.
  buildScene(input(), { x: 1500, y: 0, zoom: 0.5 }, view, 2, list)
  expect(list.thumbs.filter(Boolean).map((want) => want?.id)).toEqual(['b'])
})

test('far out, the grid and the shadows go; a frame not yet captured has no thumbnail', () => {
  const list = new QuadList()
  const scene = buildScene(
    input({ frames: [frame('a', 0, 0, false)] }),
    { x: 0, y: 0, zoom: 0.05 },
    { width: 800, height: 600 },
    2,
    list,
  )
  expect(scene.grid).toBeNull()
  expect(quads(list).map((quad) => quad.kind)).toEqual([QUAD.flat])
  expect(list.thumbs.filter(Boolean)).toEqual([])
})

test('sections go under frames; selection, the handle and the marquee over them', () => {
  const list = new QuadList()
  buildScene(
    input({
      sections: [{ id: 's', area: { x: -64, y: -112, width: 1568, height: 1076 }, picked: true }],
      selected: new Set(['a']),
      handle: 'a',
      hovered: 'b',
      marquee: boardViewRect(10, 10, 100, 80),
    }),
    { x: 0, y: 0, zoom: 0.1 },
    { width: 800, height: 600 },
    2,
    list,
  )
  const drawn = quads(list)
  expect(drawn.map((quad) => [quad.fill, quad.stroke])).toEqual([
    [INK.section, INK.accent],
    [INK.raised, INK.line],
    // The frame under the pointer: its edge in the accent.
    [INK.raised, INK.accent],
    [INK.none, INK.accent],
    [INK.raised, INK.accent],
    [INK.accentSoft, INK.accent],
  ])
  // The handle: ten pixels on screen, centred on the frame's bottom-right corner.
  expect(drawn[4].rect).toEqual([139, 85, 10, 10])
})

const tile = (id: string, x: number, y: number, width = 400, height = 300) => ({
  id,
  name: `Frame ${id}`,
  x,
  y,
  width,
  height,
  version: 1,
  captured: true,
  rendering: false,
})

test('the DOM over the board mounts what is within half a view of it, and a name being edited', () => {
  const frames = [tile('near', 0, 0), tile('edge', 1400, 0), tile('far', 5000, 0)]
  const size = { width: 1000, height: 800 }
  const camera = { x: 0, y: 0, zoom: 1 }
  const ids = (frame: string | null = null) =>
    overlayScene(frames, [], camera, size, { frames: [frame], section: null }).shown.map(
      (f) => f.id,
    )
  expect(ids()).toEqual(['near', 'edge'])
  expect(ids('far')).toEqual(['near', 'edge', 'far'])
})

test('a name shows above its frame only where it has room, and its size only when wide enough', () => {
  const camera = { x: 0, y: 0, zoom: 1 }
  const size = { width: 1000, height: 800 }
  // `under` sits closer below `top` than a name is tall.
  const top = tile('top', 0, 0)
  const under = tile('under', 0, 300 + LABEL_HEIGHT - 1)
  const clear = tile('clear', 500, 0)
  const scene = overlayScene([top, under, clear], [], camera, size, { frames: [], section: null })
  expect(scene.named(top)).toBe(true)
  expect(scene.named(under)).toBe(false)
  expect(scene.named(clear)).toBe(true)
  expect(scene.sized(top)).toBe(true)
  const far = overlayScene([top], [], { ...camera, zoom: 0.25 }, size, {
    frames: [],
    section: null,
  })
  expect(far.sized(top)).toBe(false)
  // In a section, a name never covers the section's own.
  const section = { id: 's', name: 'Hero', frames: ['top'] }
  const inSection = overlayScene([top], [section], camera, size, { frames: [], section: null })
  expect(inSection.areas.map(({ section }) => section.id)).toEqual(['s'])
  expect(inSection.named(top)).toBe(true)
  // Zoomed out, the section's top grows on screen so both names still fit (at 19% and 28%)...
  for (const zoom of [0.19, 0.28]) {
    const out = overlayScene([top], [section], { ...camera, zoom }, size, {
      frames: [],
      section: null,
    })
    expect(out.named(top)).toBe(true)
    const head = (top.y - out.areas[0].area.y) * zoom
    expect(head).toBeGreaterThanOrEqual(SECTION_INSET + SECTION_LABEL_HEIGHT + LABEL_HEIGHT)
  }
  // ...up to a point: far out, the frame's name goes rather than the top reaching further.
  const tiny = overlayScene([top], [section], { ...camera, zoom: 0.06 }, size, {
    frames: [],
    section: null,
  })
  expect(tiny.named(top)).toBe(false)
  // At 50% and in, it's the section's own padding, in board pixels.
  expect(drawnSection({ x: 0, y: 0, width: 10, height: 10 }, 0.6)).toEqual({
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  })
})

test('the canvas gets each section around its frames, and which is picked', () => {
  const frames = [tile('a', 0, 0), tile('b', 500, 0)]
  const sections = [
    { id: 's', name: 'S', frames: ['a'] },
    { id: 't', name: 'T', frames: ['b'] },
    { id: 'gone', name: 'G', frames: ['z'] },
  ]
  const areas = sectionAreas(sections, frames, 't')
  expect(areas.map(({ id, picked }) => [id, picked])).toEqual([
    ['s', false],
    ['t', true],
  ])
})

test('a screen reader is told what is selected', () => {
  const frames = [tile('a', 0, 0), tile('b', 500, 0)]
  expect(selectionSaid([], frames, null)).toBe('')
  expect(selectionSaid(['a'], frames, null)).toBe('Frame a selected')
  expect(selectionSaid(['a', 'b'], frames, null)).toBe('2 frames selected')
  expect(selectionSaid(['a', 'b'], frames, { id: 's', name: 'Hero', frames: ['a', 'b'] })).toBe(
    'Hero selected',
  )
})

test('a screen reader is on the frame last selected, unless a section is picked', () => {
  const frames = [tile('a', 0, 0), tile('b', 500, 0)]
  expect(activeFrame([], frames, false)).toBeNull()
  expect(activeFrame(['a', 'b'], frames, false)).toBe('b')
  expect(activeFrame(['a', 'gone'], frames, false)).toBe('a')
  expect(activeFrame(['a', 'b'], frames, true)).toBeNull()
})
