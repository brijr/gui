import { chmod, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { MAX_THEME_CSS_BYTES, MAX_THEME_CSS_FILES } from '../shared/bounded'
import { modeOf, safeName, safeValue, type ThemeEdit, type ThemeMode } from '../shared/theme-tokens'
import { writeTemp } from './atomic-file'

// Keep rewrites the user's own CSS, so it is strict: a value is rewritten only where its
// declaration is found exactly once, directly inside a mode's block, in a plain .css file.
// A missing mode override is added only to the one block that mode already has. Anything
// else (nested rules, @supports, preprocessors, dependencies) is locked.

/** A project CSS file; `path` is relative to the project root. */
export interface CssFile {
  path: string
  text: string
}

/**
 * `start`/`end` bound the value text alone, trimmed. With `insert`, the mode has no
 * declaration yet: `start === end` is where one goes, written `before + value + after`.
 */
export type Located =
  | {
      ok: true
      file: string
      start: number
      end: number
      value: string
      insert?: { before: string; after: string }
    }
  | { ok: false; reason: string }

const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  '.svelte-kit',
  '.nuxt',
  '.output',
  '.vercel',
  '.turbo',
  'coverage',
])

async function cssFiles(root: string, limit: number) {
  const found: string[] = []
  let skipped = false
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (found.length >= limit) return
      const path = join(dir, entry.name)
      // Dirents don't follow symlinks, so nothing outside the root is listed.
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(path)
      } else if (entry.isFile() && entry.name.endsWith('.css')) {
        const size = await stat(path).then(
          (s) => s.size,
          () => Infinity,
        )
        if (size <= MAX_THEME_CSS_BYTES) found.push(relative(root, path).split(sep).join('/'))
        else skipped = true
      }
    }
  }
  await walk(root)
  return { paths: found.sort(), skipped }
}

/** Plain .css files under `root`, relative to it, outside dependency and build folders. */
export const listCssFiles = async (root: string) =>
  (await cssFiles(root, MAX_THEME_CSS_FILES)).paths

/**
 * Those files, read. `complete` is false when a file was too big or there were too many,
 * so a second declaration could be in one Gui didn't read.
 */
export async function readCssFiles(root: string) {
  const { paths, skipped } = await cssFiles(root, MAX_THEME_CSS_FILES + 1)
  const tooMany = paths.length > MAX_THEME_CSS_FILES
  const files: CssFile[] = await Promise.all(
    paths.slice(0, MAX_THEME_CSS_FILES).map(async (path) => ({
      path,
      text: await readFile(join(root, path), 'utf8'),
    })),
  )
  const incomplete = tooMany
    ? 'The project has too many .css files'
    : skipped
      ? 'The project has a .css file too big to read'
      : null
  return { files, incomplete }
}

/** `text` with every comment blanked to spaces, so offsets stay the same. */
function blankComments(text: string) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2)
      const end = close < 0 ? text.length : close + 2
      out += text.slice(i, end).replace(/[^\n]/g, ' ')
      i = end
    } else if (ch === '"' || ch === "'") {
      const end = stringEnd(text, i)
      out += text.slice(i, end)
      i = end
    } else {
      out += ch
      i++
    }
  }
  return out
}

/** Index just past the string starting at `i`; an unclosed string ends at its line. */
function stringEnd(text: string, i: number) {
  const quote = text[i]
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++
    else if (text[j] === quote || text[j] === '\n') return j + 1
  }
  return text.length
}

/** The mode a block's preludes (outermost first) belong to, when Keep may write there. */
function blockMode(preludes: string[]): string | null {
  const [outer, inner] = preludes
  if (preludes.length === 1) {
    if (/^@theme(?:\s[\w\s-]*)?$/.test(outer)) return 'default'
    return outer.startsWith('@') ? null : (modeOf(outer, null)?.id ?? null)
  }
  if (preludes.length !== 2 || inner.startsWith('@')) return null
  if (/^@media\s/i.test(outer)) return modeOf(inner, outer.slice(6).trim())?.id ?? null
  if (/^@layer\s+[\w.-]+$/.test(outer)) return modeOf(inner, null)?.id ?? null
  return null
}

interface Declaration {
  name: string
  mode: string | null
  file: string
  start: number
  end: number
  awkward: boolean
}

