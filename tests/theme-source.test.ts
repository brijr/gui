import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { listCssFiles, locate, writeThemeEdits } from '../src/main/theme-source'
import { MAX_THEME_CSS_BYTES } from '../src/shared/bounded'
import { modeOf, type ThemeMode } from '../src/shared/theme-tokens'

// Keep writes the user's own CSS, so a declaration is rewritten only when it is found exactly
// once in a plain .css file; anything else is refused and nothing is written.

const DEFAULT = modeOf(':root', null) as ThemeMode
const DARK = modeOf('.dark', null) as ThemeMode
const MODES = [DEFAULT, DARK]

let dir: string | null = null
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = null
})

async function project(files: Record<string, string>) {
  dir = await mkdtemp(join(tmpdir(), 'gui-theme-source-'))
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), text)
  }
  return dir
}

const read = (path: string) => readFile(join(dir as string, path), 'utf8')

test('a :root value is rewritten and nothing else in the file changes', async () => {
  const text =
    '/* brand */\n:root {\n  --brand: #2563eb;\n  --ink:   #111;\n}\n\n.card { color: var(--brand); }\n'
  const root = await project({ 'src/globals.css': text })
  const result = await writeThemeEdits(
    root,
    [{ name: '--brand', mode: 'default', value: '#7c3aed' }],
    MODES,
  )
  expect(result).toEqual({ ok: true, files: ['src/globals.css'] })
  expect(await read('src/globals.css')).toBe(text.replace('#2563eb', '#7c3aed'))
})

test('the file keeps its permissions', async () => {
  const root = await project({ 'a.css': ':root { --brand: #2563eb; }' })
  const before = (await stat(join(root, 'a.css'))).mode
  await writeThemeEdits(root, [{ name: '--brand', mode: 'default', value: 'red' }], MODES)
  expect((await stat(join(root, 'a.css'))).mode).toBe(before)
})

test('a .dark value without a trailing semicolon is rewritten; :root is untouched', async () => {
  const text = ':root { --brand: #2563eb; }\n.dark { --brand: #60a5fa }\n'
  const root = await project({ 'a.css': text })
  const result = await writeThemeEdits(
    root,
    [{ name: '--brand', mode: 'dark', value: '#a78bfa' }],
    MODES,
  )
  expect(result.ok).toBe(true)
  expect(await read('a.css')).toBe(':root { --brand: #2563eb; }\n.dark { --brand: #a78bfa }\n')
})

test('the located range is the value alone', () => {
  const text = '.dark { --brand:  #60a5fa  }'
  const found = locate([{ path: 'a.css', text }], '--brand', DARK)
  if (!found.ok) throw new Error(found.reason)
  expect(text.slice(found.start, found.end)).toBe('#60a5fa')
  expect(found.value).toBe('#60a5fa')
  expect(found.file).toBe('a.css')
})

test('@theme counts as the default mode', () => {
  const text = '@import "tailwindcss";\n@theme {\n  --color-brand: oklch(0.6 0.2 260);\n}\n'
  const found = locate([{ path: 'app.css', text }], '--color-brand', DEFAULT)
  expect(found).toMatchObject({ ok: true, value: 'oklch(0.6 0.2 260)' })
})

test('a :root inside a dark color-scheme media query is the media dark mode', () => {
  const text =
    ':root { --brand: #fff; }\n@media (prefers-color-scheme: dark) {\n  :root { --brand: #000; }\n}\n'
  const media = modeOf(':root', '(prefers-color-scheme: dark)') as ThemeMode
  expect(locate([{ path: 'a.css', text }], '--brand', media)).toMatchObject({
    ok: true,
    value: '#000',
  })
  expect(locate([{ path: 'a.css', text }], '--brand', DEFAULT)).toMatchObject({
    ok: true,
    value: '#fff',
  })
})

test('data-theme blocks match their own mode', () => {
  const text = "[data-theme='ocean'] { --brand: teal; }"
  const ocean = modeOf("[data-theme='ocean']", null) as ThemeMode
  expect(locate([{ path: 'a.css', text }], '--brand', ocean)).toMatchObject({
    ok: true,
    value: 'teal',
  })
})

