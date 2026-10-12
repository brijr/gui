/**
 * A canvas: a freeform board of HTML frames the user and their agent build on, kept in a
 * folder Gui manages (main/board.ts). This is its manifest, `canvas.json`, and the rules for
 * reading it and placing frames on it, without anything platform-specific.
 */

/** The manifest's own name in a canvas's folder. */
export const BOARD_MANIFEST = 'canvas.json'
/** Where a canvas's frames are, one single-file HTML page each: `frames/<id>.html`. */
export const FRAMES_DIR = 'frames'
/** The most frames a canvas holds; more would make its thumbnails slow to keep current. */
export const MAX_FRAMES = 60
/** The room left between frames placed side by side, in board pixels. */
export const FRAME_GAP = 80
/** A frame's smallest and largest edge, in CSS pixels. */
export const FRAME_MIN = 120
export const FRAME_MAX = 4000

/** The sizes a new frame can start at. */
export const FRAME_PRESETS = [
  { id: 'desktop', name: 'Desktop', width: 1440, height: 900 },
  { id: 'tablet', name: 'Tablet', width: 820, height: 1180 },
  { id: 'mobile', name: 'Mobile', width: 390, height: 844 },
] as const

export type FramePreset = (typeof FRAME_PRESETS)[number]['id']

export function isFramePreset(value: unknown): value is FramePreset {
  return FRAME_PRESETS.some((preset) => preset.id === value)
}

export interface BoardFrameLayout {
  /** Its file's name without `.html`, which never changes once made */
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
}

export interface BoardCamera {
  /** The board point at the view's top-left corner */
  x: number
  y: number
  zoom: number
}

export interface BoardManifest {
  version: 1
  name: string
  createdAt: number
  frames: BoardFrameLayout[]
  camera: BoardCamera | null
}

export const ZOOM_MIN = 0.05
export const ZOOM_MAX = 2

const FRAME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isFrameId(value: unknown): value is string {
  return typeof value === 'string' && FRAME_ID.test(value)
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

export const clampEdge = (value: number) =>
  Math.round(Math.min(FRAME_MAX, Math.max(FRAME_MIN, value)))

/** A name for a frame or canvas: one line, trimmed, cut short; null when nothing's left. */
export function cleanName(value: unknown, max = 80): string | null {
  if (typeof value !== 'string') return null
  const name = value.replace(/\s+/g, ' ').trim().slice(0, max)
  return name || null
}

/**
 * Reads a manifest as written by Gui, or by hand, or half-written: anything malformed in it
 * is dropped or repaired rather than failing the whole canvas.
 */
export function parseManifest(text: string | null, fallbackName: string): BoardManifest {
  let raw: Record<string, unknown> = {}
  try {
    const parsed: unknown = text ? JSON.parse(text) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      raw = parsed as Record<string, unknown>
  } catch {
    // A corrupt manifest leaves the frames' files, which `syncFrames` puts back on the board.
  }
  const seen = new Set<string>()
  const frames: BoardFrameLayout[] = []
  for (const value of Array.isArray(raw.frames) ? raw.frames : []) {
    if (!value || typeof value !== 'object') continue
    const frame = value as Record<string, unknown>
    if (!isFrameId(frame.id) || seen.has(frame.id)) continue
    seen.add(frame.id)
    frames.push({
      id: frame.id,
      name: cleanName(frame.name) ?? frame.id,
      x: finite(frame.x) ? Math.round(frame.x) : 0,
      y: finite(frame.y) ? Math.round(frame.y) : 0,
      width: clampEdge(finite(frame.width) ? frame.width : 1440),
      height: clampEdge(finite(frame.height) ? frame.height : 900),
    })
    if (frames.length >= MAX_FRAMES) break
  }
  const camera = raw.camera as Record<string, unknown> | undefined
  return {
    version: 1,
    name: cleanName(raw.name) ?? fallbackName,
    createdAt: finite(raw.createdAt) ? raw.createdAt : Date.now(),
    frames,
    camera:
      camera && finite(camera.x) && finite(camera.y) && finite(camera.zoom)
        ? { x: camera.x, y: camera.y, zoom: clampZoom(camera.zoom) }
        : null,
  }
}

export const clampZoom = (zoom: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom))

interface Box {
  x: number
  y: number
  width: number
  height: number
}

const overlaps = (a: Box, b: Box, gap: number) =>
  a.x < b.x + b.width + gap &&
  b.x < a.x + a.width + gap &&
  a.y < b.y + b.height + gap &&
  b.y < a.y + a.height + gap

/**
 * Where a new frame of `size` goes: right of `after` (the frames it follows, such as the
 * ones selected) at their top, or right of everything; moved further right past any frame
 * it would overlap, so frames never land on each other.
 */
export function placeFrame(
  frames: readonly Box[],
  size: { width: number; height: number },
  after: readonly Box[] = [],
): { x: number; y: number } {
  if (!frames.length) return { x: 0, y: 0 }
  const anchor = after.length ? after : frames
  const right = Math.max(...anchor.map((frame) => frame.x + frame.width))
  const top = Math.min(...anchor.map((frame) => frame.y))
  const spot = { x: right + FRAME_GAP, y: top, ...size }
  // Each pass moves past one frame in the way, so this ends after at most one per frame.
  for (let i = 0; i <= frames.length; i++) {
    const hit = frames.find((frame) => overlaps(spot, frame, FRAME_GAP - 1))
    if (!hit) break
    spot.x = hit.x + hit.width + FRAME_GAP
  }
  return { x: spot.x, y: spot.y }
}

/** A frame id from a name: lowercase words joined by dashes, unique among `taken`. */
export function frameId(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'frame'
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`
    if (!taken.has(id)) return id
  }
}

/** The board area around every frame, for "zoom to fit"; null for an empty board. */
export function boardBounds(frames: readonly Box[]): Box | null {
  if (!frames.length) return null
  const left = Math.min(...frames.map((frame) => frame.x))
  const top = Math.min(...frames.map((frame) => frame.y))
  const right = Math.max(...frames.map((frame) => frame.x + frame.width))
  const bottom = Math.max(...frames.map((frame) => frame.y + frame.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** The camera that shows all of `area` within a view of `view`, with a margin, at most 100%. */
export function fitCamera(
  area: Box | null,
  view: { width: number; height: number },
  margin = 64,
): BoardCamera {
  if (!area || view.width <= 0 || view.height <= 0) return { x: -margin, y: -margin, zoom: 0.5 }
  const zoom = clampZoom(
    Math.min(
      1,
      (view.width - margin * 2) / Math.max(1, area.width),
      (view.height - margin * 2) / Math.max(1, area.height),
    ),
  )
  return {
    x: area.x + area.width / 2 - view.width / 2 / zoom,
    y: area.y + area.height / 2 - view.height / 2 / zoom,
    zoom,
  }
}

/** A starter page for a frame the user adds by hand, for the agent (or them) to fill in. */
export function starterHtml(name: string) {
  const title = name.replace(/[<>&"]/g, '')
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { margin: 0; padding: 48px; font: 16px/1.5 system-ui, sans-serif; color: #6b6b6b; background: #fff; }
    </style>
  </head>
  <body>
    <p>${title}</p>
  </body>
</html>
`
}