/** A block's last statement: `end` is past its trimmed text, `semicolon` past its `;`. */
interface Last {
  start: number
  end: number
  semicolon: number | null
}

interface Block {
  mode: string | null
  file: string
  open: number
  nested: boolean
  last: Last | null
}

const scans = new WeakMap<CssFile, ReturnType<typeof scanFile>>()

/** `scanFile`, once per file read: locks locate every variable in every mode. */
function scan(file: CssFile) {
  const found = scans.get(file) ?? scanFile(file)
  scans.set(file, found)
  return found
}

/** Every custom property declaration in `file`, and every block, with the mode each is in. */
function scanFile(file: CssFile) {
  const { text } = file
  const clean = blankComments(text)
  const found: Declaration[] = []
  const blocks: Block[] = []
  const stack: (Block & { prelude: string })[] = []
  let statement = 0
  let parens = 0
  const endStatement = (end: number, semicolon: boolean) => {
    const block = stack.at(-1)
    const body = clean.slice(statement, end)
    if (!block || !body.trim()) return
    const first = statement + body.search(/\S/)
    block.last = {
      start: first,
      end: first + body.trim().length,
      semicolon: semicolon ? end + 1 : null,
    }
    const match = /^\s*(--[A-Za-z0-9_-]+)\s*:/.exec(body)
    if (!match) return
    let start = statement + match[0].length
    const commented = text.slice(start, end) !== clean.slice(start, end)
    let stop = end
    while (start < stop && /\s/.test(clean[start])) start++
    while (stop > start && /\s/.test(clean[stop - 1])) stop--
    found.push({
      name: match[1],
      mode: block.mode,
      file: file.path,
      start,
      end: stop,
      awkward: commented || /!\s*important/i.test(text.slice(start, stop)),
    })
  }
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]
    if (ch === '"' || ch === "'") i = stringEnd(clean, i) - 1
    else if (ch === '(') parens++
    else if (ch === ')') parens = Math.max(0, parens - 1)
    else if (parens > 0) continue
    else if (ch === '{') {
      const preludes = [...stack.map((b) => b.prelude), clean.slice(statement, i).trim()]
      const parent = stack.at(-1)
      if (parent) parent.nested = true
      stack.push({
        prelude: preludes.at(-1) as string,
        mode: blockMode(preludes),
        file: file.path,
        open: i,
        nested: false,
        last: null,
      })
      statement = i + 1
    } else if (ch === ';' || ch === '}') {
      endStatement(i, ch === ';')
      if (ch === '}') {
        const block = stack.pop()
        if (block) blocks.push(block)
      }
      statement = i + 1
    }
  }
  return { found, blocks }
}

/** Where a new `name` goes as the last declaration of `block`, in the block's own layout. */
function insertion(text: string, block: Block, name: string): Located {
  const last = block.last as Last
  const lineStart = text.lastIndexOf('\n', last.start - 1) + 1
  const indent = text.slice(lineStart, last.start)
  const gap = lineStart > block.open && /^[ \t]*$/.test(indent) ? `\n${indent}` : ' '
  const at = last.semicolon ?? last.end
  return {
    ok: true,
    file: block.file,
    start: at,
    end: at,
    value: '',
    insert:
      last.semicolon === null
        ? { before: `;${gap}${name}: `, after: '' }
        : { before: `${gap}${name}: `, after: ';' },
  }
}

/**
 * The one declaration of `name` in `mode`'s block across `files`, or why there isn't one.
 * A mode with no declaration of a variable the default declares once gets one added to its
 * only block.
 */
