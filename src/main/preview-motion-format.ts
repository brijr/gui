import { z } from 'zod'
import { PREVIEW_KEYS, type PreviewKey } from './preview-interactions'
import { formatTimeline, type TraceEntry } from './recording-trace'

/**
 * preview_motion's request, contact sheet and text (preview-motion.ts films): pure, so it's
 * tested without Electron.
 */

/** Longest stretch of motion one call films, in the page's animation time. */
export const MAX_MOTION_MS = 5000
/** Longest a call films for, wall-clock: durationMs times slowMotion. */
export const MAX_FILMING_MS = 10_000
export const MAX_MOTION_FRAMES = 12
export const MAX_SLOW_MOTION = 10
const DEFAULT_MS = 1000
const DEFAULT_FRAMES = 8
const DEFAULT_SCROLL = 400
/** The sheet fits the same box as preview_screenshot's images (under the API's 2000 px). */
export const SHEET_MAX = { width: 1600, height: 1960 }
export const MOTION_PLAYS = [
  'watch',
  'click',
  'hover',
  'press',
  'scroll',
  'replay',
  'reload',
] as const
export type MotionPlay = (typeof MOTION_PLAYS)[number]

export interface MotionRequest {
  play?: MotionPlay
  selector?: string
  key?: PreviewKey
  deltaY?: number
  durationMs?: number
  frames?: number
  slowMotion?: number
  reducedMotion?: boolean
  crop?: string
}

export interface MotionPlan {
  play: MotionPlay
  selector?: string
  key?: PreviewKey
  deltaY: number
  /** In the page's animation time */
  durationMs: number
  frames: number
  slowMotion: number
  reducedMotion: boolean
  crop?: string
  /** How long filming takes, wall-clock */
  filmingMs: number
}

const selector = z.string().min(1).max(500)

