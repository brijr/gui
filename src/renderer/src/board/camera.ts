import { type BoardCamera, clampZoom, fitCamera } from '../../../shared/board'
import {
  type BoardPoint,
  type BoardRect,
  type BoardViewPoint,
  type BoardViewRect,
  boardFromBoardView,
  boardPoint,
  boardViewPoint,
  boardViewRect,
  boardViewRectFromBoard,
} from '../../../shared/coords'

/*
 * Where the board looks, and how a gesture moves it. Plain functions of the camera: the
 * board's pointer and keys say where (in board-view pixels, the board element's own) and
 * these say what camera that makes. Every step between board and board-view pixels goes
 * through coords.ts.
 */

/** The camera at `zoom` that shows board point `point` at view point `at`. */
export function cameraAt(point: BoardPoint, at: BoardViewPoint, zoom: number): BoardCamera {
  // The board point at the view's top-left corner is `point`, less `at` in board pixels.
  const offset = boardFromBoardView(at, { x: 0, y: 0, zoom })
  return { x: point.x - offset.x, y: point.y - offset.y, zoom }
}

/** Zoomed by `factor` (within the board's range) around `at`: what's under it stays under it. */
export function zoomAbout(camera: BoardCamera, factor: number, at: BoardViewPoint): BoardCamera {
  return cameraAt(boardFromBoardView(at, camera), at, clampZoom(camera.zoom * factor))
}

/** Scrolled by `delta` board-view pixels (a wheel's), at the zoom there is. */
export function scrollBy(camera: BoardCamera, delta: BoardViewPoint): BoardCamera {
  return cameraAt(boardFromBoardView(delta, camera), boardViewPoint(0, 0), camera.zoom)
}

/** Dragged from `start` to `at`, from where the drag began: the board follows the pointer. */
export function dragFrom(from: BoardCamera, start: BoardViewPoint, at: BoardViewPoint) {
  return cameraAt(boardFromBoardView(start, from), at, from.zoom)
}

/** How far a drag from `start` to `at` has gone, in board pixels. */
export function dragOffset(start: BoardViewPoint, at: BoardViewPoint, camera: BoardCamera) {
  const from = boardFromBoardView(start, camera)
  const to = boardFromBoardView(at, camera)
  return { dx: to.x - from.x, dy: to.y - from.y }
}

/** Everything in `bounds` shown within `area` of the view, with a margin, at most 100%. */
export function fitIn(bounds: BoardRect | null, area: BoardViewRect): BoardCamera {
  const fitted = fitCamera(bounds, area)
  // fitCamera fits a view whose corner is the board element's; this one's is `area`'s.
  return cameraAt(boardPoint(fitted.x, fitted.y), boardViewPoint(area.x, area.y), fitted.zoom)
}

/** `rect` centred in `area` of the view, at `zoom`. */
export function centreIn(rect: BoardRect, area: BoardViewRect, zoom: number): BoardCamera {
  return cameraAt(
    boardPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
    boardViewPoint(area.x + area.width / 2, area.y + area.height / 2),
    zoom,
  )
}

/** How much of `rect` shows in `area`: 1 when all of it does, or when it fills the area. */
export function shownShare(rect: BoardViewRect, area: BoardViewRect) {
  const width = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x)
  const height = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y)
  if (width <= 0 || height <= 0) return 0
  const whole = Math.min(rect.width * rect.height, area.width * area.height)
  return whole > 0 ? (width * height) / whole : 0
}

/** The rectangle a marquee dragged from `a` to `b` covers. */
export function marqueeRect(a: BoardViewPoint, b: BoardViewPoint): BoardViewRect {
  return boardViewRect(
    Math.min(a.x, b.x),
    Math.min(a.y, b.y),
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
  )
}

/** Whether a marquee catches `rect` as the camera draws it: any overlap does. */
export function inMarquee(rect: BoardRect, marquee: BoardViewRect, camera: BoardCamera) {
  const drawn = boardViewRectFromBoard(rect, camera)
  return (
    drawn.x < marquee.x + marquee.width &&
    marquee.x < drawn.x + drawn.width &&
    drawn.y < marquee.y + marquee.height &&
    marquee.y < drawn.y + drawn.height
  )
}