export function locate(files: CssFile[], name: string, mode: ThemeMode): Located {
  const scans = files.map(scan)
  const named = scans.flatMap((s) => s.found.filter((d) => d.name === name))
  const hits = named.filter((d) => d.mode === mode.id)
  if (hits.length === 0) {
    const declared = named.filter((d) => d.mode === 'default').length === 1
    if (mode.id === 'default' || !declared) return { ok: false, reason: 'Not in a plain .css file' }
    const blocks = scans.flatMap((s) => s.blocks.filter((b) => b.mode === mode.id))
    if (blocks.length !== 1) {
      return {
        ok: false,
        reason: blocks.length
          ? `${mode.label} is set in more than one place`
          : `No ${mode.label} block to add it to`,
      }
    }
    const [block] = blocks
    if (block.nested || !block.last) {
      return { ok: false, reason: `Can't add to the ${mode.label} block` }
    }
    return insertion(files.find((f) => f.path === block.file)?.text ?? '', block, name)
  }
  if (hits.length > 1) {
    const where = [...new Set(hits.map((hit) => hit.file))]
    return {
      ok: false,
      reason:
        where.length > 1
          ? `Declared in ${where.length} files: ${where.join(', ')}`
          : `Declared more than once in ${where[0]}`,
    }
  }
  const [hit] = hits
  if (hit.awkward) return { ok: false, reason: 'Its value has a comment or !important' }
  const text = files.find((file) => file.path === hit.file)?.text ?? ''
  return {
    ok: true,
    file: hit.file,
    start: hit.start,
    end: hit.end,
    value: text.slice(hit.start, hit.end),
  }
}

/**
 * Writes every edit or none. Files are read fresh, every edit must still locate, and each
 * changed file is replaced whole by rename, keeping its permissions.
 */
export async function writeThemeEdits(
  root: string,
  edits: ThemeEdit[],
  modes: ThemeMode[],
): Promise<{ ok: true; files: string[] } | { ok: false; blocked: string; reason: string }> {
  for (const edit of edits) {
    if (!safeName(edit.name))
      return { ok: false, blocked: edit.name, reason: 'Not a variable name' }
    if (!safeValue(edit.value))
      return {
        ok: false,
        blocked: edit.name,
        reason: 'Not a value Gui can write',
      }
    if (!modes.some((mode) => mode.id === edit.mode)) {
      return { ok: false, blocked: edit.name, reason: 'Unknown theme mode' }
    }
  }
  const modeOfEdit = (edit: ThemeEdit) => modes.find((mode) => mode.id === edit.mode) as ThemeMode
  const blocked = (edit: ThemeEdit | undefined, reason: string) =>
    ({ ok: false, blocked: edit?.name ?? '', reason }) as const
  const keys = edits.map((edit) => `${edit.mode} ${edit.name}`)
  const twice = edits.find((_, i) => keys.indexOf(keys[i]) !== i)
  if (twice) return blocked(twice, 'Edited twice')
  // A file Gui doesn't read could hold a second declaration, so "exactly once" can't be proven.
  const { files, incomplete } = await readCssFiles(root)
  if (incomplete) return blocked(edits[0], incomplete)
  const splices = new Map<string, { start: number; end: number; text: string }[]>()
  for (const edit of edits) {
    const found = locate(files, edit.name, modeOfEdit(edit))
    if (!found.ok) return blocked(edit, found.reason)
    const text = found.insert ? found.insert.before + edit.value + found.insert.after : edit.value
    splices.set(found.file, [
      ...(splices.get(found.file) ?? []),
      { start: found.start, end: found.end, text },
    ])
  }
  const written = files.map((file) => {
    let text = file.text
    for (const s of [...(splices.get(file.path) ?? [])].sort((a, b) => b.start - a.start)) {
      text = text.slice(0, s.start) + s.text + text.slice(s.end)
    }
    return { path: file.path, text }
  })
  // A value that passes safeValue could still unbalance the file (an open paren); read it back.
  for (const edit of edits) {
    const after = locate(written, edit.name, modeOfEdit(edit))
    if (!after.ok || after.insert || after.value !== edit.value) {
      return blocked(edit, 'The new value would change the CSS around it')
    }
  }
  const temps: { tmp: string; file: string }[] = []
  try {
    for (const { path, text } of written) {
      if (!splices.has(path)) continue
      const file = join(root, path)
      const tmp = await writeTemp(file, text)
      temps.push({ tmp, file })
      await chmod(tmp, (await stat(file)).mode & 0o7777)
    }
    // shortcut: a rename failing midway leaves earlier files written with no turn recorded, so
    // no Undo, upgrade to putting the originals back if Keep often writes several files.
    while (temps.length) {
      const { tmp, file } = temps[0]
      await rename(tmp, file)
      temps.shift()
    }
  } catch (error) {
    await Promise.all(temps.map(({ tmp }) => rm(tmp, { force: true }).catch(() => undefined)))
    throw error
  }
  return { ok: true, files: [...splices.keys()] }
}
