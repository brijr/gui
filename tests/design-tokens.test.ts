import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesignTokens } from '../src/main/design-tokens'
import { ProjectResources } from '../src/main/project-resources'
import { READ_THEME, REMOVE_PREVIEW, snapshotFrom } from '../src/main/theme-page'
import type { ThemeDeclaration } from '../src/shared/theme-tokens'

// The page is untrusted: what it declares is read, filtered, and only validated names and
// values go back into it, in the one preview style.

const decl = (selector: string, name: string, value: string, media: string | null = null) =>
  ({ name, value, selector, media, sheet: null }) satisfies ThemeDeclaration

const DECLARATIONS = [
  decl(':root', '--brand', '#2563eb'),
  decl(':root', '--muted', '#64748b'),
  decl(':root', '--primary', 'var(--brand)'),
  decl('.dark', '--brand', '#60a5fa'),
]

const READ = {
  declarations: DECLARATIONS,
  computed: { '--brand': '#2563eb', '--muted': '#64748b', '--primary': '#2563eb' },
  uses: { '--brand': 3 },
  hsl: [],
  state: { darkClass: false, theme: null, prefersDark: false },
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let dir: string | null = null
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = null
})

/** A preview whose page answers the theme read with `read`; every other expression is recorded. */
function preview(read: unknown = READ, root = join(tmpdir(), 'gui-design-tokens-no-project')) {
  const sent: string[] = []
  const state = { live: true, hold: null as Promise<void> | null, modeKept: true }
  const command = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
    const expression = String(params?.expression ?? '')
    if (method === 'Runtime.evaluate' && expression === READ_THEME) {
      if (state.hold) await state.hold
      return { result: { value: read } } as T
    }
    sent.push(method === 'Runtime.evaluate' ? expression : method)
    return { result: { value: state.modeKept } } as T
  }
  const tokens = new DesignTokens({ command, root, live: () => state.live })
  return { tokens, sent, state }
}

test('modes come from the selectors; a mode without its own value inherits the default', () => {
  const snapshot = snapshotFrom(DECLARATIONS, {}, { '--brand': 3 }, new Set(), new Map())
  expect(snapshot.modes.map((mode) => mode.id)).toEqual(['default', 'dark'])
  const muted = snapshot.variables.find((v) => v.name === '--muted')
  expect(muted?.values.dark).toBeNull()
  expect(muted?.resolved.dark).toBe('#64748b')
  const primary = snapshot.variables.find((v) => v.name === '--primary')
  expect(primary?.refersTo).toEqual({ default: '--brand', dark: '--brand' })
  expect(primary?.resolved).toEqual({ default: '#2563eb', dark: '#60a5fa' })
  expect(primary?.kind).toBe('color')
  expect(snapshot.variables.find((v) => v.name === '--brand')?.uses).toBe(3)
})

test('a reference is worked out per mode, so an edit lands on the variable that mode uses', () => {
  const snapshot = snapshotFrom(
    [
      decl(':root', '--blue-600', '#2563eb'),
      decl(':root', '--blue-400', '#60a5fa'),
      decl(':root', '--primary', 'var(--blue-600)'),
      decl('.dark', '--primary', 'var(--blue-400)'),
      decl(':root', '--accent', 'var(--blue-600)'),
      decl('.dark', '--accent', '#f00'),
    ],
    {},
    {},
    new Set(),
    new Map(),
  )
  const find = (name: string) => snapshot.variables.find((v) => v.name === name)
  expect(find('--primary')?.refersTo).toEqual({ default: '--blue-600', dark: '--blue-400' })
  expect(find('--primary')?.resolved).toEqual({ default: '#2563eb', dark: '#60a5fa' })
  // A literal in dark is edited in place, not through the default's reference.
  expect(find('--accent')?.refersTo).toEqual({ default: '--blue-600', dark: null })
  expect(find('--blue-600')?.refersTo).toEqual({ default: null, dark: null })
})

test("a reference cycle falls back to the page's computed value", () => {
  const snapshot = snapshotFrom(
    [decl(':root', '--a', 'var(--b)'), decl(':root', '--b', 'var(--a)')],
    { default: { '--a': '1px' } },
    {},
    new Set(),
    new Map(),
  )
  expect(snapshot.variables.find((v) => v.name === '--a')?.resolved.default).toBe('1px')
})

test('unsafe names, values and modes from the page are dropped', () => {
  const snapshot = snapshotFrom(
    [
      decl(':root', '--ok', 'red'),
      decl(':root', '--bad', 'red;} body{display:none'),
      decl(':root', '--style', '</style><script>'),
      decl(':root', '--x y', 'red'),
      decl("[data-theme='x\"] body']", '--ok', 'blue'),
    ],
    { default: { '--ok': 'red;}' } },
    {},
    new Set(),
    new Map(),
  )
  expect(snapshot.modes.map((mode) => mode.id)).toEqual(['default'])
  expect(snapshot.variables.map((v) => v.name)).toEqual(['--ok'])
  expect(snapshot.variables[0].resolved.default).toBe('red')
})

