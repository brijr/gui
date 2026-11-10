import { describe, expect, test } from 'bun:test'
import {
  CLEAR_MIN_WIDTH,
  cameraAt,
  centreIn,
  clearArea,
  dragFrom,
  dragOffset,
  fitIn,
  inMarquee,
  marqueeRect,
  menuPoint,
  PINCH_DELTA_MAX,
  scrollBy,
  shownShare,
  wheelBy,
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
  boardViewRectFromBoard,
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

describe('the wheel', () => {
  const wheel = (
    deltaX: number,
    deltaY: number,
    keys: { ctrlKey?: boolean; metaKey?: boolean },
  ) => ({
    deltaX,
    deltaY,
    ctrlKey: false,
    metaKey: false,
    ...keys,
  })
  const at = boardViewPoint(200, 100)

  test('scrolling pans, at the zoom there is', () => {
    expect(wheelBy(camera, wheel(10, -20, {}), at)).toEqual(
      scrollBy(camera, boardViewPoint(10, -20)),
    )
  })

  test('⌘-scroll zooms about the pointer', () => {
    const zoomed = wheelBy(camera, wheel(0, -100, { metaKey: true }), at)
    expect(zoomed.zoom).toBeCloseTo(camera.zoom * Math.exp(0.2))
    expect(boardFromBoardView(at, zoomed).x).toBeCloseTo(boardFromBoardView(at, camera).x)
  })

  test('a pinch (⌃-scroll) zooms faster, and a mouse notch with ⌃ is one step at most', () => {
    const pinch = wheelBy(camera, wheel(0, -10, { ctrlKey: true }), at)
    expect(pinch.zoom).toBeCloseTo(camera.zoom * Math.exp(0.1))
    const notch = wheelBy(camera, wheel(0, -100, { ctrlKey: true }), at)
    expect(notch.zoom).toBeCloseTo(camera.zoom * Math.exp(PINCH_DELTA_MAX * 0.01))
  })
})

describe('the area the floating chat leaves clear', () => {
  const size = { width: 1200, height: 800 }
  const all = boardViewRect(0, 0, 1200, 800)

  test('all of the board when there is no chat, or it covers little of its height', () => {
    expect(clearArea(size, null)).toEqual(all)
    expect(clearArea(size, boardViewRect(800, 700, 400, 100))).toEqual(all)
  })

  test('all of it when the chat is off the board, or leaves no side wide enough', () => {
    expect(clearArea(size, boardViewRect(1300, 0, 300, 800))).toEqual(all)
    const middle = boardViewRect(CLEAR_MIN_WIDTH - 10, 0, 1200 - 2 * (CLEAR_MIN_WIDTH - 10), 800)
    expect(clearArea(size, middle)).toEqual(all)
  })

  test('the wider side of the chat otherwise', () => {
    expect(clearArea(size, boardViewRect(800, 100, 400, 600))).toEqual(
      boardViewRect(0, 0, 800, 800),
    )
    expect(clearArea(size, boardViewRect(0, 0, 400, 800))).toEqual(boardViewRect(400, 0, 800, 800))
  })
})

describe('a menu opened from the keyboard', () => {
  const box = { left: 100, top: 50, width: 800, height: 600 }
  test("opens at the area's corner, kept on the board, in the window's pixels", () => {
    const area = { x: 200, y: 100, width: 100, height: 100 }
    const shown = boardViewRectFromBoard(boardRect(200, 100, 100, 100), camera)
    expect(menuPoint(area, camera, box)).toEqual({ x: 100 + shown.x, y: 50 + shown.y })
    expect(menuPoint({ ...area, x: -5000, y: 9000 }, camera, box)).toEqual({ x: 100, y: 650 })
  })
})