/** The tool as agents see it (registered in mcp-preview-tools.ts). */
export const motionTool = {
  title: 'Watch motion in the preview',
  description: `Play motion in the user's app and watch it. Returns one contact-sheet image of \`frames\` stills spread over \`durationMs\`, each labelled with its number and time, and a text timeline of the CSS transitions, CSS animations and Web Animations that ran (element, properties and values, duration, delay, easing, iterations, when each started and ended), with the input, class changes, layout shifts and slow frames (jank) around them. Use it to check that an animation runs, how it eases, whether it stutters and that it ends in the right state; a screenshot catches one frame. \`play\`: \`watch\` (default) films what happens next, such as an autoplaying carousel; \`click\`, \`hover\`, \`press\` or \`scroll\` sends that input as the input tools do and films what follows; \`replay\` restarts the page's CSS animations and Web Animations (transitions need the change that starts them, so use an input for those); \`reload\` reloads the page and films it loading. \`slowMotion: 4\` runs CSS and Web Animations at quarter speed so fast motion gets more frames; times stay in the animations' own time. \`reducedMotion\` films with prefers-reduced-motion: reduce emulated, to check the reduced path. Both are undone afterwards. \`crop\` films one element (with a margin, where it is before playing) instead of the viewport, for detail. Motion driven by JavaScript (requestAnimationFrame, springs from Motion/framer-motion, GSAP) isn't a CSS or Web Animation: the timeline only shows it as inline styles set by script, with no duration or easing, and slowMotion doesn't slow it, so judge it from the frames. Caps: durationMs up to ${MAX_MOTION_MS}, ${MAX_MOTION_FRAMES} frames, and durationMs × slowMotion up to ${MAX_FILMING_MS / 1000} s of filming. The user's app only.`,
  inputSchema: {
    play: z.enum(MOTION_PLAYS).optional().describe('What starts the motion (default watch)'),
    selector: selector
      .optional()
      .describe('Unique CSS selector to click, hover, focus before press, or scroll inside'),
    key: z.enum(PREVIEW_KEYS).optional().describe('The key, for press'),
    deltaY: z
      .number()
      .min(-5000)
      .max(5000)
      .optional()
      .describe(`CSS px to scroll, for scroll; positive is down (default ${DEFAULT_SCROLL})`),
    durationMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`How much motion to film, ms (default ${DEFAULT_MS}, up to ${MAX_MOTION_MS})`),
    frames: z
      .number()
      .int()
      .optional()
      .describe(
        `Stills on the sheet, the first at 0 and the last at durationMs (default ${DEFAULT_FRAMES}, 2–${MAX_MOTION_FRAMES})`,
      ),
    slowMotion: z
      .number()
      .optional()
      .describe(`Slow CSS and Web Animations by this factor, 1–${MAX_SLOW_MOTION} (default 1)`),
    reducedMotion: z.boolean().optional().describe('Emulate prefers-reduced-motion: reduce'),
    crop: selector.optional().describe('CSS selector of one element to film instead'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}

/** The request with its defaults, or why it can't be filmed and what to do instead. */
export function planMotion(request: MotionRequest): MotionPlan {
  const play = request.play ?? 'watch'
  const durationMs = request.durationMs ?? DEFAULT_MS
  const frames = request.frames ?? DEFAULT_FRAMES
  const slowMotion = request.slowMotion ?? 1
  if ((play === 'click' || play === 'hover') && !request.selector)
    throw new Error(`play: '${play}' needs \`selector\`, the element to ${play}.`)
  if (play === 'press' && !request.key)
    throw new Error("play: 'press' needs `key`; `selector` focuses an element first.")
  if ((play === 'watch' || play === 'replay' || play === 'reload') && request.selector)
    throw new Error(
      '`selector` is the target of click, hover, press and scroll. To film one element, pass it as `crop`.',
    )
  if (!Number.isFinite(durationMs) || durationMs < 1)
    throw new Error('durationMs is how long to film, in ms, such as 600.')
  if (durationMs > MAX_MOTION_MS)
    throw new Error(
      `durationMs is capped at ${MAX_MOTION_MS} ms. Film a longer sequence in parts: call again with play: 'watch' while it's still going.`,
    )
  if (!Number.isInteger(frames) || frames < 2 || frames > MAX_MOTION_FRAMES)
    throw new Error(
      `frames is 2–${MAX_MOTION_FRAMES}, which fit one readable image. For finer timing, film a shorter durationMs or pass slowMotion.`,
    )
  if (!Number.isFinite(slowMotion) || slowMotion < 1 || slowMotion > MAX_SLOW_MOTION)
    throw new Error(
      `slowMotion slows CSS and Web Animations by 1–${MAX_SLOW_MOTION}× (4 is quarter speed); it can't speed them up.`,
    )
  const filmingMs = Math.round(durationMs * slowMotion)
  if (filmingMs > MAX_FILMING_MS)
    throw new Error(
      `At slowMotion ${slowMotion}, ${durationMs} ms of motion takes ${(filmingMs / 1000).toFixed(1)} s to film; the cap is ${MAX_FILMING_MS / 1000} s. Lower slowMotion, or film only the part that matters with a shorter durationMs.`,
    )
  return {
    play,
    selector: request.selector,
    key: request.key,
    deltaY: request.deltaY ?? DEFAULT_SCROLL,
    durationMs,
    frames,
    slowMotion,
    reducedMotion: request.reducedMotion === true,
    crop: request.crop,
    filmingMs,
  }
}

// ---- The contact sheet ----

/** Raw pixels, 4 bytes each with alpha last (nativeImage's bitmap order). */
export interface Bitmap {
  width: number
  height: number
  pixels: Uint8Array
}

export interface SheetLayout {
  columns: number
  rows: number
  /** Each frame's size on the sheet, px */
  cellWidth: number
  cellHeight: number
  width: number
  height: number
  /** Each frame's top-left corner on the sheet (its label sits above it) */
  cells: { x: number; y: number }[]
}

const GAP = 8
const LABEL_HEIGHT = 22
const GLYPH_SCALE = 2

/**
 * Where `count` frames of `frame` size (px) go on one sheet within `max`: the grid that draws
 * them largest, never larger than captured.
 */
export function sheetLayout(
  count: number,
  frame: { width: number; height: number },
  max = SHEET_MAX,
): SheetLayout {
  let best = { columns: 1, rows: count, scale: 0, area: Infinity }
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns)
    const width = (max.width - GAP * (columns + 1)) / columns
    const height = (max.height - GAP * (rows + 1) - LABEL_HEIGHT * rows) / rows
    const scale = Math.min(width / frame.width, height / frame.height, 1)
    // As large either way (small frames at full size): the more compact sheet.
    const area =
      (columns * frame.width * scale + GAP * columns) *
      (rows * (frame.height * scale + LABEL_HEIGHT + GAP))
    if (scale > best.scale + 1e-9 || (scale > best.scale - 1e-9 && area < best.area))
      best = { columns, rows, scale, area }
  }
  const { columns, rows, scale } = best
  const cellWidth = Math.max(1, Math.floor(frame.width * scale))
  const cellHeight = Math.max(1, Math.floor(frame.height * scale))
  const cells = Array.from({ length: count }, (_, index) => ({
    x: GAP + (index % columns) * (cellWidth + GAP),
    y: GAP + Math.floor(index / columns) * (cellHeight + LABEL_HEIGHT + GAP) + LABEL_HEIGHT,
  }))
  return {
    columns,
    rows,
    cellWidth,
    cellHeight,
    width: columns * cellWidth + GAP * (columns + 1),
    height: rows * (cellHeight + LABEL_HEIGHT) + GAP * (rows + 1),
    cells,
  }
}

