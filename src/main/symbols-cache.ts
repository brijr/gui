import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { SymbolImages } from '../shared/symbols'
import { writeFileAtomic } from './atomic-file'

// What symbols.ts draws is kept in a file between launches. Nothing here needs Electron.

/**
 * Everything the drawing depends on, as one name: images kept under another are drawn again.
 * macOS redraws symbols between releases (`system`: its version and build); Gui and Electron
 * decide how they're drawn and encoded (`versions`); macOS rasterizes them for the display's
 * pixel density (`scales`: the primary display's, then every display's); and the list
 * itself, with the size, weight and faint-layer cut each is drawn at. Light or dark makes no
 * difference: the pixels come out the same.
 */
export function symbolsKey(from: {
  system: string[]
  versions: string[]
  scales: number[]
  drawing: unknown
  names: readonly string[]
}) {
  const { system, versions, scales, drawing, names } = from
  return createHash('sha256')
    .update(JSON.stringify([CACHE_FORMAT, system, versions, scales, drawing, names]))
    .digest('hex')
}

/** Bumped when the drawing changes in a way `symbolsKey` can't see. */
const CACHE_FORMAT = 1

const PNG_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/
const isSize = (value: unknown) => typeof value === 'number' && value > 0 && value < 100

/**
 * The images a cache file holds, when it is whole and was made from `key`. Null for
 * anything else (cut short, edited, made by another version or on another display, a
 * symbol the UI no longer has), which is drawn again.
 */
export function readSymbolsCache(
  text: string,
  key: string,
  names: readonly string[],
): SymbolImages | null {
  let cache: { key?: unknown; images?: unknown }
  try {
    cache = JSON.parse(text)
  } catch {
    return null
  }
  if (cache?.key !== key || !cache.images || typeof cache.images !== 'object') return null
  const entries = Object.entries(cache.images)
  const known = new Set(names)
  const whole = entries.every(
    ([name, image]) =>
      known.has(name) &&
      typeof image?.src === 'string' &&
      PNG_URL.test(image.src) &&
      isSize(image.width) &&
      isSize(image.height),
  )
  return whole && entries.length > 0 ? (cache.images as SymbolImages) : null
}

/**
 * The symbols in `file` when it was made from `key`, otherwise drawn now and kept there for
 * the next launch. A missing or unreadable file is only a reason to draw.
 */
export async function cachedSymbols(
  file: string,
  key: string,
  names: readonly string[],
  drawAll: () => Promise<SymbolImages>,
): Promise<SymbolImages> {
  const cached = await readFile(file, 'utf8').then(
    (text) => readSymbolsCache(text, key, names),
    () => null,
  )
  if (cached) return cached
  const drawn = await drawAll()
  // Nothing drawn is a failure, not a result to keep: the next launch tries again. The
  // write isn't waited for; the pages have their icons meanwhile.
  if (Object.keys(drawn).length > 0) {
    writeFileAtomic(file, JSON.stringify({ key, images: drawn })).catch((error: unknown) =>
      console.error('[gui] could not keep the drawn symbols', error),
    )
  }
  return drawn
}