test('a variable declared in two files, or twice in one block, is refused', () => {
  const a = { path: 'a.css', text: ':root { --brand: red; }' }
  const b = { path: 'b.css', text: ':root { --brand: blue; }' }
  const both = locate([a, b], '--brand', DEFAULT)
  expect(both.ok).toBe(false)
  if (!both.ok) expect(both.reason).toBe('Declared in 2 files: a.css, b.css')
  const twice = locate(
    [{ path: 'a.css', text: ':root { --brand: red; --brand: blue; }' }],
    '--brand',
    DEFAULT,
  )
  expect(twice.ok).toBe(false)
})

test('names are matched whole, comments and strings are skipped', () => {
  const text = [
    '/* :root { --brand: no; } */',
    ':root { --brand-2: x; content: "--brand: no; }"; }',
    '/* light */ :root { --brand : url(data:image/png;base64,AA==) }',
  ].join('\n')
  const found = locate([{ path: 'a.css', text }], '--brand', DEFAULT)
  expect(found).toMatchObject({
    ok: true,
    value: 'url(data:image/png;base64,AA==)',
  })
})

test('nested blocks, other at-rules and awkward values are locked', () => {
  const at = (text: string) => locate([{ path: 'a.css', text }], '--brand', DEFAULT).ok
  expect(at('.x { :root { --brand: red; } }')).toBe(false)
  expect(at('@supports (color: red) { :root { --brand: red; } }')).toBe(false)
  expect(at('@layer base { @media print { :root { --brand: red; } } }')).toBe(false)
  expect(at('@custom-variant dark { --brand: red; }')).toBe(false)
  expect(at(':root { .x { --brand: red; } }')).toBe(false)
  expect(at(':root { --brand: red !important; }')).toBe(false)
  expect(at(':root { --brand: red /* why */; }')).toBe(false)
  expect(at(':root { --brand: red; }')).toBe(true)
})

test('only plain .css outside dependency and build folders is listed', async () => {
  const root = await project({
    'node_modules/pkg/x.css': ':root { --brand: red; }',
    'src/x.scss': ':root { --brand: red; }',
    'dist/x.css': ':root { --brand: red; }',
    '.git/x.css': ':root { --brand: red; }',
    'src/app.css': ':root { --ink: black; }',
  })
  expect(await listCssFiles(root)).toEqual(['src/app.css'])
  const result = await writeThemeEdits(
    root,
    [{ name: '--brand', mode: 'default', value: 'blue' }],
    MODES,
  )
  expect(result).toMatchObject({ ok: false, blocked: '--brand' })
  expect(await read('node_modules/pkg/x.css')).toBe(':root { --brand: red; }')
})

test('when one edit no longer locates, no file is written', async () => {
  const root = await project({
    'a.css': ':root { --first: red; }',
    'b.css': ':root { --second: red; }',
  })
  await writeFile(join(root, 'b.css'), ':root { --renamed: red; }')
  const result = await writeThemeEdits(
    root,
    [
      { name: '--first', mode: 'default', value: 'blue' },
      { name: '--second', mode: 'default', value: 'blue' },
    ],
    MODES,
  )
  expect(result).toMatchObject({ ok: false, blocked: '--second' })
  expect(await read('a.css')).toBe(':root { --first: red; }')
})

test('two edits in one file are both applied', async () => {
  const root = await project({
    'a.css': ':root { --a: 1px; --b: 2px; }\n.dark { --a: 3px; }',
  })
  const result = await writeThemeEdits(
    root,
    [
      { name: '--a', mode: 'default', value: '10px' },
      { name: '--b', mode: 'default', value: '20px' },
      { name: '--a', mode: 'dark', value: '30px' },
    ],
    MODES,
  )
  expect(result).toEqual({ ok: true, files: ['a.css'] })
  expect(await read('a.css')).toBe(':root { --a: 10px; --b: 20px; }\n.dark { --a: 30px; }')
})

test('an unsafe value, name or unknown mode writes nothing', async () => {
  const text = ':root { --brand: red; }'
  const root = await project({ 'a.css': text })
  for (const edit of [
    { name: '--brand', mode: 'default', value: 'red; } body { display: none' },
    { name: '--brand', mode: 'default', value: 'red /* x' },
    { name: 'brand', mode: 'default', value: 'red' },
    { name: '--brand', mode: 'theme:nope', value: 'red' },
  ]) {
    expect(await writeThemeEdits(root, [edit], MODES)).toMatchObject({
      ok: false,
      blocked: edit.name,
    })
  }
  expect(await read('a.css')).toBe(text)
})

