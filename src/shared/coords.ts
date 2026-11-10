/**
 * Distinct coordinate spaces. Mixing them is a type error: for the preview, page (document)
 * CSS pixels, viewport CSS pixels, and the preview view's scaled pixels are not
 * interchangeable; nor, for the canvas board, are board and board-view pixels (below).
 */

declare const pagePx: unique symbol
declare const viewportPx: unique symbol
declare const viewPx: unique symbol

export interface PagePoint {
  readonly x: number
  readonly y: number
  readonly [pagePx]: never
}

export interface ViewportPoint {
  readonly x: number
  readonly y: number
  readonly [viewportPx]: never
}

/** Overlay / preview view pixels: page CSS pixels times the device-frame or zoom scale. */
export interface ViewPoint {
  readonly x: number
  readonly y: number
  readonly [viewPx]: never
}

export interface PageRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly [pagePx]: never
}

export interface ViewportRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly [viewportPx]: never
}

export interface ViewRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly [viewPx]: never
}

export const pagePoint = (x: number, y: number) => ({ x, y }) as PagePoint
export const viewportPoint = (x: number, y: number) => ({ x, y }) as ViewportPoint
export const viewPoint = (x: number, y: number) => ({ x, y }) as ViewPoint

export const pageRect = (x: number, y: number, width: number, height: number) =>
  ({ x, y, width, height }) as PageRect
export const viewportRect = (x: number, y: number, width: number, height: number) =>
  ({ x, y, width, height }) as ViewportRect
export const viewRect = (x: number, y: number, width: number, height: number) =>
  ({ x, y, width, height }) as ViewRect

/** Protocol / IPC numbers as a viewport point (CSS pixels in the visible page). */
export const viewportPointFrom = (point: { x: number; y: number }) =>
  viewportPoint(point.x, point.y)
export const viewportRectFrom = (rect: { x: number; y: number; width: number; height: number }) =>
  viewportRect(rect.x, rect.y, rect.width, rect.height)
export const viewPointFrom = (point: { x: number; y: number }) => viewPoint(point.x, point.y)
export const viewRectFrom = (rect: { x: number; y: number; width: number; height: number }) =>
  viewRect(rect.x, rect.y, rect.width, rect.height)
export const pageRectFrom = (rect: { x: number; y: number; width: number; height: number }) =>
  pageRect(rect.x, rect.y, rect.width, rect.height)

/** Document coordinates: viewport plus how far the page is scrolled. */
export function pageFromViewport(point: ViewportPoint, scroll: PagePoint): PagePoint {
  return pagePoint(point.x + scroll.x, point.y + scroll.y)
}

export function viewportFromPage(point: PagePoint, scroll: PagePoint): ViewportPoint {
  return viewportPoint(point.x - scroll.x, point.y - scroll.y)
}

export function pageRectFromViewport(rect: ViewportRect, scroll: PagePoint): PageRect {
  return pageRect(rect.x + scroll.x, rect.y + scroll.y, rect.width, rect.height)
}

export function viewportRectFromPage(rect: PageRect, scroll: PagePoint): ViewportRect {
  return viewportRect(rect.x - scroll.x, rect.y - scroll.y, rect.width, rect.height)
}

export function viewFromViewport(point: ViewportPoint, scale: number): ViewPoint {
  return viewPoint(point.x * scale, point.y * scale)
}

export function viewportFromView(point: ViewPoint, scale: number): ViewportPoint {
  return viewportPoint(point.x / scale, point.y / scale)
}

export function viewRectFromViewport(rect: ViewportRect, scale: number): ViewRect {
  return viewRect(rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale)
}

export function viewportRectFromView(rect: ViewRect, scale: number): ViewportRect {
  return viewportRect(rect.x / scale, rect.y / scale, rect.width / scale, rect.height / scale)
}

/*
 * The canvas board has two spaces of its own. Board pixels are where frames are kept
 * (`BoardFrameLayout`); board-view pixels are the board element's CSS pixels, from its
 * top-left corner, which the camera maps board pixels to. Device pixels are never a rect in
 * script: whatever draws the board is given board-view rects and the display's scale.
 */

declare const boardPx: unique symbol
declare const boardViewPx: unique symbol

export interface BoardPoint {
  readonly x: number
  readonly y: number
  readonly [boardPx]: never
}

export interface BoardRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly [boardPx]: never
}

export interface BoardViewPoint {
  readonly x: number
  readonly y: number
  readonly [boardViewPx]: never
}

export interface BoardViewRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly [boardViewPx]: never
}

export const boardPoint = (x: number, y: number) => ({ x, y }) as BoardPoint
export const boardRect = (x: number, y: number, width: number, height: number) =>
  ({ x, y, width, height }) as BoardRect
export const boardViewPoint = (x: number, y: number) => ({ x, y }) as BoardViewPoint
export const boardViewRect = (x: number, y: number, width: number, height: number) =>
  ({ x, y, width, height }) as BoardViewRect

/** A frame's or a section's place, as the manifest keeps it. */
export const boardRectFrom = (rect: { x: number; y: number; width: number; height: number }) =>
  boardRect(rect.x, rect.y, rect.width, rect.height)

/** Where the board looks: the board point at the view's top-left corner, and its zoom. */
interface BoardCameraLike {
  readonly x: number
  readonly y: number
  readonly zoom: number
}

export function boardViewFromBoard(point: BoardPoint, camera: BoardCameraLike): BoardViewPoint {
  return boardViewPoint((point.x - camera.x) * camera.zoom, (point.y - camera.y) * camera.zoom)
}

export function boardFromBoardView(point: BoardViewPoint, camera: BoardCameraLike): BoardPoint {
  return boardPoint(point.x / camera.zoom + camera.x, point.y / camera.zoom + camera.y)
}

export function boardViewRectFromBoard(rect: BoardRect, camera: BoardCameraLike): BoardViewRect {
  return boardViewRect(
    (rect.x - camera.x) * camera.zoom,
    (rect.y - camera.y) * camera.zoom,
    rect.width * camera.zoom,
    rect.height * camera.zoom,
  )
}

export function boardRectFromBoardView(rect: BoardViewRect, camera: BoardCameraLike): BoardRect {
  return boardRect(
    rect.x / camera.zoom + camera.x,
    rect.y / camera.zoom + camera.y,
    rect.width / camera.zoom,
    rect.height / camera.zoom,
  )
}
