import { readFile, stat, writeFile } from 'node:fs/promises'

/** Source files larger than this aren't rewritten in place; the agent edits them. */
const MAX_SOURCE_BYTES = 2_000_000
/** How far below an element's tag its text may sit and still be the one meant (JSX wraps). */
const NEAR_LINES = 12
const QUOTES = new Set(['"', "'", '`'])
/** What may sit just before page copy in source: a tag's end, an expression's, a quote, a space. */
const BEFORE_TEXT = /[>}"'`\s]/
/** What may sit just after it. */
const AFTER_TEXT = /[<{"'`\s]/

/** Text as the page shows it: runs of whitespace are one space, none at either end. */
export function collapseText(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * `source` with the page copy `before` rewritten as `after`, or null when that can't be done
 * safely by hand: the text isn't there as written (it's built, translated, or escaped), it's
 * there more than once with no `line` (where the element was written) to tell which, or
 * `after` would need escaping where it lands. Whitespace in the source may differ from the
 * page's (JSX and HTML wrap lines), so it matches any run of it.
 */
export function replaceText(
  source: string,
  before: string,
  after: string,
  line: number | null,
): string | null {
  const words = collapseText(before).split(' ').filter(Boolean)
  const next = collapseText(after)
  if (!words.length || next === collapseText(before)) return null
  const pattern = new RegExp(words.map(escapeRegExp).join('\\s+'), 'g')
  const found: { start: number; end: number }[] = []
  for (const match of source.matchAll(pattern)) {
    const start = match.index
    const end = start + match[0].length
    const prev = source[start - 1]
    const following = source[end]
    if (prev !== undefined && !BEFORE_TEXT.test(prev)) continue
    if (following !== undefined && !AFTER_TEXT.test(following)) continue
    found.push({ start, end })
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
  const quote = source[target.start - 1]
  if (quote && QUOTES.has(quote) && source[target.end] === quote) {
    // A string literal: its own quote, an escape or a template's ${ would change its meaning.
    if (next.includes(quote) || next.includes('\\') || (quote === '`' && next.includes('${')))
      return null
  } else if (/[{}<>]/.test(next) || /&#?\w+;/.test(next)) {
    // Markup (JSX, HTML, a template): braces, angle brackets and entities aren't plain text there.
    return null
  }
  return source.slice(0, target.start) + next + source.slice(target.end)
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
    if ((await stat(file)).size > MAX_SOURCE_BYTES) return false
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
