/**
 * Design-token colors that native code needs, per appearance. They repeat values from
 * src/renderer/src/styles.css; keep the two in sync.
 */

/** --surface: window backgrounds, shown while a page loads and as the window resizes. */
export const SURFACE = { light: '#f7f7f7', dark: '#18181a' } as const

/** --accent: the element highlight in the preview. */
export const ACCENT = { light: '#0066ff', dark: '#5c9dff' } as const

/** --fill: quiet neutral areas, such as the highlight's margin. */
export const FILL = {
  light: { r: 0, g: 0, b: 0, a: 0.06 },
  dark: { r: 255, g: 255, b: 255, a: 0.08 },
} as const
