import { describe, expect, test } from 'bun:test'
import {
  cameraAt,
  centreIn,
  dragFrom,
  dragOffset,
  fitIn,
  inMarquee,
  marqueeRect,
  scrollBy,
  shownShare,
  zoomAbout,
} from '../src/renderer/src/board/camera'
import { fitCamera, ZOOM_MAX, ZOOM_MIN } from '../src/shared/board'
import {
  boardFromBoardView,
  boardPoint,
  boardRect,
  boardViewFromBoard,
  boardViewPoint,
  boardViewRect,
} from '../src/shared/coords'

// The canvas board's camera, as plain functions: where a pan, a zoom, a fit or a reveal leaves it.

const camera = { x: 100, y: 50, zoom: 0.5 }

describe('the board camera', () => {
  test('a camera can put any board point under any view point', () => {
    const made = cameraAt(boardPoint(500, 400), boardViewPoint(200, 100), 2)
    expect(made).toEqual({ x: 400, y: 350, zoom: 2 })
    expect(boardViewFromBoard(boardPoint(500, 400), made)).toEqual(boardViewPoint(200, 100))
  })

  test('zooming keeps the board point under the pointer where it is, within the zoom range', () => {
    const at = boardViewPoint(320, 180)
    const under = boardFromBoardView(at, camera)
    const zoomed = zoomAbout(camera, 1.25, at)
    expect(zoomed.zoom).toBe(0.625)
    const after = boardFromBoardView(at, zoomed)
    expect(after.x).toBeCloseTo(under.x, 9)
    expect(after.y).toBeCloseTo(under.y, 9)
    expect(zoomAbout(camera, 100, at).zoom).toBe(ZOOM_MAX)
    expect(zoomAbout(camera, 0.001, at).zoom).toBe(ZOOM_MIN)
  })

  test('a wheel scrolls by its delta on screen, more board the further out', () => {
    expect(scrollBy(camera, boardViewPoint(10, -20))).toEqual({ x: 120, y: 10, zoom: 0.5 })
    expect(scrollBy({ ...camera, zoom: 2 }, boardViewPoint(10, -20))).toEqual({
      x: 105,
      y: 40,
      zoom: 2,
    })
  })

  test('a drag pans so the board follows the pointer, and says how far it went on the board', () => {
    const start = boardViewPoint(100, 100)
    const at = boardViewPoint(160, 70)
    const panned = dragFrom(camera, start, at)
    expect(panned).toEqual({ x: -20, y: 110, zoom: 0.5 })
    expect(boardFromBoardView(at, panned)).toEqual(boardFromBoardView(start, camera))
    expect(dragOffset(start, at, camera)).toEqual({ dx: 120, dy: -60 })
  })

  test('fitting within part of the view is fitting the whole, moved to that part', () => {
    const bounds = boardRect(0, 0, 3000, 900)
    const whole = fitIn(bounds, boardViewRect(0, 0, 1200, 800))
    expect(whole).toEqual(fitCamera(bounds, { width: 1200, height: 800 }))
    const right = fitIn(bounds, boardViewRect(400, 0, 800, 800))
    const alone = fitCamera(bounds, { width: 800, height: 800 })
    expect(right.zoom).toBe(alone.zoom)
    // What the narrower view shows at its left edge shows at the area's left edge instead.
    expect(boardViewFromBoard(boardPoint(alone.x, alone.y), right)).toEqual(boardViewPoint(400, 0))
    // An empty board: the usual starting camera, in the area.
    expect(fitIn(null, boardViewRect(0, 0, 1200, 800))).toEqual({ x: -64, y: -64, zoom: 0.5 })
  })

  test('a frame revealed is centred in the area, at the zoom there is', () => {
    const area = boardViewRect(400, 0, 800, 800)
    const centred = centreIn(boardRect(1000, 1000, 1440, 900), area, 0.5)
    expect(centred.zoom).toBe(0.5)
    expect(boardViewFromBoard(boardPoint(1720, 1450), centred)).toEqual(boardViewPoint(800, 400))
  })

  test('how much of a rect shows in an area', () => {
    const area = boardViewRect(0, 0, 100, 100)
    expect(shownShare(boardViewRect(10, 10, 20, 20), area)).toBe(1)
    expect(shownShare(boardViewRect(90, 0, 20, 100), area)).toBe(0.5)
    expect(shownShare(boardViewRect(200, 0, 20, 20), area)).toBe(0)
    // Larger than the area and filling it: all there is room to show.
    expect(shownShare(boardViewRect(-50, -50, 200, 200), area)).toBe(1)
  })

  test('a marquee is the same box dragged either way, and catches what it touches', () => {
    expect(marqueeRect(boardViewPoint(50, 80), boardViewPoint(10, 20))).toEqual(
      boardViewRect(10, 20, 40, 60),
    )
    const marquee = boardViewRect(0, 0, 100, 100)
    // At (100, 50) and 0.5, board (300, 250) is drawn at view (100, 100).
    expect(inMarquee(boardRect(298, 248, 10, 10), marquee, camera)).toBe(true)
    expect(inMarquee(boardRect(300, 250, 10, 10), marquee, camera)).toBe(false)
  })
})
