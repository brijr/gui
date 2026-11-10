import {
  type BoardCamera,
  type BoardSection,
  SMALL_THUMB_WIDTH,
  sectionBounds,
  THUMB_WIDTH,
} from '../../../shared/board'
import {
  type BoardViewRect,
  boardRectFrom,
  boardRectFromBoardView,
  boardViewRect,
  boardViewRectFromBoard,
} from '../../../shared/coords'
import type { BoardFrame } from '../../../shared/types'

/*
 * What the board shows. Nothing here knows about WebGL or the DOM: it takes the board as main
 * sent it (with what a gesture drew ahead of main), the camera and the view's size.
 *
 * For the canvas (`buildScene`): which rectangles go where, in board-view pixels, with what
 * ink, as a list of quads in paint order. The renderer (gl/renderer.ts) turns the list into
 * draw calls; a test can read it. For the DOM over it (`overlayScene`): which frames and
 * sections are near enough the view to mount, and which names have room.
 */

/** A colour by what it's for; the renderer's theme says what each is in light and dark. */
export const INK = {
  none: 0,
  canvas: 1,
  raised: 2,
  line: 3,
  lineStrong: 4,
  /** A section's area: --fill at 60% */
  section: 5,
  accent: 6,
  accentSoft: 7,
  /** --elevation-raised's colour */
  shadow: 8,
} as const
export const INK_COUNT = 9

export const QUAD = {
  /** A rounded rectangle: a fill, and a stroke inside or outside its edge */
  flat: 0,
  /** A frame: its thumbnail across its width from the top, over its fill */
  thumb: 1,
  /** A soft shadow of the rectangle */
  shadow: 2,
} as const

/** Floats a quad takes in `QuadList.data`. */
export const QUAD_STRIDE = 12

/**
 * The widths a thumbnail's texture is made at, each about 1.4 times the last. A frame gets
 * the smallest that is THUMB_OVERSAMPLE times as wide as it's drawn, in device pixels: so
 * what's on screen holds at most three times the screen's own pixels (1.7 squared), however
 * many frames there are and however far in.
 */
export const THUMB_TIERS = [90, 128, 180, 256, 360, 512, 720, 1024, 1440] as const
/**
 * A texture drawn at very nearly its own size is soft (two resamplings, the second a pixel
 * out of step); a little larger than drawn and it's as sharp as the DOM board's thumbnails.
 */
export const THUMB_OVERSAMPLE = 1.2

export interface ThumbWant {
  id: string
  version: number
  /** The texture's width, in pixels */
  width: number
  /** Which of the frame's two files it's made from, and that file's width */
  source: 'small' | 'full'
  sourceWidth: number
}

/** The texture a frame `frameWidth` board pixels wide wants, drawn `drawn` device pixels wide. */
export function thumbTier(frameWidth: number, drawn: number): Omit<ThumbWant, 'id' | 'version'> {
  const full = Math.min(THUMB_WIDTH, Math.round(frameWidth))
  const small = Math.min(SMALL_THUMB_WIDTH, full)
  const tier = THUMB_TIERS.find((width) => width >= drawn * THUMB_OVERSAMPLE) ?? THUMB_WIDTH
  const width = Math.min(tier, full)
  return width <= small
    ? { width, source: 'small', sourceWidth: small }
    : { width, source: 'full', sourceWidth: full }
}

export interface Area {
  x: number
  y: number
  width: number
  height: number
}

export interface SceneFrame extends Area {
  id: string
  version: number
  captured: boolean
}

export interface SceneInput {
  /** Every frame, in the order they're drawn, as they are this moment (mid-drag included) */
  frames: readonly SceneFrame[]
  sections: readonly { id: string; area: Area; picked: boolean }[]
  selected: ReadonlySet<string>
  /** The frame whose resize handle shows: the one selected, unless the Hand is on */
  handle: string | null
  /** The frame under the pointer whose edge lights up (not selected, and the Hand is off) */
  hovered: string | null
  marquee: BoardViewRect | null
}

/** The dot grid's spacing at 100%, in board pixels. */
export const GRID = 24
/** The grid goes when its dots would be closer than this, in board-view pixels. */
export const GRID_MIN = 8
/** The resize handle's size, in board-view pixels. */
export const HANDLE = 10
const HANDLE_RADIUS = 4
const SECTION_RADIUS = 12
const SELECTION_WIDTH = 2

