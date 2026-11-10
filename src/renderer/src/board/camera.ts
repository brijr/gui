import { type BoardCamera, clampZoom, fitCamera, ZOOM_MAX } from '../../../shared/board'
import {
  type BoardPoint,
  type BoardRect,
  type BoardViewPoint,
  type BoardViewRect,
  boardFromBoardView,
  boardPoint,
  boardRectFrom,
  boardRectFromBoardView,
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

/**
 * Everything in `bounds` shown within `area` of the view, with a margin, at most 100%; or up
 * to the board's closest zoom with `closeUp`, as zooming to the selection does in Figma.
 */
export function fitIn(bounds: BoardRect | null, area: BoardViewRect, closeUp = false): BoardCamera {
  const fitted = fitCamera(bounds, area, undefined, closeUp ? ZOOM_MAX : 1)
  // fitCamera fits a view whose corner is the board element's; this one's is `area`'s.
  return cameraAt(boardPoint(fitted.x, fitted.y), boardViewPoint(area.x, area.y), fitted.zoom)
}

/** At 100%, about `at`: what's under it stays under it. */
export function actualSize(camera: BoardCamera, at: BoardViewPoint): BoardCamera {
  return zoomAbout(camera, 1 / camera.zoom, at)
}

/** `rect` centred in `area` of the view, at `zoom`. */
export function centreIn(rect: BoardRect, area: BoardViewRect, zoom: number): BoardCamera {
  return cameraAt(
    boardPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
    boardViewPoint(area.x + area.width / 2, area.y + area.height / 2),
    zoom,
  )
}

/**
 * The Zoom tool's drag: what `box` (in board-view pixels) covers fills a view of `size`,
 * centred, within the board's zoom range, as Figma's Z-drag does.
 */
export function zoomToBox(
  camera: BoardCamera,
  box: BoardViewRect,
  size: { width: number; height: number },
): BoardCamera {
  // A box with no width (or height) is fitted by its other side.
  const scale = Math.min(size.width / box.width, size.height / box.height)
  const zoom = clampZoom(camera.zoom * scale)
  return centreIn(
    boardRectFromBoardView(box, camera),
    boardViewRect(0, 0, size.width, size.height),
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

/** The floating chat is framed around only when what it leaves clear is at least this wide. */
export const CLEAR_MIN_WIDTH = 320

/**
 * The part of a view of `size` the floating chat leaves clear, given where it covers the view
 * (`cover`, in board-view pixels): all of it unless the chat covers a good share of its
 * height, and leaves a wide enough side.
 */
export function clearArea(
  size: { width: number; height: number },
  cover: BoardViewRect | null,
): BoardViewRect {
  const all = boardViewRect(0, 0, size.width, size.height)
  if (!cover) return all
  const left = cover.x
  const right = left + cover.width
  const top = Math.max(0, cover.y)
  const bottom = Math.min(size.height, cover.y + cover.height)
  if (right <= 0 || left >= size.width || bottom - top < size.height / 3) return all
  const before = Math.max(0, left)
  const after = Math.max(0, size.width - right)
  if (Math.max(before, after) < CLEAR_MIN_WIDTH) return all
  return after > before
    ? boardViewRect(size.width - after, 0, after, size.height)
    : boardViewRect(0, 0, before, size.height)
}

/**
 * Where a menu opened from the keyboard goes, in the window: at `area`'s top-left corner as
 * `camera` draws it, kept on the board, whose element is at `box` in the window.
 */
export function menuPoint(
  area: { x: number; y: number; width: number; height: number },
  camera: BoardCamera,
  box: { left: number; top: number; width: number; height: number },
) {
  const { x, y } = boardViewRectFromBoard(boardRectFrom(area), camera)
  return {
    x: box.left + Math.min(Math.max(x, 0), box.width),
    y: box.top + Math.min(Math.max(y, 0), box.height),
  }
}

/** A pinch's ⌃-wheel deltas are small; a mouse wheel's are ~100 a notch. One notch, one step. */
export const PINCH_DELTA_MAX = 22

/**
 * Where a wheel event at `at` takes the camera: scrolling pans; ⌘ or a pinch (which arrives as
 * ⌃-wheel) zooms around the pointer.
 */
export function wheelBy(
  camera: BoardCamera,
  wheel: { deltaX: number; deltaY: number; ctrlKey: boolean; metaKey: boolean },
  at: BoardViewPoint,
): BoardCamera {
  if (!wheel.ctrlKey && !wheel.metaKey)
    return scrollBy(camera, boardViewPoint(wheel.deltaX, wheel.deltaY))
  // A mouse wheel with ⌃ held turns in big notches: each is one step, as ⌘+ is.
  const delta = wheel.ctrlKey
    ? Math.max(-PINCH_DELTA_MAX, Math.min(PINCH_DELTA_MAX, wheel.deltaY))
    : wheel.deltaY
  return zoomAbout(camera, Math.exp(-delta * (wheel.ctrlKey ? 0.01 : 0.002)), at)
}
