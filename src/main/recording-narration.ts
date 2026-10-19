import type { CursorLog } from './recording-cursor'
import type { TraceEntry } from './recording-trace'
import type { Transcript, TranscriptSegment } from './transcribe'

/**
 * A narrated recording for the agent: each thing the user said, when, and what the pointer
 * was on meanwhile, so "this" and "here" can be resolved; and which frames to show it.
 */

/** Words that point at something on screen; a frame is shown as each one is said. */
const POINTING = new Set(['this', 'that', 'these', 'those', 'here', 'there'])
const MAX_FRAMES = 8
/** Picks closer than this show the same moment; only the most telling is kept. */
const MIN_GAP_MS = 700
const MAX_SEGMENTS = 150

export interface NarrationFrame {
  index: number
  at: number
  /** What was going on then: the words and the pointer */
  label: string
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`
const span = (start: number, end: number) => `${(start / 1000).toFixed(1)}–${seconds(end)}`
const point = (x: number, y: number) => `${Math.round(x)},${Math.round(y)}`
const clip = (text: string, size: number) =>
  text.length > size ? `${text.slice(0, size - 1)}…` : text
const bare = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')

export function transcriptText(transcript: Transcript) {
  return transcript.segments
    .map((segment) => segment.text)
    .join(' ')
    .trim()
}

/** What the pointer was on at `at`: the latest target seen up to then. */
function targetAt(cursor: CursorLog, at: number) {
  let found: string | null = null
  for (const target of cursor.targets) {
    if (target.at > at) break
    found = target.target
  }
  return found
}

function sampleAt(cursor: CursorLog, at: number) {
  let found: CursorLog['samples'][number] | null = null
  for (const sample of cursor.samples) {
    if (sample.at > at) break
    found = sample
  }
  return found
}

/** One line on where the pointer was at a moment, or null when it wasn't tracked. */
export function pointerAt(cursor: CursorLog | null, at: number): string | null {
  if (!cursor) return null
  const dwell = cursor.dwells.find((held) => held.at <= at && held.end >= at)
  if (dwell) return `held still on ${dwell.target ?? 'the page'} at ${point(dwell.x, dwell.y)}`
  const sample = sampleAt(cursor, at)
  if (!sample) return null
  if (sample.out) return 'outside the preview'
  const target = targetAt(cursor, at)
  return `at ${point(sample.x, sample.y)}${target ? ` over ${target}` : ''}`
}

function clicks(timeline: TraceEntry[]) {
  return timeline.filter(
    (entry): entry is Extract<TraceEntry, { kind: 'input' }> =>
      entry.kind === 'input' && entry.event === 'click',
  )
}

/** The pointer during one stretch of speech, as indented lines. */
function during(
  cursor: CursorLog | null,
  timeline: TraceEntry[],
  start: number,
  end: number,
): string[] {
  const lines: string[] = []
  if (cursor) {
    const held = cursor.dwells.filter((dwell) => dwell.end >= start && dwell.at <= end)
    for (const dwell of held.slice(0, 3))
      lines.push(
        `pointer held still on ${dwell.target ?? 'the page'} at ${point(dwell.x, dwell.y)} (${span(dwell.at, dwell.end)})`,
      )
    if (!held.length) {
      const passed = cursor.targets.filter((target) => target.at >= start && target.at <= end)
      const names = [...new Set(passed.map((target) => target.target))]
      if (names.length > 1)
        lines.push(
          `pointer moved over ${names.slice(0, 4).join(' → ')}${names.length > 4 ? ' → …' : ''}`,
        )
      else {
        const where = pointerAt(cursor, (start + end) / 2)
        if (where) lines.push(`pointer ${where}`)
      }
    }
  }
  for (const click of clicks(timeline).filter((entry) => entry.at >= start && entry.at <= end))
    lines.push(`clicked ${click.target ?? 'the page'} at ${seconds(click.at)}`)
  return lines
}

interface Pick {
  at: number
  rank: number
  label: string
}

/** The frame captured nearest `at`. */
function nearest(timestamps: number[], at: number) {
  let best = 0
  for (let index = 1; index < timestamps.length; index++)
    if (Math.abs(timestamps[index] - at) < Math.abs(timestamps[best] - at)) best = index
  return best
}

function spokenAround(segments: TranscriptSegment[], at: number) {
  const segment = segments.find((part) => part.start <= at && part.end >= at)
  if (!segment) return null
  const index = segment.words.findIndex((word) => word.start <= at && word.end >= at)
  if (index < 0) return clip(segment.text, 80)
  const from = Math.max(0, index - 4)
  return `${from > 0 ? '…' : ''}${segment.words
    .slice(from, index + 5)
    .map((word) => word.text)
    .join(' ')}${index + 5 < segment.words.length ? '…' : ''}`
}

/**
 * Which frames to show the agent: as a pointing word is said, where the pointer held still,
 * at clicks, then the middle of each sentence, at most MAX_FRAMES and never two of a moment.
 */
export function narrationFrames(
  transcript: Transcript | null,
  cursor: CursorLog | null,
  timeline: TraceEntry[],
  timestamps: number[],
  max = MAX_FRAMES,
): NarrationFrame[] {
  if (!timestamps.length) return []
  const segments = transcript?.segments ?? []
  const picks: Pick[] = []
  for (const segment of segments)
    for (const word of segment.words)
      if (POINTING.has(bare(word.text)))
        picks.push({ at: (word.start + word.end) / 2, rank: 0, label: `saying "${word.text}"` })
  for (const dwell of cursor?.dwells ?? [])
    picks.push({
      at: Math.min(dwell.end, dwell.at + 600),
      rank: 1,
      label: 'pointer holding still',
    })
  for (const click of clicks(timeline)) picks.push({ at: click.at, rank: 2, label: 'click' })
  for (const segment of segments)
    picks.push({ at: (segment.start + segment.end) / 2, rank: 3, label: 'mid-sentence' })
  picks.sort((a, b) => a.rank - b.rank || a.at - b.at)
  const kept: Pick[] = []
  for (const pick of picks) {
    if (kept.length >= max) break
    if (kept.some((other) => Math.abs(other.at - pick.at) < MIN_GAP_MS)) continue
    kept.push(pick)
  }
  const seen = new Set<number>()
  return kept
    .sort((a, b) => a.at - b.at)
    .map((pick) => ({ ...pick, index: nearest(timestamps, pick.at) }))
    .filter((pick) => !seen.has(pick.index) && seen.add(pick.index))
    .map((pick) => {
      const said = spokenAround(segments, pick.at)
      const where = pointerAt(cursor, timestamps[pick.index])
      return {
        index: pick.index,
        at: timestamps[pick.index],
        label: [said ? `while saying "${said}"` : pick.label, where ? `pointer ${where}` : null]
          .filter(Boolean)
          .join('; '),
      }
    })
}

/**
 * The narration as text: each sentence with its time and what the pointer did meanwhile.
 * Without a transcript, only where the pointer held still.
 */
export function formatNarration(
  transcript: Transcript | null,
  cursor: CursorLog | null,
  timeline: TraceEntry[],
  { startMs = 0, endMs = Infinity }: { startMs?: number; endMs?: number } = {},
): string {
  const lines: string[] = []
  const segments = (transcript?.segments ?? []).filter(
    (segment) => segment.end >= startMs && segment.start <= endMs,
  )
  for (const segment of segments.slice(0, MAX_SEGMENTS)) {
    lines.push(`[${span(segment.start, segment.end)}] "${segment.text}"`)
    for (const line of during(cursor, timeline, segment.start, segment.end))
      lines.push(`    ${line}`)
  }
  if (segments.length > MAX_SEGMENTS)
    lines.push(`… ${segments.length - MAX_SEGMENTS} more sentences`)
  if (!segments.length && cursor) {
    const held = cursor.dwells.filter((dwell) => dwell.end >= startMs && dwell.at <= endMs)
    for (const dwell of held.slice(0, 40))
      lines.push(
        `[${span(dwell.at, dwell.end)}] pointer held still on ${dwell.target ?? 'the page'} at ${point(dwell.x, dwell.y)}`,
      )
  }
  return lines.join('\n')
}

const stamp = (ms: number) => {
  const total = Math.max(0, Math.round(ms))
  const h = Math.floor(total / 3_600_000)
  const m = Math.floor(total / 60_000) % 60
  const s = Math.floor(total / 1000) % 60
  const pad = (value: number, size = 2) => String(value).padStart(size, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(total % 1000, 3)}`
}

/** WebVTT captions for the player: short cues of a few words, timed by the words. */
export function captionsVtt(transcript: Transcript) {
  const cues: { start: number; end: number; text: string }[] = []
  for (const segment of transcript.segments) {
    if (!segment.words.length) {
      cues.push({ start: segment.start, end: segment.end, text: segment.text })
      continue
    }
    for (let index = 0; index < segment.words.length; ) {
      const first = segment.words[index]
      let last = index
      while (
        last + 1 < segment.words.length &&
        last - index < 9 &&
        segment.words[last + 1].end - first.start <= 4000
      )
        last++
      const words = segment.words.slice(index, last + 1)
      cues.push({
        start: first.start,
        end: Math.max(words.at(-1)?.end ?? first.end, first.start + 1),
        text: words.map((word) => word.text).join(' '),
      })
      index = last + 1
    }
  }
  const body = cues
    .map(
      (cue, index) =>
        `${index + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text.replace(/-->/g, '→')}`,
    )
    .join('\n\n')
  return `WEBVTT\n\n${body}\n`
}
