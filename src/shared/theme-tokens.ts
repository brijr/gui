/** Theme variables as the Theme panel sees them. Pure: no Electron, no React. */

export type ThemeKind = 'color' | 'size' | 'font' | 'other'

export type ThemeModeHow =
  | { kind: 'root' }
  | { kind: 'class'; name: string }
  | { kind: 'attribute'; name: string; value: string }
  | { kind: 'media' }

export interface ThemeMode {
  id: string
  label: string
  selector: string
  how: ThemeModeHow
}

/** One custom property declaration, raw from the page. */
export interface ThemeDeclaration {
  name: string
  value: string
  selector: string
  media: string | null
  sheet: string | null
}

export interface ThemeVariable {
  name: string
  kind: ThemeKind
  values: Record<string, string | null>
  resolved: Record<string, string>
  /** Mode id → the variable its own (or inherited default) value is a bare `var()` of */
  refersTo: Record<string, string | null>
  uses: number
  locked: string | null
}

export interface ThemeSnapshot {
  modes: ThemeMode[]
  variables: ThemeVariable[]
  appSetsMode: string[]
}

export interface ThemeEdit {
  name: string
  mode: string
  value: string
}

const ROOT = /^(?::root|html|:host)$/
const DARK_MEDIA = /^\(\s*prefers-color-scheme\s*:\s*dark\s*\)$/i
const DARK_CLASS = /^(?::root|html)?\.dark$/
const THEME_ATTR =
  /^(?::root|html)?\[data-theme=(?:"([^"]{1,100})"|'([^']{1,100})'|([\w-]{1,100}))\]$/

export function modeOf(selector: string, media: string | null): ThemeMode | null {
  const parts = selector.split(',').map((part) => part.trim())
  const trimmed = selector.trim()
  const darkMedia = media !== null && DARK_MEDIA.test(media.trim())
  if (media !== null && !darkMedia) return null
  if (parts.some((part) => ROOT.test(part))) {
    return darkMedia
      ? { id: 'dark', label: 'Dark', selector: trimmed, how: { kind: 'media' } }
      : { id: 'default', label: 'Default', selector: trimmed, how: { kind: 'root' } }
  }
  if (darkMedia) return null
  if (parts.some((part) => DARK_CLASS.test(part))) {
    return { id: 'dark', label: 'Dark', selector: trimmed, how: { kind: 'class', name: 'dark' } }
  }
  for (const part of parts) {
    const match = THEME_ATTR.exec(part)
    const value = match && (match[1] ?? match[2] ?? match[3])
    if (value) {
      return {
        id: `theme:${value}`,
        label: value,
        selector: trimmed,
        how: { kind: 'attribute', name: 'data-theme', value },
      }
    }
  }
  return null
}

const COLOR_FN = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const BARE_HSL = /^\d*\.?\d+(?:deg)?[\s,]+\d*\.?\d+%[\s,]+\d*\.?\d+%$/
const SIZE = /^(?:0|-?\d*\.?\d+(?:px|rem|em|%|vh|vw|ch))$/
const FONT_KEYWORDS = new Set([
  'inherit',
  'initial',
  'unset',
  'revert',
  'none',
  'auto',
  'normal',
  'transparent',
  'currentcolor',
  'solid',
  'ease',
  'linear',
  'infinite',
  'block',
  'flex',
  'grid',
  'inline',
  'hidden',
  'visible',
])
const FONT_FIRST = /^(?:"[^"]+"|'[^']+'|[A-Za-z][A-Za-z_-]*(?: [A-Za-z][A-Za-z_-]*)*)$/
const GENERIC_FAMILY =
  /^(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|emoji|math|fangsong)$/i

