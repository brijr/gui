/**
 * Caps for things that grow with use (transcripts, checkpoints, listings). Callers share
 * these instead of inventing a new limit per feature.
 */
export const MAX_HISTORY_VERSIONS = 100
/** New or changed files bigger than this aren't kept in a checkpoint. */
export const MAX_CHECKPOINT_FILE_BYTES = 10 * 1024 * 1024
/**
 * Pages of deleted canvas frames kept for ⌘Z, across its undo steps. Past it the oldest steps
 * go; the newest is always kept.
 */
export const MAX_UNDO_BYTES = 32 * 1024 * 1024
/** Frames' pages copied to the clipboard at once (⌘C on the canvas); a paste reads no more. */
export const MAX_COPIED_FRAMES_BYTES = 32 * 1024 * 1024
/** A subagent's steps and words kept in its chat transcript; past it the oldest go. */
export const MAX_SUBAGENT_STEPS = 200
/** Subagent sessions an agent session remembers, to route their updates; past it the oldest go. */
export const MAX_SUBAGENT_SESSIONS = 500
/**
 * Changed lines a permission card keeps of the edit it asks about, across its files, and how
 * much of each line. The card scrolls; the rest is counted, not kept.
 */
export const MAX_PERMISSION_DIFF_LINES = 120
export const MAX_DIFF_LINE_CHARS = 300
/** Past this many line pairs (removed × added) an edit's changed part isn't narrowed further. */
export const MAX_DIFF_COMPARE = 400_000
/** Finished chat replies kept parsed, as characters of their text, to draw again at once. */
export const MAX_FINISHED_MARKDOWN_CHARS = 512 * 1024
/** Output kept per terminal / dev server so the drawer can redraw after a tab switch. */
export const MAX_OUTPUT_BYTES = 512 * 1024
/**
 * History a drawer terminal keeps. Ghostty takes `scrollback` as bytes of its page memory,
 * not lines; a row costs more the wider the terminal is. 16 MB is about 5,000 lines at 240
 * columns and 10,000 at 120.
 */
export const TERMINAL_SCROLLBACK_BYTES = 16 * 1024 * 1024

/** Longest preview recording, ms: a silent one, and one the user talks over (narrated). */
export const MAX_RECORDING_MS = 60_000
export const MAX_NARRATED_RECORDING_MS = 180_000
/**
 * Frames kept per second of recording. Silent clips are mostly about motion; narrated ones
 * run three times as long, so they keep fewer to stay within the same frame budget.
 */
export const RECORDING_FPS = 30
export const NARRATED_RECORDING_FPS = 10
export const MAX_RECORDING_FRAMES = 1830
export const MAX_RECORDING_VIDEO_BYTES = 64 * 1024 * 1024
/** 16 kHz mono 16-bit WAV of a narrated recording, kept until it's transcribed (~5.8 MB at most). */
export const MAX_RECORDING_AUDIO_BYTES = 8 * 1024 * 1024

/** Images attached to one chat message: the composer stops there, and main accepts no more. */
export const MAX_IMAGES = 6
/** The composer keeps images to about 5 MB, under 7 MB as base64; bigger didn't come from it. */
export const MAX_IMAGE_BASE64 = 7 * 1024 * 1024
/** An attachment's thumbnail, as the length of its data URL. */
export const MAX_THUMBNAIL = 256 * 1024
/**
 * A downscaled PNG this big is photo-like; as a JPEG it stays well under agents'
 * per-image limits (Claude's is 5 MB) and costs the same tokens.
 */
export const MAX_PNG_BYTES = 3 * 1024 * 1024

/**
 * A canvas chat's attached image is also saved to the canvas's assets/ for frames to use:
 * full resolution up to this long edge, far more than the agent's copy.
 */
export const MAX_ASSET_EDGE = 4096
/** A saved PNG over this (a photo, not a screenshot) is a JPEG instead. */
export const MAX_ASSET_PNG_BYTES = 12 * 1024 * 1024
/** A saved image's bytes as main accepts them from the composer: bigger didn't come from it. */
export const MAX_ASSET_BYTES = 16 * 1024 * 1024

/**
 * Characters of a tool step's title a chat keeps. Agents send the whole command as the title,
 * a heredoc's file and all: of 46,490 commands in real Claude Code sessions the longest was
 * 36,066 characters and one in 2,000 was over this. The chat shows one line of it. A step's
 * output, its diff and its raw input are never kept at all (see `applyItem` in main/chat.ts).
 */
