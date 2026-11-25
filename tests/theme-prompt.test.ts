import { expect, test } from 'bun:test'
import { previewToolNames } from '../src/main/mcp-preview-tools'
import { OUTSIDE_TOOL_NAMES } from '../src/main/outside-mcp'
import { buildPrompt, describePalette } from '../src/main/prompt'
import { MAX_PALETTE_PROMPT_CHARS } from '../src/shared/bounded'
import type { ThemeSnapshot, ThemeVariable } from '../src/shared/theme-tokens'

const variable = (name: string, light: string, dark: string | null = null): ThemeVariable => ({
  name,
  kind: 'color',
  values: { light, dark },
  resolved: { light },
  refersTo: {},
  uses: 0,
  locked: null,
})
const modes = [
  { id: 'light', label: 'default', selector: ':root', how: { kind: 'root' as const } },
  { id: 'dark', label: 'dark', selector: '.dark', how: { kind: 'class' as const, name: 'dark' } },
]
const steps = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
const tailwind: ThemeSnapshot = {
  modes,
  appSetsMode: [],
  variables: [
    ...Array.from({ length: 23 }, (_, i) => '--color-hue' + i).flatMap((hue) =>
      steps.map((step) => variable(hue + '-' + step, '#000')),
    ),
    ...steps.map((step) => variable('--color-blue-' + step, '#00f')),
    variable('--brand', '#2563eb', '#60a5fa'),
  ],
}

test('a long palette folds scales and stays within the cap', () => {
  const text = describePalette(tailwind)
  expect(text.length).toBeLessThanOrEqual(MAX_PALETTE_PROMPT_CHARS)
  expect(text).toMatch(/^<theme_[0-9a-f]{8}>/)
  expect(text).toContain('Modes: default, dark')
  expect(text).toContain('--color-blue-50…950 (11 shades)')
  expect(text).toContain('--brand: #2563eb (dark: #60a5fa)')
})

test('a palette that does not fit says how many are left', () => {
  const variables = Array.from({ length: 1000 }, (_, i) => variable('--v' + i, '#fff'))
  const text = describePalette({ ...tailwind, variables })
  expect(text.length).toBeLessThanOrEqual(MAX_PALETTE_PROMPT_CHARS)
  expect(text).toMatch(/… \d+ more \(preview_theme lists all\)/)
})

const prompt = (palette: string | null) =>
  buildPrompt({
    text: 'make it pop',
    selection: [],
    viewport: null,
    problems: [],
    preamble: false,
    tools: true,
    images: true,
    attachments: [],
    palette,
  }).flatMap((block) => (block.type === 'text' ? [block.text] : []))

test('the palette comes before the user text, and null adds nothing', () => {
  expect(prompt('X')).toEqual(['X', 'make it pop'])
  expect(prompt(null)).toEqual(['make it pop'])
})

test('preview_theme is a project tool and an outside tool', () => {
  expect(previewToolNames(true)).toContain('preview_theme')
  expect(previewToolNames(false)).not.toContain('preview_theme')
  expect(OUTSIDE_TOOL_NAMES).toContain('preview_theme')
})
