import { boardBounds, MAX_FRAMES, placeFrame } from './board'
import { MAX_COPIED_FRAMES_BYTES } from './bounded'

/*
 * Frames on the clipboard (⌘C, ⌘X and ⌘V on the canvas), in Gui's own format: a web custom
 * format, which other apps' text fields don't read, so pasting there gives nothing rather
 * than a page of JSON. Anything can write the clipboard, so a paste reads it as untrusted.
 */

/** The clipboard type frames are copied as. */
export const FRAMES_MIME = 'web application/x.gui-frames'

export interface CopiedFrame {
  /** Its id on the canvas it was copied from, to paste beside it there */
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  /** Its page */
  html: string
}

export interface CopiedFrames {
  version: 1
  /** The canvas they were copied from */
  canvas: string
  frames: CopiedFrame[]
}

export function copiedFramesText(canvas: string, frames: CopiedFrame[]): string {
  const copied: CopiedFrames = { version: 1, canvas, frames }
  return JSON.stringify(copied)
}

/** The frames in a clipboard's Gui text, or null when it isn't frames Gui can paste. */
export function parseCopiedFrames(text: string): CopiedFrames | null {
  if (text.length > MAX_COPIED_FRAMES_BYTES) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const { version, canvas, frames } = value as Record<string, unknown>
  if (version !== 1 || typeof canvas !== 'string' || !Array.isArray(frames)) return null
  if (!frames.length || frames.length > MAX_FRAMES || !frames.every(isCopiedFrame)) return null
  return {
    version,
    canvas,
    frames: frames.map(({ id, name, x, y, width, height, html }) => ({
      id,
      name,
      x,
      y,
      width,
      height,
      html,
    })),
  }
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

function isCopiedFrame(value: unknown): value is CopiedFrame {
  if (!value || typeof value !== 'object') return false
  const { id, name, x, y, width, height, html } = value as Record<string, unknown>
  return (
    typeof id === 'string' &&
    typeof name === 'string' &&
    typeof html === 'string' &&
    [x, y, width, height].every(finite)
  )
}

interface Box {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where pasted frames go: together, as they were laid out when copied, beside `after` (the
 * frames they were copied from, or what's selected) or everything, clear of every frame and
 * section on the board (`taken`), as a duplicate goes.
 */
export function pastePlaces(
  copied: readonly Box[],
  taken: readonly Box[],
  after: readonly Box[],
): { x: number; y: number }[] {
  const group = boardBounds(copied)
  if (!group) return []
  const at = placeFrame(taken, { width: group.width, height: group.height }, after)
  return copied.map((frame) => ({ x: at.x + frame.x - group.x, y: at.y + frame.y - group.y }))
}

/**
 * The canvas's shared files a page uses, as `../assets/<file>` (how frames reference them),
 * relative to `assets/`: to bring along when it's pasted into another canvas.
 */
export function assetRefs(html: string): string[] {
  const found = new Set<string>()
  for (const [, raw] of html.matchAll(/\.\.\/assets\/([^"'`()\s?#<>\\]+)/g)) {
    let path: string
    try {
      path = decodeURIComponent(raw)
    } catch {
      continue
    }
    const parts = path.split('/')
    if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\')))
      continue
    found.add(path)
  }
  return [...found]
}
