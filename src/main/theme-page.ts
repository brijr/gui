import { MAX_THEME_VARIABLES } from '../shared/bounded'
import {
  modeOf,
  referenceOf,
  safeName,
  safeValue,
  type ThemeDeclaration,
  type ThemeEdit,
  type ThemeMode,
  type ThemeSnapshot,
  variableKind,
} from '../shared/theme-tokens'

// What runs in the preview is fixed text: nothing the page said goes back into it except
// names and values that passed `safeName` / `injectable`, JSON-quoted.

const STYLE_ID = 'gui-theme-preview'

/**
 * Custom properties declared in the page's style rules (top level, or one level inside
 * `@media` / `@layer`), how many elements use each, which are used in `hsl(var(…))`,
 * their computed `:root` values now, and which mode markers the page has.
 */
export const READ_THEME = `(() => {
  const MAX_DECLARATIONS = 10000, MAX_RULES = 20000, MAX_QUERIES = 2000, MAX_COUNT = 10000
  const declarations = [], uses = {}, hsl = new Set()
  let rules = 0, queries = 0
  const visit = (rule, media, sheet) => {
    if (++rules > MAX_RULES || !(rule instanceof CSSStyleRule)) return
    const style = rule.style
    for (let i = 0; i < style.length && declarations.length < MAX_DECLARATIONS; i++) {
      const name = style[i]
      if (name.startsWith('--'))
        declarations.push({ name, value: style.getPropertyValue(name).trim(), selector: rule.selectorText, media, sheet })
    }
    const text = rule.cssText
    if (!text.includes('var(')) return
    let count = 0
    if (queries++ < MAX_QUERIES) {
      try { count = Math.min(document.querySelectorAll(rule.selectorText).length, MAX_COUNT) } catch {}
    }
    for (const name of new Set([...text.matchAll(/var\\(\\s*(--[A-Za-z0-9_-]+)/g)].map((m) => m[1])))
      uses[name] = Math.min((uses[name] || 0) + count, MAX_COUNT)
    for (const m of text.matchAll(/hsla?\\(\\s*var\\(\\s*(--[A-Za-z0-9_-]+)/g)) hsl.add(m[1])
  }
  for (const sheet of document.styleSheets) {
    // Gui's own preview style isn't the project's theme.
    if (sheet.ownerNode?.id === '${STYLE_ID}') continue
    let list
    try { list = sheet.cssRules } catch { continue }
    const href = typeof sheet.href === 'string' ? sheet.href : null
    for (const rule of list) {
      if (rule instanceof CSSMediaRule) for (const inner of rule.cssRules) visit(inner, rule.media.mediaText, href)
      else if (typeof CSSLayerBlockRule === 'function' && rule instanceof CSSLayerBlockRule)
        for (const inner of rule.cssRules) visit(inner, null, href)
      else visit(rule, null, href)
    }
  }
  const root = document.documentElement
  const style = getComputedStyle(root)
  const computed = {}
  for (const { name } of declarations) if (!(name in computed)) computed[name] = style.getPropertyValue(name).trim()
  return {
    declarations, computed, uses, hsl: [...hsl],
    state: {
      darkClass: root.classList.contains('dark'),
      theme: root.getAttribute('data-theme'),
      prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
    },
  }
})()`

export const REMOVE_PREVIEW = `document.getElementById('${STYLE_ID}')?.remove()`

/** Sets the preview style's text, adding the style last in the document if it isn't there. */
export const previewExpression = (css: string) => `(() => {
  let style = document.getElementById('${STYLE_ID}')
  if (!style) {
    style = document.createElement('style')
    style.id = '${STYLE_ID}'
    ;(document.head || document.documentElement).append(style)
  }
  style.textContent = ${JSON.stringify(css)}
})()`

/** The mode markers on `<html>` a mode is shown with. */
export interface ModeMarkers {
  dark: boolean
  theme: string | null
}

export function markersOf(mode: ThemeMode): ModeMarkers {
  if (mode.how.kind === 'class') return { dark: true, theme: null }
  if (mode.how.kind === 'attribute') return { dark: false, theme: mode.how.value }
  return { dark: false, theme: null }
}