/** A 5×7 pixel font for frame labels: no canvas in the main process to draw text with. */
const GLYPHS: Record<string, string> = {
  '0': '01110 10001 10011 10101 11001 10001 01110',
  '1': '00100 01100 00100 00100 00100 00100 01110',
  '2': '01110 10001 00001 00010 00100 01000 11111',
  '3': '11110 00001 00001 01110 00001 00001 11110',
  '4': '00010 00110 01010 10010 11111 00010 00010',
  '5': '11111 10000 11110 00001 00001 10001 01110',
  '6': '00110 01000 10000 11110 10001 10001 01110',
  '7': '11111 00001 00010 00100 01000 01000 01000',
  '8': '01110 10001 10001 01110 10001 10001 01110',
  '9': '01110 10001 10001 01111 00001 00010 01100',
  m: '00000 00000 11010 10101 10101 10101 10101',
  s: '00000 00000 01111 10000 01110 00001 11110',
  '#': '01010 01010 11111 01010 11111 01010 01010',
  '.': '00000 00000 00000 00000 00000 01100 01100',
  '-': '00000 00000 00000 11111 00000 00000 00000',
}
const ADVANCE = 6 * GLYPH_SCALE

/** Text's width in px, as `drawText` draws it. */
export const textWidth = (text: string) => text.length * ADVANCE - GLYPH_SCALE

function fill(bitmap: Bitmap, x: number, y: number, width: number, height: number, gray: number) {
  const right = Math.min(bitmap.width, x + width)
  const bottom = Math.min(bitmap.height, y + height)
  for (let row = Math.max(0, y); row < bottom; row++) {
    for (let column = Math.max(0, x); column < right; column++) {
      const at = (row * bitmap.width + column) * 4
      bitmap.pixels[at] = gray
      bitmap.pixels[at + 1] = gray
      bitmap.pixels[at + 2] = gray
      bitmap.pixels[at + 3] = 255
    }
  }
}

