import { expect, test } from 'bun:test'
import {
  buildScene,
  INK,
  QUAD,
  QUAD_STRIDE,
  QuadList,
  type SceneInput,
  thumbTier,
} from '../src/renderer/src/board-gl/scene'
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
  // A narrow frame's thumbnail is its own width at most.
  expect(thumbTier(390, 700)).toEqual({ width: 390, source: 'full', sourceWidth: 390 })
  expect(thumbTier(200, 700)).toEqual({ width: 200, source: 'small', sourceWidth: 200 })
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