/**
 * Puts `markers` on `<html>`, remembering the page's own the first time; `null` puts the
 * page's own back.
 */
export const modeExpression = (markers: ModeMarkers | null) => `(() => {
  const root = document.documentElement
  const own = (window.__guiThemeOwnMode ??= { dark: root.classList.contains('dark'), theme: root.getAttribute('data-theme') })
  const want = ${JSON.stringify(markers)}
  const next = want ?? own
  root.classList.toggle('dark', next.dark === true)
  if (typeof next.theme === 'string') root.setAttribute('data-theme', next.theme)
  else root.removeAttribute('data-theme')
  if (!want) delete window.__guiThemeOwnMode
})()`

/** True while `<html>` still has `markers` (the app hasn't put its own back). */
export const modeKeptExpression = (markers: ModeMarkers) => `(() => {
  const root = document.documentElement
  const want = ${JSON.stringify(markers)}
  return root.classList.contains('dark') === want.dark && root.getAttribute('data-theme') === want.theme
})()`

/** What the page answered READ_THEME with, once its shape is checked. */
export interface PageTheme {
  declarations: ThemeDeclaration[]
  computed: Record<string, string>
  uses: Record<string, number>
  hsl: string[]
  state: { darkClass: boolean; theme: string | null; prefersDark: boolean }
}

const MAX_TEXT = 2000
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= MAX_TEXT
const textOrNull = (value: unknown): value is string | null => value === null || text(value)
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function parsePageTheme(value: unknown): PageTheme | null {
  if (!record(value) || !Array.isArray(value.declarations) || !record(value.computed)) return null
  if (!record(value.uses) || !Array.isArray(value.hsl) || !record(value.state)) return null
  const declarations = value.declarations
    .slice(0, 5 * MAX_THEME_VARIABLES)
    .filter(
      (d): d is ThemeDeclaration =>
        record(d) &&
        text(d.name) &&
        text(d.value) &&
        text(d.selector) &&
        textOrNull(d.media) &&
        textOrNull(d.sheet),
    )
    .map(({ name, value, selector, media, sheet }) => ({ name, value, selector, media, sheet }))
  const computed: Record<string, string> = {}
  for (const [name, v] of Object.entries(value.computed))
    if (safeName(name) && typeof v === 'string' && injectable(v)) computed[name] = v
  const uses: Record<string, number> = {}
  for (const [name, n] of Object.entries(value.uses))
    if (safeName(name) && typeof n === 'number' && Number.isFinite(n) && n >= 0) uses[name] = n
  const { darkClass, theme, prefersDark } = value.state
  return {
    declarations,
    computed,
    uses,
    hsl: value.hsl.filter((name): name is string => typeof name === 'string' && safeName(name)),
    state: {
      darkClass: darkClass === true,
      theme: text(theme) ? theme : null,
      prefersDark: prefersDark === true,
    },
  }
}

/** The mode the page is in by its own markers. */
export function pageModeOf(state: PageTheme['state'], modes: ThemeMode[]) {
  const found = modes.find(
    ({ how }) =>
      (how.kind === 'class' && state.darkClass) ||
      (how.kind === 'attribute' && how.value === state.theme),
  )
  if (found) return found.id
  return (state.prefersDark && modes.find(({ how }) => how.kind === 'media')?.id) || 'default'
}

/** Every bracket closes, outside strings: an open `(` would swallow the rules after it. */
function bracketsBalanced(value: string) {
  let depth = 0
  for (const ch of value.replace(/"[^"]*"|'[^']*'/g, '')) {
    if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    if (depth < 0) return false
  }
  return depth === 0
}

/** A value that can go into the preview style as one declaration's value. */
export const injectable = (value: string) => safeValue(value) && bracketsBalanced(value)

// modeOf's quoted [data-theme] branch lets quotes and backslashes through; the selector Gui
// writes is built from `how`, so its value must be plain.
const PLAIN = /^[A-Za-z0-9_-]{1,100}$/
const safeMode = ({ how }: ThemeMode) =>
  (how.kind !== 'class' && how.kind !== 'attribute') ||
  (PLAIN.test(how.name) && (how.kind === 'class' || PLAIN.test(how.value)))