test('previewing a dark value overrides it in the dark selector only', async () => {
  const { tokens, sent } = preview()
  await tokens.loaded()
  await tokens.preview({ name: '--brand', mode: 'dark', value: '#7c3aed' })
  expect(sent.at(-1)).toContain('.dark { --brand: #7c3aed !important; }')
  expect(sent.at(-1)).not.toContain(':root {')
  expect(tokens.pending()).toEqual([{ name: '--brand', mode: 'dark', value: '#7c3aed' }])
})

test("a default edit doesn't leak into a mode that sets its own value", async () => {
  const { tokens, sent } = preview()
  await tokens.loaded()
  await tokens.preview({ name: '--brand', mode: 'default', value: '#000' })
  const css = sent.at(-1) as string
  expect(css).toContain(':root { --brand: #000 !important; }')
  expect(css.indexOf('.dark { --brand: #60a5fa !important; }')).toBeGreaterThan(
    css.indexOf(':root'),
  )
})

test('a hostile value is refused and nothing is sent', async () => {
  const { tokens, sent } = preview()
  await tokens.loaded()
  for (const value of ['red;} body{display:none', '</style><script>', 'calc(1px'])
    await expect(tokens.preview({ name: '--brand', mode: 'dark', value })).rejects.toThrow()
  await expect(tokens.preview({ name: '--x}', mode: 'dark', value: 'red' })).rejects.toThrow()
  expect(sent).toEqual([])
  expect(tokens.pending()).toEqual([])
})

test('a reload while open puts the pending override back', async () => {
  const { tokens, sent } = preview()
  await tokens.loaded()
  tokens.open = true
  await tokens.preview({ name: '--brand', mode: 'dark', value: '#7c3aed' })
  sent.length = 0
  await tokens.loaded()
  expect(sent.some((e) => e.includes('.dark { --brand: #7c3aed !important; }'))).toBe(true)
})

test('closing drops the pending edits and removes the override', async () => {
  const { tokens, sent } = preview()
  await tokens.loaded()
  tokens.open = true
  await tokens.preview({ name: '--brand', mode: 'dark', value: '#7c3aed' })
  tokens.open = false
  await wait(0)
  expect(sent).toContain(REMOVE_PREVIEW)
  expect(tokens.pending()).toEqual([])
})

test('a read that lands after the opening closed changes nothing', async () => {
  const { tokens, state } = preview()
  await tokens.loaded()
  const before = tokens.latest()
  let release!: () => void
  state.hold = new Promise((resolve) => {
    release = resolve
  })
  const reading = tokens.loaded()
  state.live = false
  release()
  await reading
  expect(tokens.latest()).toBe(before)
})

test('showing a mode the app takes back marks it as set by the app', async () => {
  const { tokens, sent, state } = preview()
  await tokens.loaded()
  const changes: string[][] = []
  tokens.onChange((snapshot) => changes.push(snapshot.appSetsMode))
  state.modeKept = false
  await tokens.showMode('dark')
  expect(sent.at(-1)).toContain('"dark":true')
  await wait(350)
  expect(tokens.latest()?.appSetsMode).toEqual(['dark'])
  expect(changes.at(-1)).toEqual(['dark'])
})

test('a media mode is emulated while shown and not after the opening closes', async () => {
  const read = {
    ...READ,
    declarations: [
      decl(':root', '--brand', '#2563eb'),
      decl(':root', '--brand', '#60a5fa', '(prefers-color-scheme: dark)'),
    ],
  }
  const { tokens, sent } = preview(read)
  await tokens.loaded()
  tokens.open = true
  await tokens.preview({ name: '--brand', mode: 'dark', value: '#7c3aed' })
  expect(sent.at(-1)).toContain(
    '@media (prefers-color-scheme: dark) { :root { --brand: #7c3aed !important; } }',
  )
  sent.length = 0
  await tokens.showMode('dark')
  expect(sent).toContain('Emulation.setEmulatedMedia')
  sent.length = 0
  tokens.dispose()
  await wait(0)
  expect(sent).toEqual(['Emulation.setEmulatedMedia'])
})