/** Draws `text` with its top-left corner at x, y; characters it has no glyph for are spaces. */
export function drawText(bitmap: Bitmap, text: string, x: number, y: number, gray = 240) {
  for (const [index, char] of [...text].entries()) {
    const glyph = GLYPHS[char]
    if (!glyph) continue
    for (const [row, bits] of glyph.split(' ').entries()) {
      for (let column = 0; column < bits.length; column++) {
        if (bits[column] !== '1') continue
        fill(
          bitmap,
          x + index * ADVANCE + column * GLYPH_SCALE,
          y + row * GLYPH_SCALE,
          GLYPH_SCALE,
          GLYPH_SCALE,
          gray,
        )
      }
    }
  }
}

/** Copies `source` onto `target` with its top-left corner at x, y, clipped to both. */
function blit(target: Bitmap, source: Bitmap, x: number, y: number) {
  const width = Math.min(source.width, target.width - x)
  const height = Math.min(source.height, target.height - y)
  for (let row = 0; row < height; row++) {
    const from = row * source.width * 4
    target.pixels.set(
      source.pixels.subarray(from, from + width * 4),
      ((y + row) * target.width + x) * 4,
    )
  }
}

/**
 * The frames on one dark sheet, each with its label above it and a hairline around it. A frame
 * that couldn't be captured (null) is a flat cell under its label.
 */
export function composeSheet(
  layout: SheetLayout,
  frames: (Bitmap | null)[],
  labels: string[],
): Bitmap {
  const sheet: Bitmap = {
    width: layout.width,
    height: layout.height,
    pixels: new Uint8Array(layout.width * layout.height * 4),
  }
  fill(sheet, 0, 0, sheet.width, sheet.height, 24)
  for (const [index, cell] of layout.cells.entries()) {
    const { cellWidth: width, cellHeight: height } = layout
    fill(sheet, cell.x - 1, cell.y - 1, width + 2, height + 2, 80)
    const frame = frames[index]
    if (frame) blit(sheet, frame, cell.x, cell.y)
    else fill(sheet, cell.x, cell.y, width, height, 48)
    const label = labels[index] ?? ''
    drawText(sheet, label, cell.x, cell.y - LABEL_HEIGHT + Math.floor((LABEL_HEIGHT - 14) / 2) - 1)
  }
  return sheet
}

/** "#3 250 ms": the frame's number and its time in the animations' own time. */
export const frameLabel = (index: number, atMs: number) => `#${index + 1} ${Math.round(atMs)} ms`

// ---- The timeline ----

const ms = (value: number) => `${Math.round(value)} ms`

function kindOf(entry: Extract<TraceEntry, { kind: 'animation' }>) {
  return entry.type === 'transition'
    ? 'CSS transition'
    : entry.type === 'css-animation'
      ? 'CSS animation'
      : 'Web Animation'
}

/**
 * What ran while filming, as text: each CSS transition, CSS animation and Web Animation with
 * when it started and ended, then everything else the trace saw. Times are relative to the
 * start of filming, in wall-clock ms; `slowMotion` turns them into the animations' own time.
 */
