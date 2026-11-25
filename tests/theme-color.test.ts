import { expect, test } from 'bun:test'
import { formatColor, parseColor, toHex } from '../src/shared/theme-color'

test('hex round trips', () => {
  const p = parseColor('#7c3aed')!
  expect(p.format).toBe('hex')
  expect(formatColor(p.rgba, 'hex')).toBe('#7c3aed')
  expect(toHex(p.rgba)).toBe('#7c3aed')
  expect(parseColor('#fff')!.rgba).toEqual({ r: 255, g: 255, b: 255, a: 1 })
})

test('bare hsl channels keep their shape', () => {
  const p = parseColor('222 47% 11%')!
  expect(p.format).toBe('hsl-channels')
  expect(formatColor(p.rgba, 'hsl-channels')).toMatch(/^\d+(\.\d+)? \d+(\.\d+)?% \d+(\.\d+)?%$/)
})

test('hsl() round trips', () => {
  const p = parseColor('hsl(222, 47%, 11%)')!
  expect(p.format).toBe('hsl')
  expect(formatColor(p.rgba, 'hsl')).toMatch(/^hsl\(\d+(\.\d)? \d+(\.\d)?% \d+(\.\d)?%\)$/)
})

test('oklch survives a round trip', () => {
  const p = parseColor('oklch(0.62 0.19 259)')!
  expect(p.format).toBe('oklch')
  const q = parseColor(formatColor(p.rgba, 'oklch'))!
  const [, L, C, H] = formatColor(q.rgba, 'oklch')
    .match(/oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/)!
    .map(Number) as unknown as [0, number, number, number]
  expect(Math.abs(L - 0.62)).toBeLessThan(0.005)
  expect(Math.abs(C - 0.19)).toBeLessThan(0.005)
  expect(Math.abs(H - 259)).toBeLessThan(1)
})

test('alpha is kept', () => {
  const p = parseColor('rgb(37 99 235 / 0.5)')!
  expect(p.rgba.a).toBe(0.5)
  expect(formatColor(p.rgba, 'rgb')).toBe('rgb(37 99 235 / 0.5)')
})

test('named and junk colors are not parsed', () => {
  expect(parseColor('blue')).toBeNull()
  expect(parseColor('var(--x)')).toBeNull()
})