export function variableKind(value: string, usedInHsl: boolean, name = ''): ThemeKind {
  const v = value.trim()
  if (HEX.test(v) || COLOR_FN.test(v) || (usedInHsl && BARE_HSL.test(v))) return 'color'
  if (SIZE.test(v)) return 'size'
  if (/^[1-9]00$/.test(v) && /weight/i.test(name)) return 'font'
  const items = v.split(',')
  const first = items[0]?.trim() ?? ''
  const quoted = /^["']/.test(first)
  const generic = items.some((item) => GENERIC_FAMILY.test(item.trim()))
  if (
    items.length > 1 &&
    FONT_FIRST.test(first) &&
    !FONT_KEYWORDS.has(first.toLowerCase()) &&
    (quoted || generic)
  ) {
    return 'font'
  }
  return 'other'
}

const REFERENCE = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/

export function referenceOf(value: string): string | null {
  return REFERENCE.exec(value.trim())?.[1] ?? null
}

const SCALE_STEP = /^(.+)-(\d+)$/

/** Groups `--x-50 … --x-950` style names by prefix; a scale needs at least three steps. */
export function foldScales(names: string[]): { prefix: string; names: string[] }[] {
  const groups = new Map<string, string[]>()
  for (const name of names) {
    const prefix = SCALE_STEP.exec(name)?.[1]
    if (prefix) groups.set(prefix, [...(groups.get(prefix) ?? []), name])
  }
  return [...groups]
    .filter(([, members]) => members.length >= 3)
    .map(([prefix, members]) => ({ prefix, names: members }))
}

export type PanelRow =
  | { kind: 'var'; variable: ThemeVariable }
  | { kind: 'scale'; prefix: string; variables: ThemeVariable[] }

const PANEL_GROUPS: ThemeKind[] = ['color', 'size', 'font', 'other']

/**
 * The Theme panel's rows: variables whose name has `query` in it (any case), grouped by kind
 * in PANEL_GROUPS order, with each group's scales folded into one row where their first step was.
 */
export function panelRows(
  snapshot: ThemeSnapshot,
  query: string,
): { group: ThemeKind; rows: PanelRow[] }[] {
  const needle = query.trim().toLowerCase()
  const matching = snapshot.variables.filter((v) => v.name.toLowerCase().includes(needle))
  return PANEL_GROUPS.flatMap((group) => {
    const members = matching.filter((v) => v.kind === group)
    const scaleOf = new Map<string, string>()
    for (const { prefix, names } of foldScales(members.map((v) => v.name)))
      for (const name of names) scaleOf.set(name, prefix)
    const rows: PanelRow[] = []
    for (const variable of members) {
      const prefix = scaleOf.get(variable.name)
      if (!prefix) rows.push({ kind: 'var', variable })
      else if (!rows.some((row) => row.kind === 'scale' && row.prefix === prefix))
        rows.push({
          kind: 'scale',
          prefix,
          variables: members.filter((v) => scaleOf.get(v.name) === prefix),
        })
    }
    return rows.length ? [{ group, rows }] : []
  })
}

/** Arrow keys nudge a size's number by this (Shift: ten times), in its own unit. */
const NUDGE: Record<string, number> = { rem: 0.125, em: 0.125 }
const NUMBER_UNIT = /^(-?\d*\.?\d+)([a-z%]*)$/

/** A size `text` nudged one step up (1) or down (-1), ten with `big`; null when it isn't a size. */
export function nudgeSize(text: string, direction: 1 | -1, big: boolean): string | null {
  const size = NUMBER_UNIT.exec(text.trim())
  if (!size) return null
  const step = (NUDGE[size[2]] ?? 1) * (big ? 10 : 1)
  return `${Number((Number(size[1]) + direction * step).toFixed(3))}${size[2]}`
}

/**
 * A size `start` scrubbed `steps` steps (one per few pixels dragged): ten times the step with
 * `big` (Shift), a tenth with `fine` (Alt). A size that started at 0 or more never goes below 0.
 * Null when `start` isn't a size.
 */
export function scrubSize(
  start: string,
  steps: number,
  big: boolean,
  fine: boolean,
): string | null {
  const size = NUMBER_UNIT.exec(start.trim())
  if (!size) return null
  const from = Number(size[1])
  const step = (NUDGE[size[2]] ?? 1) * (big ? 10 : fine ? 0.1 : 1)
  const next = from + Math.trunc(steps) * step
  return `${Number((from >= 0 ? Math.max(0, next) : next).toFixed(3))}${size[2]}`
}

const MAX_VALUE = 500

export function safeName(name: string): boolean {
  return /^--[A-Za-z0-9_-]{1,100}$/.test(name)
}

/** Every quote in `value` opens or closes a string. */
function quotesBalanced(value: string) {
  let open: string | null = null
  for (const ch of value) {
    if (open === null && (ch === '"' || ch === "'")) open = ch
    else if (ch === open) open = null
  }
  return open === null
}

/**
 * Page values are untrusted; refuse anything that could end a declaration, a style tag or a
 * comment, or run on past its own end (an open string, a backslash escaping what follows).
 */
export function safeValue(value: string): boolean {
  return (
    quotesBalanced(value) &&
    !value.includes('\\') &&
    value.length <= MAX_VALUE &&
    !/[;{}]/.test(value) &&
    ![...value].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) &&
    !value.includes('</') &&
    !value.includes('/*') &&
    !value.includes('*/')
  )
}