export function motionTimeline(
  entries: TraceEntry[],
  {
    slowMotion = 1,
    limit = 60,
    replayed = false,
  }: {
    slowMotion?: number
    limit?: number
    /** The animations running as filming began were restarted for it: they start at 0 */
    replayed?: boolean
  } = {},
) {
  const scaled = entries.map((entry) => {
    const out = { ...entry, at: entry.at / slowMotion }
    if ('end' in out) out.end = out.end / slowMotion
    return out
  })
  const ends = scaled.flatMap((entry) => (entry.kind === 'animation-end' ? [entry] : []))
  const paired = new Set<(typeof ends)[number]>()
  const animations = scaled.flatMap((entry) => {
    if (entry.kind !== 'animation') return []
    const end = ends.find(
      (candidate) =>
        !paired.has(candidate) &&
        candidate.target === entry.target &&
        candidate.name === entry.name &&
        candidate.at >= entry.at,
    )
    if (end) paired.add(end)
    const before = entry.running && !replayed
    const range = `${before ? '…' : Math.round(entry.at)}–${end ? Math.round(end.at) : '…'} ms`
    const name = entry.name ? ` ${entry.name}` : ''
    const delay = entry.delay ? `, delay ${ms(entry.delay)}` : ''
    const repeat = entry.iterations === 1 ? '' : `, ${entry.iterations} iterations`
    const notes = [
      before ? 'already running as filming began' : null,
      end?.cancelled ? 'cancelled' : end ? null : 'still running at the end',
    ].filter(Boolean)
    const head = `${range.padStart(15)}  ${kindOf(entry)}${name} on ${entry.target}: ${ms(entry.duration)} ${entry.easing}${delay}${repeat}${notes.length ? ` (${notes.join('; ')})` : ''}`
    return [[head, ...entry.changes.map((change) => `${' '.repeat(19)}${change}`)].join('\n')]
  })
  const rest = scaled.filter(
    (entry) => entry.kind !== 'animation' && entry.kind !== 'animation-end',
  )
  const lines: string[] = []
  if (animations.length) {
    lines.push(`CSS and Web Animations (${animations.length}), start–end:`)
    lines.push(...animations.slice(0, limit))
    if (animations.length > limit) lines.push(`… ${animations.length - limit} more`)
  } else {
    lines.push(
      'No CSS transitions, CSS animations or Web Animations ran. Motion driven by JavaScript (requestAnimationFrame, spring libraries) is not one: judge it from the frames, and any "inline style … set by script" below.',
    )
  }
  if (rest.length) lines.push('', 'Also in the page:', formatTimeline(rest, { limit }))
  return lines.join('\n')
}

/** What started the motion, for the summary. */
function played(plan: MotionPlan, restarted: number) {
  const on = plan.selector ? ` \`${plan.selector}\`` : ''
  switch (plan.play) {
    case 'watch':
      return 'Watched the page'
    case 'click':
      return `Clicked${on}`
    case 'hover':
      return `Hovered${on}`
    case 'press':
      return `Pressed ${plan.key}${plan.selector ? ` in${on}` : ''}`
    case 'scroll':
      return `Scrolled ${plan.deltaY}px${plan.selector ? ` in${on}` : ''}`
    case 'replay':
      return `Replayed ${restarted} animation${restarted === 1 ? '' : 's'}`
    case 'reload':
      return 'Reloaded the page'
  }
}

/** Gui's account of the filming, for the result's text. */
export function motionSummary(
  plan: MotionPlan,
  frames: { at: number; captured: boolean }[],
  image: { width: number; height: number },
  restarted = 0,
) {
  const lines = [
    `${played(plan, restarted)} and filmed ${plan.durationMs} ms${plan.crop ? ` of \`${plan.crop}\`` : ''}: ${frames.length} frames in one ${image.width}×${image.height} image, left to right then down, each labelled with its number and time from the start of filming.`,
  ]
  if (plan.slowMotion !== 1)
    lines.push(
      `Slow motion ${plan.slowMotion}×: CSS and Web Animations ran at 1/${plan.slowMotion} speed, and every time here is in their own time (filming took ${plan.filmingMs} ms). Motion driven by JavaScript wasn't slowed, so it looks ${plan.slowMotion}× faster than it is.`,
    )
  if (plan.reducedMotion) lines.push('prefers-reduced-motion: reduce was emulated while filming.')
  if (plan.slowMotion !== 1 || plan.reducedMotion)
    lines.push('The page is back to normal speed and its usual motion preference.')
  const missed = frames.filter((frame) => !frame.captured).length
  if (missed) lines.push(`${missed} frame${missed === 1 ? '' : 's'} couldn't be captured (blank).`)
  const planned = plan.durationMs / (frames.length - 1)
  const widest = Math.max(...frames.slice(1).map((frame, index) => frame.at - frames[index].at))
  if (widest > planned * 1.5 + 10)
    lines.push(
      `Capturing couldn't keep up: frames are up to ${Math.round(widest)} ms apart (${Math.round(planned)} ms planned). Pass slowMotion to sample fast motion more finely.`,
    )
  return lines.join('\n')
}
