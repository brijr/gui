/**
 * Caps for things that grow with use (transcripts, checkpoints, listings). Callers share
 * these instead of inventing a new limit per feature.
 */
export const MAX_HISTORY_VERSIONS = 100
/** New or changed files bigger than this aren't kept in a checkpoint. */
export const MAX_CHECKPOINT_FILE_BYTES = 10 * 1024 * 1024
/** Output kept per terminal / dev server so the drawer can redraw after a tab switch. */
export const MAX_OUTPUT_BYTES = 512 * 1024

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

/** Newest `max` items, in the same order. */
export function bounded<T>(items: readonly T[], max: number): T[] {
  if (max <= 0) return []
  return items.length <= max ? [...items] : items.slice(-max)
}

/** Consecutive slices of `size`, last one shorter if needed. */
export function* chunked<T>(items: readonly T[], size: number): Generator<T[]> {
  const step = Math.max(1, size)
  for (let i = 0; i < items.length; i += step) yield items.slice(i, i + step)
}

/** FIFO that drops the oldest item once it reaches `max`. */
export class BoundedQueue<T> {
  private items: T[] = []

  constructor(private readonly max: number) {}

  get size() {
    return this.items.length
  }

  push(item: T) {
    this.items.push(item)
    if (this.items.length > this.max) this.items.shift()
  }

  peek(): T | undefined {
    return this.items[0]
  }

  shift(): T | undefined {
    return this.items.shift()
  }

  toArray(): T[] {
    return [...this.items]
  }

  clear() {
    this.items = []
  }
}
