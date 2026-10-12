import { expect, test } from 'bun:test'
import {
  boardBounds,
  FRAME_GAP,
  FRAME_MAX,
  FRAME_MIN,
  fitCamera,
  frameId,
  MAX_FRAMES,
  parseManifest,
  placeFrame,
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