test('one level of @layer is a wrapper, like shadcn puts :root and .dark in @layer base', () => {
  const files = [
    { path: 'a.css', text: '@layer base { :root { --brand: #111 } .dark { --brand: #eee } }' },
  ]
  expect(locate(files, '--brand', DEFAULT)).toMatchObject({ ok: true, value: '#111' })
  expect(locate(files, '--brand', DARK)).toMatchObject({ ok: true, value: '#eee' })
})

test('a value that would unbalance the file is refused after the splice', async () => {
  const text = ':root { --brand: red; --ink: #111; }'
  const root = await project({ 'a.css': text })
  const result = await writeThemeEdits(
    root,
    [{ name: '--brand', mode: 'default', value: 'rgb(1, 2, 3' }],
    MODES,
  )
  expect(result).toMatchObject({ ok: false, blocked: '--brand' })
  expect(await read('a.css')).toBe(text)
})

test('a missing dark override is added as the last declaration of the one .dark block', async () => {
  const root = await project({
    'a.css': ':root {\n  --brand: #2563eb;\n  --ink: #111;\n}\n\n.dark {\n  --ink: #eee;\n}\n',
    'b.css': '[data-theme="ocean"] { --ink: navy; }\n',
    'c.css': '[data-theme="sand"] { --ink: tan }\n',
  })
  const ocean = modeOf('[data-theme="ocean"]', null) as ThemeMode
  const sand = modeOf('[data-theme="sand"]', null) as ThemeMode
  const result = await writeThemeEdits(
    root,
    [
      { name: '--brand', mode: 'dark', value: '#60a5fa' },
      { name: '--brand', mode: ocean.id, value: 'teal' },
      { name: '--brand', mode: sand.id, value: 'peru' },
    ],
    [...MODES, ocean, sand],
  )
  expect(result).toEqual({ ok: true, files: ['a.css', 'b.css', 'c.css'] })
  expect(await read('a.css')).toBe(
    ':root {\n  --brand: #2563eb;\n  --ink: #111;\n}\n\n.dark {\n  --ink: #eee;\n  --brand: #60a5fa;\n}\n',
  )
  expect(await read('b.css')).toBe('[data-theme="ocean"] { --ink: navy; --brand: teal; }\n')
  expect(await read('c.css')).toBe('[data-theme="sand"] { --ink: tan; --brand: peru }\n')
})

test('an override is not added without exactly one mode block and one default declaration', () => {
  const at = (...texts: string[]) =>
    locate(
      texts.map((text, i) => ({ path: `${i}.css`, text })),
      '--brand',
      DARK,
    )
  expect(at(':root { --brand: red; }')).toMatchObject({
    ok: false,
    reason: 'No Dark block to add it to',
  })
  expect(at(':root { --brand: red; }', '.dark { --a: 1; }', '.dark { --b: 1; }')).toMatchObject({
    ok: false,
    reason: 'Dark is set in more than one place',
  })
  expect(at('.dark { --a: 1; }').ok).toBe(false)
  expect(at(':root { --brand: red; }', ':root { --brand: blue; }', '.dark { --a: 1; }').ok).toBe(
    false,
  )
  expect(locate([{ path: 'a.css', text: ':root { --a: 1; }' }], '--brand', DEFAULT).ok).toBe(false)
})

test('a .css file too big to read blocks every write', async () => {
  const root = await project({
    'a.css': ':root { --brand: red; }',
    'big.css': `/* ${'x'.repeat(MAX_THEME_CSS_BYTES)} */`,
  })
  expect(await listCssFiles(root)).toEqual(['a.css'])
  const result = await writeThemeEdits(
    root,
    [{ name: '--brand', mode: 'default', value: 'blue' }],
    MODES,
  )
  expect(result).toMatchObject({ ok: false, blocked: '--brand' })
  expect(await read('a.css')).toBe(':root { --brand: red; }')
})