export class QuadList {
  data = new Float32Array(QUAD_STRIDE * 256)
  count = 0
  /** The thumbnail each `QUAD.thumb` quad wants, by its index */
  thumbs: (ThumbWant | undefined)[] = []

  clear() {
    this.count = 0
    this.thumbs.length = 0
  }

  push(
    rect: BoardViewRect,
    kind: number,
    fill: number,
    stroke: number,
    strokeWidth: number,
    outside: boolean,
    radius: number,
    blur = 0,
  ) {
    const at = this.count * QUAD_STRIDE
    if (at + QUAD_STRIDE > this.data.length) {
      const grown = new Float32Array(this.data.length * 2)
      grown.set(this.data)
      this.data = grown
    }
    const data = this.data
    data[at] = rect.x
    data[at + 1] = rect.y
    data[at + 2] = rect.width
    data[at + 3] = rect.height
    data[at + 4] = radius
    data[at + 5] = strokeWidth
    data[at + 6] = outside ? 1 : 0
    data[at + 7] = kind
    data[at + 8] = fill
    data[at + 9] = stroke
    // The thumbnail's height on screen: the renderer fills it in from the texture it has.
    data[at + 10] = 0
    data[at + 11] = blur
    return this.count++
  }
}

export interface Scene {
  quads: QuadList
  /** The dot grid: its spacing and where its first cell starts, in board-view pixels */
  grid: { size: number; x: number; y: number } | null
}

/**
 * Fills `quads` with what shows in a view of `size` through `camera`, on a display of `scale`
 * device pixels a CSS pixel. Only what reaches into the view is listed.
 */
export function buildScene(
  input: SceneInput,
  camera: BoardCamera,
  size: { width: number; height: number },
  scale: number,
  quads: QuadList,
): Scene {
  quads.clear()
  const { zoom } = camera
  const inView = (rect: BoardViewRect, pad: number) =>
    rect.x - pad < size.width &&
    rect.y - pad < size.height &&
    rect.x + rect.width + pad > 0 &&
    rect.y + rect.height + pad > 0
  const toView = (area: Area): BoardViewRect => boardViewRectFromBoard(boardRectFrom(area), camera)

  for (const { area, picked } of input.sections) {
    const rect = toView(area)
    if (!inView(rect, 0)) continue
    quads.push(
      rect,
      QUAD.flat,
      INK.section,
      picked ? INK.accent : INK.line,
      1,
      false,
      SECTION_RADIUS,
    )
  }

  // --elevation-raised (0 1px 2px) is in the board's own pixels: it grows with the zoom, and
  // is nothing at all once it's under half a device pixel.
  const blur = 2 * zoom
  const shown: { frame: SceneFrame; rect: BoardViewRect }[] = []
  for (const frame of input.frames) {
    const rect = toView(frame)
    if (!inView(rect, SELECTION_WIDTH + blur * 2 + HANDLE)) continue
    shown.push({ frame, rect })
  }
  if (blur * scale >= 0.5) {
    for (const { rect } of shown) {
      const shadow = boardViewRect(rect.x, rect.y + zoom, rect.width, rect.height)
      quads.push(shadow, QUAD.shadow, INK.shadow, INK.none, 0, false, 0, blur)
    }
  }
  for (const { frame, rect } of shown) {
    const index = quads.push(
      rect,
      frame.captured ? QUAD.thumb : QUAD.flat,
      INK.raised,
      input.hovered === frame.id ? INK.accent : INK.line,
      1,
      false,
      0,
    )
    if (frame.captured)
      quads.thumbs[index] = {
        id: frame.id,
        version: frame.version,
        ...thumbTier(frame.width, rect.width * scale),
      }
  }

  // What's selected, above every frame.
  for (const { frame, rect } of shown) {
    if (!input.selected.has(frame.id)) continue
    quads.push(rect, QUAD.flat, INK.none, INK.accent, SELECTION_WIDTH, true, 0)
  }
  const handled = input.handle && shown.find(({ frame }) => frame.id === input.handle)
  if (handled) {
    const { rect } = handled
    const corner = boardViewRect(
      rect.x + rect.width - HANDLE / 2,
      rect.y + rect.height - HANDLE / 2,
      HANDLE,
      HANDLE,
    )
    quads.push(corner, QUAD.flat, INK.raised, INK.accent, 2, false, HANDLE_RADIUS)
  }
  if (input.marquee) quads.push(input.marquee, QUAD.flat, INK.accentSoft, INK.accent, 1, false, 0)

  const grid = GRID * zoom
  return {
    quads,
    grid: grid >= GRID_MIN ? { size: grid, x: -camera.x * zoom, y: -camera.y * zoom } : null,
  }
}

