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

/**
 * A named area of the board holding some frames, like a section in Figma. It's sized to its
 * frames (`sectionBounds`), so it moves and grows with them; a section always has a frame.
 */
export interface BoardSection {
  id: string
  name: string
  /** Its frames' ids; a frame is in one section at most */
  frames: string[]
}

/** The room around a section's frames, in board pixels; more above, for its name. */
export const SECTION_PAD = 64
export const SECTION_TOP = 112

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
  sections: BoardSection[]
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
 * Whether a manifest someone else wrote can be taken as the board: JSON with a list of
 * frames. Anything less (a half-written file, a bad hand edit) is a mistake to repair, not a
 * board with nothing on it.
 */
export function isReadableManifest(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text)
    return (
      !!parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as Record<string, unknown>).frames)
    )
  } catch {
    return false
  }
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
  const sections: BoardSection[] = []
  for (const value of Array.isArray(raw.sections) ? raw.sections : []) {
    if (!value || typeof value !== 'object') continue
    const section = value as Record<string, unknown>
    if (!isFrameId(section.id) || !Array.isArray(section.frames)) continue
    sections.push({
      id: section.id,
      name: cleanName(section.name) ?? section.id,
      frames: section.frames.filter(isFrameId),
    })
  }
  const camera = raw.camera as Record<string, unknown> | undefined
  return {
    version: 1,
    name: cleanName(raw.name) ?? fallbackName,
    createdAt: finite(raw.createdAt) ? raw.createdAt : Date.now(),
    frames,
    sections: cleanSections(sections, frames),
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

/** A section's area around `frames`, its members: with room above them for its name. */
function sectionArea(frames: readonly Box[]): Box | null {
  const area = boardBounds(frames)
  if (!area) return null
  return {
    x: area.x - SECTION_PAD,
    y: area.y - SECTION_TOP,
    width: area.width + SECTION_PAD * 2,
    height: area.height + SECTION_TOP + SECTION_PAD,
  }
}

/**
 * Where a new frame joining a section goes: right of `after` when that spot is free, or else in
 * a new row below the section's frames (`members`), from its left edge. It never lands on a
 * frame, and the section grown to hold it never reaches into another (`others`, their areas).
 * Null when no such spot is near: the frame then goes outside the section (`placeFrame`).
 */
export function placeInSection(
  frames: readonly Box[],
  others: readonly Box[],
  members: readonly Box[],
  size: { width: number; height: number },
  after: readonly Box[],
): { x: number; y: number } | null {
  const fits = (spot: Box) => {
    const grown = sectionArea([...members, spot])
    return !!grown && !others.some((area) => overlaps(grown, area, 0))
  }
  const hit = (spot: Box) => frames.find((frame) => overlaps(spot, frame, FRAME_GAP - 1))
  const anchor = after.length ? after : members
  if (anchor.length) {
    const beside = {
      x: Math.max(...anchor.map((frame) => frame.x + frame.width)) + FRAME_GAP,
      y: Math.min(...anchor.map((frame) => frame.y)),
      ...size,
    }
    if (!hit(beside) && fits(beside)) return { x: beside.x, y: beside.y }
  }
  const area = boardBounds(members)
  if (!area) return null
  const left = area.x
  let top = area.y + area.height + FRAME_GAP
  // Rows only go down and each moves past a frame, so this ends after one row per frame.
  for (let row = 0; row <= frames.length; row++) {
    const spot = { x: left, y: top, ...size }
    let lowest = -Infinity
    // Along the row, past each frame in the way, while the section grown to there is clear.
    for (let i = 0; i <= frames.length; i++) {
      if (!fits(spot)) break
      const blocking = hit(spot)
      if (!blocking) return { x: spot.x, y: spot.y }
      lowest = Math.max(lowest, blocking.y + blocking.height)
      spot.x = blocking.x + blocking.width + FRAME_GAP
    }
    // Even the row's start reaches another section: any row further down would too.
    if (lowest === -Infinity) return null
    top = lowest + FRAME_GAP
  }
  return null
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

/**
 * Sections as they can be: only frames on the board, each in one section at most (the first
 * that has it), no two sections with one id, and none left empty.
 */
export function cleanSections(
  sections: readonly BoardSection[],
  frames: readonly { id: string }[],
): BoardSection[] {
  const onBoard = new Set(frames.map((frame) => frame.id))
  const placed = new Set<string>()
  const ids = new Set<string>()
  const clean: BoardSection[] = []
  for (const section of sections) {
    if (ids.has(section.id)) continue
    const members = section.frames.filter((id) => onBoard.has(id) && !placed.has(id))
    if (!members.length) continue
    for (const id of members) placed.add(id)
    ids.add(section.id)
    clean.push(members.length === section.frames.length ? section : { ...section, frames: members })
  }
  return clean
}

/** The area a section covers: around its frames, with room above them for its name. */
export function sectionBounds(
  section: BoardSection,
  frames: readonly (Box & { id: string })[],
): Box | null {
  return sectionArea(frames.filter((frame) => section.frames.includes(frame.id)))
}

/** The section a frame is in, if any. */
export function sectionOf(sections: readonly BoardSection[], id: string) {
  return sections.find((section) => section.frames.includes(id)) ?? null
}

/** A section id from its name, unique among `taken` (sections' ids are their own). */
export const sectionId = (name: string, taken: ReadonlySet<string>) => frameId(name, taken)

const contains = (box: Box, point: { x: number; y: number }) =>
  point.x >= box.x &&
  point.x <= box.x + box.width &&
  point.y >= box.y &&
  point.y <= box.y + box.height

/**
 * Sections after the user dropped `moved` frames (already at their new places in `frames`;
 * `before` is where they were), as in Figma: a frame dropped on another section joins it,
 * and one dragged out of its own (as it was before the drag) leaves it. A section whose
 * frames all moved together just moved, and keeps them.
 */
export function regroupSections(
  sections: readonly BoardSection[],
  frames: readonly (Box & { id: string })[],
  moved: readonly string[],
  before: readonly (Box & { id: string })[],
): BoardSection[] {
  const dragged = new Set(moved)
  const whole = new Set(
    sections
      .filter((section) => section.frames.every((id) => dragged.has(id)))
      .map((section) => section.id),
  )
  // Where each section is without what's being dragged: what a frame is dropped on or out of.
  const staying = sections.map((section) => ({
    section,
    box: sectionBounds(
      { ...section, frames: section.frames.filter((id) => !dragged.has(id)) },
      frames,
    ),
  }))
  const next = sections.map((section) => ({ ...section, frames: [...section.frames] }))
  for (const id of moved) {
    const own = sectionOf(sections, id)
    if (own && whole.has(own.id)) continue
    const frame = frames.find((f) => f.id === id)
    if (!frame) continue
    const center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 }
    const home = own && sectionBounds(own, before)
    if (home && contains(home, center)) continue
    const target = staying.find(
      ({ section, box }) => box && section.id !== own?.id && contains(box, center),
    )
    const into = target?.section.id ?? null
    // Out of its own section only when it has others left to stay without it.
    if (!into && own && !staying.find((entry) => entry.section.id === own.id)?.box) continue
    for (const section of next) section.frames = section.frames.filter((f) => f !== id)
    if (into) next.find((section) => section.id === into)?.frames.push(id)
  }
  return cleanSections(next, frames)
}

/**
 * Where each frame goes in an export folder, named for it: `summer-sale.png`. Frames from
 * more than one section go in a folder per section, and frames in none at the top.
 */
export function exportPaths(
  ids: readonly string[],
  frames: readonly BoardFrameLayout[],
  sections: readonly BoardSection[],
  extension = 'png',
): { id: string; path: string }[] {
  const chosen = frames.filter((frame) => ids.includes(frame.id))
  const groups = new Set(chosen.map((frame) => sectionOf(sections, frame.id)?.id ?? null))
  const nested = groups.size > 1
  const folders = new Map<string | null, string>()
  const takenFolders = new Set<string>()
  const taken = new Map<string, Set<string>>()
  return chosen.map((frame) => {
    const section = nested ? sectionOf(sections, frame.id) : null
    let folder = ''
    if (section) {
      folder = folders.get(section.id) ?? frameId(section.name, takenFolders)
      folders.set(section.id, folder)
      takenFolders.add(folder)
    }
    const names = taken.get(folder) ?? new Set<string>()
    taken.set(folder, names)
    // Loose files share the top with the section folders.
    const name = frameId(frame.name, folder ? names : new Set([...names, ...takenFolders]))
    names.add(name)
    return {
      id: frame.id,
      path: folder ? `${folder}/${name}.${extension}` : `${name}.${extension}`,
    }
  })
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