test('a variable declared in two files is locked with the reason', async () => {
  dir = await mkdtemp(join(tmpdir(), 'gui-design-tokens-'))
  await writeFile(join(dir, 'a.css'), ':root { --brand: #2563eb; }')
  await writeFile(join(dir, 'b.css'), ':root { --brand: #2563eb; }\n:root { --muted: #64748b; }')
  const { tokens } = preview(READ, dir)
  await tokens.loaded()
  const locked = (name: string) => tokens.latest()?.variables.find((v) => v.name === name)?.locked
  expect(locked('--brand')).toBe('Declared in 2 files: a.css, b.css')
  expect(locked('--muted')).toBeNull()
  expect(locked('--primary')).toBe('Not in a plain .css file')
})

test('the opening disposes its design tokens', () => {
  const resources = new ProjectResources({ release: () => {}, retire: () => {} })
  let disposed = false
  resources.designTokens = { dispose: () => (disposed = true) } as never
  void resources.dispose()
  expect(disposed).toBe(true)
  expect(resources.designTokens).toBeNull()
})

const KEPT_CSS =
  ':root {\n  --brand: #2563eb;\n  --muted: #64748b;\n  --primary: var(--brand);\n}\n.dark {\n  --brand: #60a5fa;\n}\n'

/** A chat that takes the write as a turn, or refuses as one whose agent is working. */
function chat(busy = false, beforeWrite: () => Promise<void> = async () => {}) {
  const turns: unknown[][] = []
  return {
    turns,
    writeThemeEdits: async (edits: unknown[], write: () => Promise<boolean>) => {
      if (busy) return false
      await beforeWrite()
      if (!(await write())) return false
      turns.push(edits)
      return true
    },
  }
}

async function keepable() {
  dir = await mkdtemp(join(tmpdir(), 'gui-design-tokens-'))
  await writeFile(join(dir, 'app.css'), KEPT_CSS)
  const page = preview(READ, dir)
  await page.tokens.loaded()
  page.tokens.open = true
  await page.tokens.preview({ name: '--brand', mode: 'default', value: '#7c3aed' })
  await page.tokens.preview({ name: '--muted', mode: 'dark', value: '#94a3b8' })
  return { ...page, css: () => readFile(join(dir as string, 'app.css'), 'utf8') }
}

test('Keep writes every pending edit as one turn, and the preview style goes on the next load', async () => {
  const { tokens, sent, css } = await keepable()
  const kept = chat()
  sent.length = 0
  expect(await tokens.keep(kept)).toEqual({ ok: true })
  expect(kept.turns).toEqual([
    [
      { name: '--brand', mode: 'default', before: '#2563eb', after: '#7c3aed', file: 'app.css' },
      { name: '--muted', mode: 'dark', before: '#64748b', after: '#94a3b8', file: 'app.css' },
    ],
  ])
  expect(await css()).toContain('--brand: #7c3aed;')
  expect(await css()).toContain('--muted: #94a3b8;')
  expect(tokens.pending()).toEqual([])
  // Until the page has the new values, the preview keeps showing them.
  expect(sent).not.toContain(REMOVE_PREVIEW)
  await tokens.loaded()
  expect(sent).toContain(REMOVE_PREVIEW)
})

test('Keep while the agent works writes nothing and keeps the pending edits', async () => {
  const { tokens, css } = await keepable()
  expect(await tokens.keep(chat(true))).toEqual({
    ok: false,
    blocked: '',
    reason: 'The agent is working. Keep again when it finishes.',
  })
  expect(await css()).toBe(KEPT_CSS)
  expect(tokens.pending()).toHaveLength(2)
})

test("Keep refused by the project's CSS says which variable and why", async () => {
  const { tokens, css } = await keepable()
  const twice = KEPT_CSS.replace('--muted: #64748b;', '--muted: #64748b;\n  --brand: #000;')
  const changed = chat(false, () => writeFile(join(dir as string, 'app.css'), twice))
  expect(await tokens.keep(changed)).toEqual({
    ok: false,
    blocked: '--brand',
    reason: 'Declared more than once in app.css',
  })
  expect(changed.turns).toEqual([])
  expect(await css()).toBe(twice)
  expect(tokens.pending()).toHaveLength(2)
})

test('Keep writes nothing and records no turn once the opening has closed', async () => {
  // Closed while Keep reads the project's CSS.
  {
    const { tokens, state, css } = await keepable()
    const kept = chat()
    const keeping = tokens.keep(kept)
    state.live = false
    expect(await keeping).toEqual({ ok: false, blocked: '', reason: 'The project was closed.' })
    expect(kept.turns).toEqual([])
    expect(await css()).toBe(KEPT_CSS)
  }
  // Closed while the chat waits to take its turn.
  {
    const { tokens, state, css } = await keepable()
    const kept = chat(false, async () => {
      state.live = false
    })
    expect(await tokens.keep(kept)).toEqual({
      ok: false,
      blocked: '',
      reason: 'The project was closed.',
    })
    expect(kept.turns).toEqual([])
    expect(await css()).toBe(KEPT_CSS)
  }
})