export const MAX_TOOL_TITLE = 16 * 1024
/**
 * Paths a chat keeps for one tool step. Agents send one, or a handful for a patch; the chat
 * names the first and counts the rest.
 */
export const MAX_TOOL_LOCATIONS = 100
/** One of those paths; macOS has none longer. */
export const MAX_TOOL_LOCATION = 1024

/** Models the picker's Recent remembers, across agents (prefs.json); past it the oldest go. */
export const MAX_RECENT_MODELS = 8
/**
 * Agents whose model list is remembered between launches (agent-models.json), and models per
 * list: OpenCode with every provider signed in lists a few hundred.
 */
export const MAX_CACHED_MODEL_AGENTS = 64
export const MAX_CACHED_MODELS = 1000
/** A model's or provider's name or value, as kept in that file and in Recent. */
export const MAX_MODEL_TEXT = 200

/** Newest `max` items, in the same order. */
export function bounded<T>(items: readonly T[], max: number): T[] {
  if (max <= 0) return []
  return items.length <= max ? [...items] : items.slice(-max)
}

/** Room `clampMiddle` leaves for its own line saying how much is gone. */
const LEFT_OUT_ROOM = 64

/**
 * `text` in at most `max` characters (above 64): its start and its end, half each, and
 * between them how much was left out. Text already that short comes back as it is.
 */
export function clampMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const keep = max - LEFT_OUT_ROOM
  let head = Math.ceil(keep / 2)
  let tail = keep - head
  // Never half of a character that takes two code units (an emoji).
  if (isHighSurrogate(text.charCodeAt(head - 1))) head--
  if (isLowSurrogate(text.charCodeAt(text.length - tail))) tail--
  const leftOut = (text.length - head - tail).toLocaleString('en-US')
  return `${text.slice(0, head)}\n… ${leftOut} characters left out …\n${text.slice(text.length - tail)}`
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

/** What a chat keeps of a tool step's title and paths. */
interface ToolText {
  title: string
  locations: string[]
  /** Paths left out of `locations` */
  moreLocations?: number
}

/**
 * The first MAX_TOOL_LOCATIONS of a tool step's paths, none longer than a path can be, with
 * how many were left out: these and the `more` the caller already left out.
 */
export function boundedLocations(
  paths: readonly string[],
  more = 0,
): Pick<ToolText, 'locations' | 'moreLocations'> {
  const locations = paths
    .slice(0, MAX_TOOL_LOCATIONS)
    .map((path) => clampMiddle(path, MAX_TOOL_LOCATION))
  const leftOut = paths.length - locations.length + more
  return { locations, moreLocations: leftOut > 0 ? leftOut : undefined }
}

/**
 * A saved tool step within the caps above: history written before them may hold more. A step
 * that fits comes back as it is, and nothing else in one that doesn't is changed.
 */
export function boundedTool<T extends ToolText>(tool: T): T {
  let bounded = tool
  if (typeof tool.title === 'string' && tool.title.length > MAX_TOOL_TITLE) {
    bounded = { ...bounded, title: clampMiddle(tool.title, MAX_TOOL_TITLE) }
  }
  const paths: unknown = tool.locations
  const isPath = (path: unknown): path is string => typeof path === 'string'
  if (
    Array.isArray(paths) &&
    (paths.length > MAX_TOOL_LOCATIONS ||
      paths.some((path) => !isPath(path) || path.length > MAX_TOOL_LOCATION))
  ) {
    const more = Number(tool.moreLocations)
    const counted = Number.isSafeInteger(more) && more > 0 ? more : 0
    bounded = { ...bounded, ...boundedLocations(paths.filter(isPath), counted) }
  }
  return bounded
}

/**
 * Usage events (main/analytics.ts) waiting to be sent, including ones a failed send kept for
 * the next try; past it the oldest go. One request carries at most a batch of them.
 */
export const MAX_QUEUED_USAGE_EVENTS = 500
export const USAGE_BATCH = 100

/** Theme panel: custom properties read from a page, the CSS files searched, one file's size, the palette prompt. */
export const MAX_THEME_VARIABLES = 2000
export const MAX_THEME_CSS_FILES = 400
export const MAX_THEME_CSS_BYTES = 2_000_000
export const MAX_PALETTE_PROMPT_CHARS = 6000
/** preview_theme's answer: past it, the rest of the variables are counted, not listed. */
export const MAX_THEME_TOOL_CHARS = 60_000