/** The frame label's height above a frame, in screen pixels. */
export const LABEL_HEIGHT = 22
/** A section's name's height, in screen pixels. */
export const SECTION_LABEL_HEIGHT = LABEL_HEIGHT + 2
/** A section's name sits this far inside its top-left corner, in screen pixels. */
export const SECTION_INSET = 10
/** A frame narrower than this on screen shows its name above it without its size. */
const SIZE_LABEL_MIN = 140
/** Zoomed out further, frames' names go without their sizes. */
const SIZE_LABEL_ZOOM = 0.5

export interface OverlayScene {
  /** The frames near the view, and the one whose name is being edited, wherever it is */
  shown: BoardFrame[]
  /** The sections near the view, and the one being renamed, with the area each covers */
  areas: { section: BoardSection; area: Area }[]
  /** Whether a frame's name has room above it */
  named(frame: BoardFrame): boolean
  /** Whether its size fits after its name */
  sized(frame: BoardFrame): boolean
}

/**
 * The frames and sections the DOM over the board mounts, in board pixels: those near a view
 * of `size` through `camera`. The margin (half a view each way) keeps a pan from adding and
 * dropping them at every step.
 */
export function overlayScene(
  frames: readonly BoardFrame[],
  sections: readonly BoardSection[],
  camera: BoardCamera,
  size: { width: number; height: number },
  renaming: { frame: string | null; section: string | null },
): OverlayScene {
  const reach = boardRectFromBoardView(
    boardViewRect(
      -size.width / 2,
      -size.height / 2 - LABEL_HEIGHT,
      size.width * 2,
      size.height * 2 + LABEL_HEIGHT,
    ),
    camera,
  )
  const near = (area: Area) =>
    area.x <= reach.x + reach.width &&
    area.y <= reach.y + reach.height &&
    area.x + area.width >= reach.x &&
    area.y + area.height >= reach.y
  const shown = frames.filter((frame) => near(frame) || frame.id === renaming.frame)
  const areas = sections.flatMap((section) => {
    const area = sectionBounds(section, frames)
    return area && (near(area) || section.id === renaming.section) ? [{ section, area }] : []
  })
  const sectionOf = new Map<string, Area>()
  for (const { section, area } of areas) for (const id of section.frames) sectionOf.set(id, area)
  // Zoomed out, a frame's name goes where there's no room for it above the frame: it would
  // cover its section's name, or the frame above it (and take its clicks).
  const { zoom } = camera
  const nameBand = LABEL_HEIGHT / zoom
  const sectionName = (SECTION_INSET + SECTION_LABEL_HEIGHT) / zoom
  const named = (frame: BoardFrame) => {
    const top = frame.y - nameBand
    const section = sectionOf.get(frame.id)
    if (section && top < section.y + sectionName) return false
    return !frames.some(
      (other) =>
        other.id !== frame.id &&
        other.x < frame.x + frame.width &&
        frame.x < other.x + other.width &&
        other.y < frame.y &&
        other.y + other.height > top,
    )
  }
  const sized = (frame: BoardFrame) =>
    zoom >= SIZE_LABEL_ZOOM && frame.width * zoom >= SIZE_LABEL_MIN
  return { shown, areas, named, sized }
}

/** The sections' areas for the canvas: around their frames as drawn, and which is picked. */
export function sectionAreas(
  sections: readonly BoardSection[],
  frames: readonly BoardFrame[],
  picked: string | null,
): SceneInput['sections'] {
  return sections.flatMap((section) => {
    const area = sectionBounds(section, frames)
    return area ? [{ id: section.id, area, picked: picked === section.id }] : []
  })
}

/** What a screen reader is told is selected: a section picked by its name, a frame, or a count. */
export function selectionSaid(
  selection: readonly string[],
  frames: readonly BoardFrame[],
  section: BoardSection | null,
) {
  if (section) return `${section.name} selected`
  const names = selection.flatMap((id) => frames.find((frame) => frame.id === id)?.name ?? [])
  if (names.length === 0) return ''
  return names.length === 1 ? `${names[0]} selected` : `${names.length} frames selected`
}
