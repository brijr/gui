import { describe, expect, test } from 'bun:test'
import {
  boardFromBoardView,
  boardPoint,
  boardRect,
  boardRectFromBoardView,
  boardViewFromBoard,
  boardViewPoint,
  boardViewRect,
  boardViewRectFromBoard,
  pageFromViewport,
  pagePoint,
  viewFromViewport,
  viewPoint,
  viewportFromPage,
  viewportFromView,
  viewportPoint,
  viewportRect,
  viewRect,
  viewRectFromViewport,
} from '../src/shared/coords'

describe('preview coordinate spaces', () => {
  test('page and viewport differ by scroll', () => {
    const view = viewportPoint(10, 20)
    const scroll = pagePoint(100, 200)
    const onPage = pageFromViewport(view, scroll)
    expect(onPage).toEqual(pagePoint(110, 220))
    expect(viewportFromPage(onPage, scroll)).toEqual(view)
  })

  test('view pixels are viewport CSS pixels times scale', () => {
    const box = viewportRect(8, 4, 40, 20)
    const scaled = viewRectFromViewport(box, 0.5)
    expect(scaled).toEqual(viewRect(4, 2, 20, 10))
    expect(viewFromViewport(viewportPoint(8, 4), 2)).toEqual(viewPoint(16, 8))
    expect(viewportFromView(viewFromViewport(viewportPoint(8, 4), 2), 2)).toEqual(
      viewportPoint(8, 4),
    )
  })
})

describe('canvas board coordinate spaces', () => {
  test('board and board-view pixels differ by the camera, and convert both ways', () => {
    const camera = { x: 100, y: 50, zoom: 0.5 }
    expect(boardViewFromBoard(boardPoint(300, 250), camera)).toEqual(boardViewPoint(100, 100))
    expect(boardFromBoardView(boardViewPoint(100, 100), camera)).toEqual(boardPoint(300, 250))
    const rect = boardViewRectFromBoard(boardRect(300, 250, 1440, 900), camera)
    expect(rect).toEqual(boardViewRect(100, 100, 720, 450))
    expect(boardRectFromBoardView(rect, camera)).toEqual(boardRect(300, 250, 1440, 900))
  })
})
