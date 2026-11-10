import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cachedSymbols, readSymbolsCache, symbolsKey } from '../src/main/symbols-cache'
import type { SymbolImages } from '../src/shared/symbols'

// symbols.ts draws the UI's SF Symbols with Electron's nativeImage, which holds the main
// thread for over a tenth of a second at launch, so what it drew is kept in a file. These are
// what that file is kept under, and what happens when it can't be used.

const NAMES = ['circle', 'folder', 'trash']
const PNG = 'data:image/png;base64,iVBORw0KGgo='
const IMAGES = {
  circle: { src: PNG, width: 1, height: 1 },
  folder: { src: PNG, width: 1.179, height: 0.911 },
} as SymbolImages

const dirs: string[] = []
const scratchFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'gui-symbols-'))
  dirs.push(dir)
  return join(dir, 'symbols.json')
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A drawing that counts how often it's asked for. */
const drawing = (images: SymbolImages = IMAGES) => {
  const draw = Object.assign(
    async () => {
      draw.calls++
      return images
    },
    { calls: 0 },
  )
  return draw
}

/** The cache is written behind the answer: what's in the file once it's there. */
async function kept(file: string, key: string) {
  for (let tries = 0; tries < 200; tries++) {
    try {
      const cache = JSON.parse(readFileSync(file, 'utf8'))
      if (cache.key === key && cache.images) return cache
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`No cache for ${key} in ${file}`)
}

describe('what a set of drawn symbols is kept under', () => {
  const from = {
    system: ['27.0.1', 'Darwin Kernel Version 27.0.0: Tue Aug 11'],
    versions: ['0.1.0-alpha.15', '44.10.1'],
    scales: [2, 2],
    drawing: [
      { pointSize: 48, weight: 'regular' },
      { low: 48, high: 112, share: 0.25 },
    ],
    names: NAMES,
  }

  test('the same inputs give the same key', () => {
    expect(symbolsKey(from)).toBe(symbolsKey(structuredClone(from)))
  })

  test('anything the drawing depends on changes it', () => {
    const others = [
      // macOS updated, or only its build did (a beta).
      { ...from, system: ['27.1', from.system[1]] },
      { ...from, system: [from.system[0], 'Darwin Kernel Version 27.0.0: Wed Sep 2'] },
      // Gui updated; Electron did.
      { ...from, versions: ['0.1.0-alpha.16', '44.10.1'] },
      { ...from, versions: ['0.1.0-alpha.15', '45.0.0'] },
      // Another primary display; a second display plugged in.
      { ...from, scales: [1, 2] },
      { ...from, scales: [2, 2, 1] },
      // The size, weight or faint-layer cut.
      { ...from, drawing: [{ pointSize: 64, weight: 'regular' }, from.drawing[1]] },
      { ...from, drawing: [{ pointSize: 48, weight: 'medium' }, from.drawing[1]] },
      { ...from, drawing: [from.drawing[0], { low: 48, high: 112, share: 0.5 }] },
      // A symbol added, dropped or swapped.
      { ...from, names: [...NAMES, 'gear'] },
      { ...from, names: NAMES.slice(1) },
      { ...from, names: ['circle', 'folder', 'trash.fill'] },
    ]
    const keys = new Set([from, ...others].map(symbolsKey))
    expect(keys.size).toBe(others.length + 1)
  })
})

describe('symbols kept between launches', () => {
  test('drawn once, then read back without drawing', async () => {
    const file = scratchFile()
    const first = drawing()
    expect(await cachedSymbols(file, 'key', NAMES, first)).toEqual(IMAGES)
    expect(first.calls).toBe(1)
    expect((await kept(file, 'key')).images).toEqual(IMAGES)

    const second = drawing()
    expect(await cachedSymbols(file, 'key', NAMES, second)).toEqual(IMAGES)
    expect(second.calls).toBe(0)
  })

  test('kept under another key (an update, another display), they are drawn again', async () => {
    const file = scratchFile()
    await cachedSymbols(file, 'before the update', NAMES, drawing())
    await kept(file, 'before the update')

    const newer = { circle: { src: PNG, width: 1, height: 1 } } as SymbolImages
    const draw = drawing(newer)
    expect(await cachedSymbols(file, 'after the update', NAMES, draw)).toEqual(newer)
    expect(draw.calls).toBe(1)
    expect((await kept(file, 'after the update')).images).toEqual(newer)
  })

  test('a file that is cut short, not a cache, or unreadable is drawn again', async () => {
    const whole = JSON.stringify({ key: 'key', images: IMAGES })
    for (const text of [whole.slice(0, -20), '', 'null', '[]', '{"key":"key"}', '\u0000\u0001']) {
      const file = scratchFile()
      writeFileSync(file, text)
      const draw = drawing()
      expect(await cachedSymbols(file, 'key', NAMES, draw)).toEqual(IMAGES)
      expect(draw.calls).toBe(1)
      expect((await kept(file, 'key')).images).toEqual(IMAGES)
    }

    const locked = scratchFile()
    writeFileSync(locked, whole)
    chmodSync(locked, 0o000)
    const draw = drawing()
    expect(await cachedSymbols(locked, 'key', NAMES, draw)).toEqual(IMAGES)
    // Root reads it anyway.
    if (process.getuid?.() !== 0) {
      expect(draw.calls).toBe(1)
      expect((await kept(locked, 'key')).images).toEqual(IMAGES)
    }
  })

  test('nothing drawn is not kept: the next launch tries again', async () => {
    const file = scratchFile()
    expect(await cachedSymbols(file, 'key', NAMES, drawing({}))).toEqual({})
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(existsSync(file)).toBe(false)
  })

  test('only whole images of symbols the UI has are taken from a file', () => {
    const cache = (images: unknown, key = 'key') => JSON.stringify({ key, images })
    expect(readSymbolsCache(cache(IMAGES), 'key', NAMES)).toEqual(IMAGES)
    expect(readSymbolsCache(cache(IMAGES, 'other'), 'key', NAMES)).toBeNull()
    // No icon is better drawn again than missing or broken.
    expect(readSymbolsCache(cache({}), 'key', NAMES)).toBeNull()
    expect(readSymbolsCache(cache({ gear: IMAGES.circle }), 'key', NAMES)).toBeNull()
    for (const image of [
      null,
      'circle',
      { src: PNG, width: 1 },
      { src: PNG, width: '1', height: 1 },
      { src: PNG, width: 0, height: 1 },
      { src: 'https://example.com/circle.png', width: 1, height: 1 },
      { src: `${PNG}"), url("https://example.com/`, width: 1, height: 1 },
    ]) {
      expect(readSymbolsCache(cache({ ...IMAGES, trash: image }), 'key', NAMES)).toBeNull()
    }
  })
})
