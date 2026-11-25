import { expect, test } from 'bun:test'

import {
  isStyleKitId,
  KIT_TOKENS,
  kitBrand,
  kitCss,
  kitFrameHtml,
  kitStylesheetName,
  STYLE_KITS,
} from '../src/shared/style-kits'

test('every kit defines every token in light and dark', () => {
  for (const kit of STYLE_KITS) {
    for (const token of KIT_TOKENS) {
      expect(kit.light[token]).toBeTruthy()
      expect(kit.dark[token]).toBeTruthy()
    }
  }
})

test('kitCss has :root and .dark blocks with every token, and no url or @import', () => {
  const css = kitCss(STYLE_KITS[0])
  expect(css).toContain(':root {')
  expect(css).toContain('.dark {')
  for (const token of KIT_TOKENS) expect(css.split(`${token}:`).length - 1).toBe(2)
  expect(css).not.toMatch(/url\(|@import/)
})

test('kitBrand names the stylesheet and says to use variables', () => {
  const md = kitBrand(STYLE_KITS[1])
  expect(md).toContain('../assets/kit-editorial.css')
  expect(md).toContain('var(--primary)')
})

test('the sample frame links its kit stylesheet and uses variables, not raw colors', () => {
  for (const kit of STYLE_KITS) {
    const html = kitFrameHtml(kit)
    expect(html).toContain(`href="../assets/${kitStylesheetName(kit)}"`)
    expect(html).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|oklch\(/i)
  }
})

test('generated files differ between kits', () => {
  expect(new Set(STYLE_KITS.map(kitCss)).size).toBe(STYLE_KITS.length)
})

test('isStyleKitId', () => {
  expect(isStyleKitId('mono')).toBe(true)
  expect(isStyleKitId('../x')).toBe(false)
})

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

test('every kit primary is readable under its primary-foreground (WCAG AA)', () => {
  for (const kit of STYLE_KITS) {
    for (const theme of ['light', 'dark'] as const) {
      const [hi, lo] = [
        luminance(kit[theme]['--primary']),
        luminance(kit[theme]['--primary-foreground']),
      ].sort((a, b) => b - a)
      expect((hi + 0.05) / (lo + 0.05), `${kit.id} ${theme}`).toBeGreaterThanOrEqual(4.5)
    }
  }
})

test('kitCss sets color-scheme for each theme', () => {
  const css = kitCss(STYLE_KITS[0])
  expect(css).toContain('color-scheme: light;')
  expect(css).toContain('color-scheme: dark;')
})
