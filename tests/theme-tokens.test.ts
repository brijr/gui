import { expect, test } from 'bun:test'

import {
  foldScales,
  modeOf,
  referenceOf,
  safeName,
  safeValue,
  variableKind,
} from '../src/shared/theme-tokens'

test('modes come from :root, .dark, data-theme and the dark media query', () => {
  expect(modeOf(':root', null)?.id).toBe('default')
  expect(modeOf('html', null)?.id).toBe('default')
  expect(modeOf(':root, :host', null)?.id).toBe('default')
  expect(modeOf('.dark', null)).toMatchObject({ id: 'dark', how: { kind: 'class', name: 'dark' } })
  expect(modeOf('[data-theme="ocean"]', null)).toMatchObject({
    id: 'theme:ocean',
    how: { kind: 'attribute', name: 'data-theme', value: 'ocean' },
  })
  expect(modeOf(':root', '(prefers-color-scheme: dark)')).toMatchObject({
    id: 'dark',
    how: { kind: 'media' },
  })
  expect(modeOf(':root, .card', null)?.id).toBe('default')
  expect(modeOf('.card', null)).toBeNull()
  expect(modeOf('.card', '(prefers-color-scheme: dark)')).toBeNull()
  expect(modeOf(':root', '(min-width: 600px)')).toBeNull()
})

test('kinds are read from the value', () => {
  expect(variableKind('#2563eb', false)).toBe('color')
  expect(variableKind('oklch(0.62 0.19 259)', false)).toBe('color')
  expect(variableKind('222 47% 11%', true)).toBe('color')
  expect(variableKind('222 47% 11%', false)).toBe('other')
  expect(variableKind('0.5rem', false)).toBe('size')
  expect(variableKind('0', false)).toBe('size')
  expect(variableKind('Inter, system-ui, sans-serif', false)).toBe('font')
  expect(variableKind('"Inter Tight", serif', false)).toBe('font')
  expect(variableKind('600', false, '--font-weight-bold')).toBe('font')
  expect(variableKind('600', false, '--z')).toBe('other')
  expect(variableKind('"SF Pro", sans-serif', false)).toBe('font')
  expect(variableKind('cubic-bezier(.2,0,0,1)', false)).toBe('other')
  expect(variableKind('inset 0 0 1px red, 0 1px 2px rgba(0,0,0,.2)', false)).toBe('other')
  expect(variableKind('opacity 200ms, color 200ms', false)).toBe('other')
  expect(variableKind('ease-in, ease-out', false)).toBe('other')
})

test('a reference is only a bare var()', () => {
  expect(referenceOf('var(--blue-600)')).toBe('--blue-600')
  expect(referenceOf(' var( --blue-600 ) ')).toBe('--blue-600')
  expect(referenceOf('color-mix(in oklch, var(--a), white)')).toBeNull()
  expect(referenceOf('var(--a, red)')).toBeNull()
})

test('scales fold by prefix', () => {
  expect(
    foldScales(['--color-blue-50', '--color-blue-100', '--color-blue-500', '--brand']),
  ).toEqual([
    { prefix: '--color-blue', names: ['--color-blue-50', '--color-blue-100', '--color-blue-500'] },
  ])
  expect(foldScales(['--a-1', '--a-2'])).toEqual([])
})

test('page values that could break out of a declaration are refused', () => {
  expect(safeValue('#fff')).toBe(true)
  expect(safeValue('red;} body{display:none')).toBe(false)
  expect(safeValue('</style><script>')).toBe(false)
  expect(safeValue('a /* x */')).toBe(false)
  expect(safeValue('a\nb')).toBe(false)
  expect(safeValue('x'.repeat(500))).toBe(true)
  expect(safeValue('x'.repeat(501))).toBe(false)
  expect(safeValue('"x')).toBe(false)
  expect(safeValue("'Inter, sans-serif")).toBe(false)
  expect(safeValue('red\\')).toBe(false)
  expect(safeValue('"\\5FAE"')).toBe(false)
  expect(safeValue(`"Inter's Font", 'Mono'`)).toBe(true)
  expect(safeName('--brand')).toBe(true)
  expect(safeName('--a;b')).toBe(false)
  expect(safeName('brand')).toBe(false)
})
