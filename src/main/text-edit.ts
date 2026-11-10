import { readFile, stat, writeFile } from 'node:fs/promises'

/** Source files larger than this aren't rewritten in place; the agent edits them. */
const MAX_SOURCE_BYTES = 2_000_000
/** How far below an element's tag its text may sit and still be the one meant (JSX wraps). */
const NEAR_LINES = 12
/**
 * The files page copy is rewritten in: JSX, Astro and HTML, whose rules for text the checks
 * below know. The page says which file wrote an element, so every other file in the project
 * (config, scripts, data, other languages' templates) is the agent's to change.
 */
const REWRITABLE = /\.(?:jsx?|tsx|astro|html?)$/i
/** An opening tag longer than this isn't looked for; the agent takes the edit. */
const MAX_TAG = 2000
/** Elements whose content is code rather than text. */
const CODE_ELEMENTS = new Set(['script', 'style'])
const CLOSING_TAG = /^<\/([A-Za-z][\w.:-]*)\s*>/
/**
 * What is never plain text somewhere this text could land: markup and expression delimiters
 * (HTML, JSX, Astro, templates built on braces), anything a later reader would decode (a
 * backslash escape, a character reference with or without its semicolon, a percent escape),
 * a comment's end, and control characters.
 */
const NOT_PLAIN = /[<>{}\\]|&[#a-z0-9]|%[0-9a-f]{2}|\*\/|\p{Cc}/iu
const QUOTES = ['"', "'", '`']

/** Text as the page shows it: runs of whitespace are one space, none at either end. */
export function collapseText(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * `source` with the page copy `before` rewritten as `after`, or null when that can't be done
 * safely by hand. Both texts come from the page, whose scripts can set them to anything, so
 * this only ever swaps plain text for plain text:
 *
 * - `before` must be all that an element holds, between its own opening and closing tags
 *   (`<h1 …>` and `</h1>`, whitespace aside). Text anywhere else (a string, an attribute, a
 *   comment, code that happens to read the same) isn't touched.
 * - It must be there once, or once near `line` (where the element was written).
 * - Neither text may hold anything that isn't literal wherever markup can sit: see
 *   `NOT_PLAIN`, and a quote that could end a string or attribute the markup is inside.
 *
 * Whitespace in the source may differ from the page's (JSX and HTML wrap lines), so it
 * matches any run of it.
 */
export function replaceText(
  source: string,
  before: string,
  after: string,
  line: number | null,
): string | null {
  const old = collapseText(before)
  const next = collapseText(after)
  if (!old || next === old) return null
  const pattern = new RegExp(old.split(' ').map(escapeRegExp).join('\\s+'), 'g')
  const found: { start: number; end: number }[] = []
  for (const match of source.matchAll(pattern)) {
    const start = match.index
    const end = start + match[0].length
    if (isElementText(source, start, end)) found.push({ start, end })
  }
  let target = found.length === 1 ? found[0] : null
  if (!target && found.length > 1 && line !== null) {
    const near = found.filter(({ start }) => {
      const at = lineOf(source, start)
      return at >= line && at <= line + NEAR_LINES
    })
    if (near.length === 1) target = near[0]
  }
  if (!target) return null
  const { start, end } = target
  if (!isPlain(old, source, start, end) || !isPlain(next, source, start, end)) return null
  return source.slice(0, start) + next + source.slice(end)
}

/**
 * Whether `source` from `start` to `end` is all an element holds: whitespace aside, its
 * opening tag ends right before and the closing tag of the same name follows. A code
 * element's content (`<script>`, `<style>`) isn't text.
 */
function isElementText(source: string, start: number, end: number) {
  let after = end
  while (/\s/.test(source[after] ?? '')) after++
  if (source[after] !== '<') return false
  let before = start
  while (before > 0 && /\s/.test(source[before - 1])) before--
  if (source[before - 1] !== '>') return false
  const name = CLOSING_TAG.exec(source.slice(after, after + MAX_TAG))?.[1]
  if (!name || CODE_ELEMENTS.has(name.toLowerCase())) return false
  // The nearest `<` before the text starts the tag that ends there: it has to be this
  // element's own, still open. A child's tag, a closing tag or a self-closed one isn't.
  const head = source.slice(Math.max(0, before - MAX_TAG), before)
  const tag = head.slice(head.lastIndexOf('<'))
  return (
    tag.startsWith(`<${name}`) && /^[\s>]/.test(tag.slice(name.length + 1)) && !tag.endsWith('/>')
  )
}

/**
 * Whether `text` stays literal text between `start` and `end` of `source`, whatever that
 * markup is inside. Markup can sit in a string or an attribute (`innerHTML = '<p>Hi</p>'`),
 * and only a quote that shows up on both sides of it could be closing one.
 */
function isPlain(text: string, source: string, start: number, end: number) {
  if (NOT_PLAIN.test(text)) return false
  return !QUOTES.some(
    (quote) =>
      text.includes(quote) &&
      source.lastIndexOf(quote, start - 1) !== -1 &&
      source.indexOf(quote, end) !== -1,
  )
}

/**
 * Rewrites the page copy `before` as `after` in `file`, as `replaceText` would; whether it
 * did. The dev server's hot reload, or the canvas's, shows the change.
 */
export async function rewriteText(
  file: string,
  before: string,
  after: string,
  line: number | null,
): Promise<boolean> {
  try {
    if (!REWRITABLE.test(file) || (await stat(file)).size > MAX_SOURCE_BYTES) return false
    const source = await readFile(file, 'utf8')
    const next = replaceText(source, before, after, line)
    if (next === null) return false
    await writeFile(file, next)
    return true
  } catch {
    return false
  }
}

function lineOf(source: string, index: number) {
  let line = 1
  for (let i = source.indexOf('\n'); i !== -1 && i < index; i = source.indexOf('\n', i + 1)) line++
  return line
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
