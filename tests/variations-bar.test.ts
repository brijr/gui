import { expect, test } from 'bun:test'
import { barCornerFor, barRest, clampBar } from '../src/main/variations-bar'

const area = { x: 100, y: 50, width: 1000, height: 600 }
const size = { width: 300, height: 36 }
const base = { area, size, chat: null, inset: 12, minWidth: 240 }

test('the bar rests in each corner of the page, inset from its edges', () => {
  expect(barRest({ ...base, corner: { x: 'left', y: 'bottom' } })).toEqual({
    at: { x: 12, y: 552 },
    room: 976,
  })
  expect(barRest({ ...base, corner: { x: 'right', y: 'bottom' } }).at).toEqual({ x: 688, y: 552 })
  expect(barRest({ ...base, corner: { x: 'left', y: 'top' } }).at).toEqual({ x: 12, y: 12 })
  expect(barRest({ ...base, corner: { x: 'right', y: 'top' } }).at).toEqual({ x: 688, y: 12 })
})

test('a floating chat in the same corner pushes the bar beside it, toward the middle', () => {
  const leftChat = { x: 112, y: 300, width: 360, height: 338 }
  expect(barRest({ ...base, chat: leftChat, corner: { x: 'left', y: 'bottom' } })).toEqual({
    at: { x: 384, y: 552 },
    room: 604,
  })
  const rightChat = { x: 728, y: 62, width: 360, height: 338 }
  expect(barRest({ ...base, chat: rightChat, corner: { x: 'right', y: 'top' } })).toEqual({
    at: { x: 316, y: 12 },
    room: 604,
  })
})

test('a chat in another corner leaves the bar where it is', () => {
  const leftChat = { x: 112, y: 300, width: 360, height: 338 }
  expect(barRest({ ...base, chat: leftChat, corner: { x: 'right', y: 'bottom' } }).at).toEqual({
    x: 688,
    y: 552,
  })
})

test('beside a wide chat, the bar keeps its least room and its name shortens', () => {
  const wideChat = { x: 112, y: 300, width: 900, height: 338 }
  const rest = barRest({ ...base, chat: wideChat, corner: { x: 'right', y: 'bottom' } })
  expect(rest.room).toBe(240)
  expect(rest.at).toEqual({ x: 12, y: 552 })
})

test('let go at rest, the bar goes to the corner its middle is nearest', () => {
  const still = { x: 0, y: 0 }
  expect(barCornerFor(area, size, { x: 600, y: 400 }, still)).toEqual({ x: 'right', y: 'bottom' })
  expect(barCornerFor(area, size, { x: 100, y: 100 }, still)).toEqual({ x: 'left', y: 'top' })
})

test('thrown, the bar goes to the corner its throw would carry it to', () => {
  expect(barCornerFor(area, size, { x: 100, y: 500 }, { x: 2000, y: -2000 })).toEqual({
    x: 'right',
    y: 'top',
  })
})

test('a held bar stays inside the page', () => {
  expect(clampBar(area, size, { x: -40, y: 900 })).toEqual({ x: 0, y: 564 })
  expect(clampBar(area, size, { x: 2000, y: -5 })).toEqual({ x: 700, y: 0 })
})
