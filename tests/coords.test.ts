import { describe, expect, test } from 'bun:test'
import {
  pageFromViewport,
  pagePoint,
  viewFromViewport,
  viewportFromPage,
  viewportFromView,
  viewportPoint,
  viewportRect,
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
    expect(scaled).toEqual({ x: 4, y: 2, width: 20, height: 10 })
    expect(viewFromViewport(viewportPoint(8, 4), 2)).toEqual({ x: 16, y: 8 })
    expect(viewportFromView(viewFromViewport(viewportPoint(8, 4), 2), 2)).toEqual(
      viewportPoint(8, 4),
    )
  })
})
