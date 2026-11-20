import { project } from '../shared/motion'
import type { PanelCorner, Point, Rect } from '../shared/types'

export interface BarSize {
  width: number
  height: number
}

export interface BarRestInput {
  area: Rect
  size: BarSize
  corner: PanelCorner
  chat: Rect | null
  inset: number
  minWidth: number
}

export interface BarRest {
  at: Point
  room: number
}

export function barRest({ area, size, corner, chat, inset, minWidth }: BarRestInput): BarRest {
  const top = corner.y === 'top' ? inset : area.height - inset - size.height
  const left = corner.x === 'left' ? inset : area.width - inset - size.width
  const bar = { x: area.x + left, y: area.y + top, width: size.width, height: size.height }
  if (!chat || !overlaps(chat, bar))
    return { at: { x: left, y: top }, room: area.width - inset * 2 }
  if (corner.x === 'left') {
    const x = Math.max(
      inset,
      Math.min(chat.x + chat.width + inset - area.x, area.width - inset - minWidth),
    )
    return { at: { x, y: top }, room: area.width - inset - x }
  }
  const right = Math.min(area.width - inset, Math.max(chat.x - inset - area.x, inset + minWidth))
  const room = right - inset
  return { at: { x: right - Math.min(size.width, room), y: top }, room }
}

export function clampBar(area: Rect, size: BarSize, at: Point): Point {
  return {
    x: Math.min(Math.max(at.x, 0), Math.max(0, area.width - size.width)),
    y: Math.min(Math.max(at.y, 0), Math.max(0, area.height - size.height)),
  }
}

export function barCornerFor(area: Rect, size: BarSize, at: Point, velocity: Point): PanelCorner {
  const x = project(at.x + size.width / 2, velocity.x)
  const y = project(at.y + size.height / 2, velocity.y)
  return {
    x: x < area.width / 2 ? 'left' : 'right',
    y: y < area.height / 2 ? 'top' : 'bottom',
  }
}

function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}
