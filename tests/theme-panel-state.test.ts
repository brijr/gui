import { expect, test } from 'bun:test'
import {
  nudgeSize,
  panelRows,
  type ThemeSnapshot,
  type ThemeVariable,
} from '../src/shared/theme-tokens'

const v = (
  name: string,
  kind: ThemeVariable['kind'],
  value: string,
  locked: string | null = null,
) =>
  ({
    name,
    kind,
    values: { default: value },
    resolved: { default: value },
    refersTo: {},
    uses: 1,
    locked,
  }) satisfies ThemeVariable

const SNAPSHOT: ThemeSnapshot = {
  modes: [{ id: 'default', label: 'Default', selector: ':root', how: { kind: 'root' } }],
  appSetsMode: [],
  variables: [
    v('--shadow', 'other', '0 1px 2px black'),
    v('--radius', 'size', '4px'),
    v('--color-blue-50', 'color', '#eff6ff'),
    v('--brand', 'color', '#2563eb', 'Defined in node_modules'),
    v('--color-blue-100', 'color', '#dbeafe'),
    v('--color-blue-200', 'color', '#bfdbfe'),
    v('--font-sans', 'font', 'Inter, sans-serif'),
    v('--color-red-50', 'color', '#fef2f2'),
    v('--blue-line', 'other', '1px solid blue'),
  ],
}

const names = (rows: ReturnType<typeof panelRows>[number]['rows']) =>
  rows.map((row) => (row.kind === 'var' ? row.variable.name : row.prefix))

test('rows are grouped colors, sizes, fonts, then other, with scales folded', () => {
  const groups = panelRows(SNAPSHOT, '')
  expect(groups.map((g) => g.group)).toEqual(['color', 'size', 'font', 'other'])
  expect(names(groups[0].rows)).toEqual(['--color-blue', '--brand', '--color-red-50'])
  const scale = groups[0].rows[0]
  expect(scale.kind === 'scale' && scale.variables.map((x) => x.name)).toEqual([
    '--color-blue-50',
    '--color-blue-100',
    '--color-blue-200',
  ])
})

test('a search keeps only the rows and scales that match, in any case', () => {
  const groups = panelRows(SNAPSHOT, 'BLUE')
  expect(groups.map((g) => g.group)).toEqual(['color', 'other'])
  expect(names(groups[0].rows)).toEqual(['--color-blue'])
  expect(names(groups[1].rows)).toEqual(['--blue-line'])
  expect(panelRows(SNAPSHOT, 'nothing-like-this')).toEqual([])
})

test('a locked variable keeps its reason', () => {
  const row = panelRows(SNAPSHOT, 'brand')[0].rows[0]
  expect(row.kind === 'var' && row.variable.locked).toBe('Defined in node_modules')
})

test('arrow keys nudge a size in its own unit, and leave anything else alone', () => {
  expect(nudgeSize('4px', 1, false)).toBe('5px')
  expect(nudgeSize('4px', -1, true)).toBe('-6px')
  expect(nudgeSize('1rem', 1, false)).toBe('1.125rem')
  expect(nudgeSize(' 0.5em ', -1, false)).toBe('0.375em')
  expect(nudgeSize('0', 1, false)).toBe('1')
  expect(nudgeSize('calc(1px + 2px)', 1, false)).toBeNull()
  expect(nudgeSize('Inter, sans-serif', 1, false)).toBeNull()
})