const MAX_DEPTH = 10

/**
 * The page's declarations as the panel shows them. `resolved` is mode id → name → the
 * page's computed value, for values the declarations alone can't resolve. `locks` is name
 * → why Keep can't write it. Unsafe names, values and modes are dropped.
 */
export function snapshotFrom(
  declarations: ThemeDeclaration[],
  resolved: Record<string, Record<string, string>>,
  uses: Record<string, number>,
  hslUsed: Set<string>,
  locks: Map<string, string>,
): ThemeSnapshot {
  const modes = [modeOf(':root', null) as ThemeMode]
  const declared = new Map<string, Record<string, string>>()
  for (const d of declarations) {
    if (!safeName(d.name) || !injectable(d.value)) continue
    const mode = modeOf(d.selector, d.media)
    if (!mode || !safeMode(mode)) continue
    let own = declared.get(d.name)
    if (!own) {
      if (declared.size >= MAX_THEME_VARIABLES) continue
      own = {}
      declared.set(d.name, own)
    }
    if (!modes.some((m) => m.id === mode.id)) modes.push(mode)
    own[mode.id] = d.value
  }
  const valueIn = (name: string, mode: string) =>
    declared.get(name)?.[mode] ?? declared.get(name)?.default ?? null
  const resolve = (name: string, mode: string) => {
    const seen = new Set<string>()
    let at = name
    for (let depth = 0; depth <= MAX_DEPTH && !seen.has(at); depth++) {
      seen.add(at)
      const value = valueIn(at, mode)
      const next = value === null ? null : referenceOf(value)
      if (value === null) break
      if (!next) return value
      at = next
    }
    const page = resolved[mode]?.[name]
    return page !== undefined && injectable(page) ? page : (valueIn(name, mode) ?? '')
  }
  const variables = [...declared].map(([name, own]) => {
    const values = Object.fromEntries(modes.map((m) => [m.id, own[m.id] ?? null]))
    const resolvedIn = Object.fromEntries(modes.map((m) => [m.id, resolve(name, m.id)]))
    return {
      name,
      kind: variableKind(resolvedIn.default, hslUsed.has(name), name),
      values,
      resolved: resolvedIn,
      refersTo: Object.fromEntries(
        modes.map((m) => {
          const value = own[m.id] ?? own.default
          return [m.id, value === undefined ? null : referenceOf(value)]
        }),
      ),
      uses: uses[name] ?? 0,
      locked: locks.get(name) ?? null,
    }
  })
  return { modes, variables, appSetsMode: [] }
}

function ruleFor(mode: ThemeMode, body: string) {
  const { how } = mode
  if (how.kind === 'class') return `.${how.name} { ${body} }`
  if (how.kind === 'attribute') return `[${how.name}="${how.value}"] { ${body} }`
  if (how.kind === 'media') return `@media (prefers-color-scheme: dark) { :root { ${body} } }`
  return `:root { ${body} }`
}

/**
 * The preview style for `edits`: `<mode> { --name: value !important; }`, default first.
 * A default edit's `!important` would also win over another mode's own value on the same
 * element, so each mode that declares the name says its value again after it.
 */
export function previewCss(edits: ThemeEdit[], snapshot: ThemeSnapshot) {
  const ordered = [...snapshot.modes].sort(
    (a, b) => Number(b.id === 'default') - Number(a.id === 'default'),
  )
  const names = [...new Set(edits.map((edit) => edit.name))]
  const rules: string[] = []
  for (const mode of ordered) {
    const body: string[] = []
    for (const name of names) {
      const edited = edits.find((edit) => edit.name === name && edit.mode === mode.id)?.value
      const own = edits.some((edit) => edit.name === name && edit.mode === 'default')
        ? snapshot.variables.find((v) => v.name === name)?.values[mode.id]
        : null
      const value = edited ?? (mode.id === 'default' ? null : own)
      if (value && safeName(name) && injectable(value)) body.push(`${name}: ${value} !important;`)
    }
    if (body.length) rules.push(ruleFor(mode, body.join(' ')))
  }
  return rules.join('\n')
}
