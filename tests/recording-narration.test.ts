import { describe, expect, test } from 'bun:test'
import type { CursorLog } from '../src/main/recording-cursor'
import {
  captionsVtt,
  formatNarration,
  narrationFrames,
  pointerAt,
  transcriptText,
} from '../src/main/recording-narration'
import type { TraceEntry } from '../src/main/recording-trace'
import type { Transcript } from '../src/main/transcribe'

const words = (text: string, start: number, step = 300) =>
  text.split(' ').map((word, index) => ({
    start: start + index * step,
    end: start + (index + 1) * step,
    text: word,
  }))

const transcript: Transcript = {
  engine: 'apple',
  locale: 'en-US',
  segments: [
    {
      start: 0,
      end: 1800,
      text: 'So when I hover this card,',
      words: words('So when I hover this card,', 0),
    },
    {
      start: 2000,
      end: 4100,
      text: 'the price here is misaligned.',
      words: words('the price here is misaligned.', 2000, 420),
    },
  ],
}

const cursor: CursorLog = {
  viewport: { width: 1280, height: 800 },
  samples: [
    { at: 0, x: 100, y: 100 },
    { at: 900, x: 412, y: 318 },
    { at: 2300, x: 470, y: 362 },
    { at: 4500, x: 470, y: 362, out: true },
  ],
  dwells: [{ at: 1000, end: 1900, x: 412, y: 318, target: 'div.card > h3 "Pro plan"' }],
  targets: [
    { at: 0, x: 100, y: 100, target: 'header' },
    { at: 950, x: 412, y: 318, target: 'div.card > h3 "Pro plan"' },
    { at: 2300, x: 470, y: 362, target: 'span.price "$24/mo"' },
    { at: 3100, x: 470, y: 362, target: 'div.card > p "Billed yearly"' },
  ],
}

const timeline: TraceEntry[] = [
  { kind: 'input', at: 3500, event: 'click', target: 'button "Choose"' },
]

const timestamps = Array.from({ length: 46 }, (_, index) => index * 100)

describe('narration', () => {
  test('transcript text joins the sentences', () => {
    expect(transcriptText(transcript)).toBe(
      'So when I hover this card, the price here is misaligned.',
    )
  })

  test('each sentence carries what the pointer did meanwhile', () => {
    const text = formatNarration(transcript, cursor, timeline)
    expect(text).toContain('[0.0–1.8 s] "So when I hover this card,"')
    expect(text).toContain('pointer held still on div.card > h3 "Pro plan" at 412,318')
    expect(text).toContain('[2.0–4.1 s] "the price here is misaligned."')
    expect(text).toContain('pointer moved over span.price "$24/mo" → div.card > p "Billed yearly"')
    expect(text).toContain('clicked button "Choose" at 3.5 s')
  })

  test('a time range keeps only the sentences in it', () => {
    const text = formatNarration(transcript, cursor, timeline, { startMs: 1900 })
    expect(text).not.toContain('hover this card')
    expect(text).toContain('misaligned')
  })

  test('without a transcript, it lists where the pointer held still', () => {
    expect(formatNarration(null, cursor, [])).toBe(
      '[1.0–1.9 s] pointer held still on div.card > h3 "Pro plan" at 412,318',
    )
    expect(formatNarration(null, null, [])).toBe('')
  })

  test('pointer position at a moment', () => {
    expect(pointerAt(cursor, 1500)).toBe('held still on div.card > h3 "Pro plan" at 412,318')
    expect(pointerAt(cursor, 2400)).toBe('at 470,362 over span.price "$24/mo"')
    expect(pointerAt(cursor, 4600)).toBe('outside the preview')
    expect(pointerAt(null, 100)).toBeNull()
  })

  test('frames go where the user points and speaks, a moment at most once', () => {
    // "this" at 1350 ms and "here" at 3050 ms win; the dwell (1600), the click (3500) and the
    // sentences' middles are the same moments.
    const frames = narrationFrames(transcript, cursor, timeline, timestamps)
    expect(frames.map((frame) => frame.at)).toEqual([1300, 3000])
    const pointing = frames[0]
    expect(pointing?.label).toContain('while saying "')
    expect(pointing?.label).toContain('this')
    expect(pointing?.label).toContain('pointer held still on div.card > h3 "Pro plan"')
  })

  test('without pointing words, frames go to pauses, clicks and sentences', () => {
    const plain: Transcript = {
      ...transcript,
      segments: transcript.segments.map((segment) => ({
        ...segment,
        words: segment.words.filter((word) => !['this', 'here'].includes(word.text)),
      })),
    }
    const times = narrationFrames(plain, cursor, timeline, timestamps).map((frame) => frame.at)
    expect(times).toEqual([900, 1600, 3500])
  })

  test('frames are capped and need captured frames', () => {
    expect(narrationFrames(transcript, cursor, timeline, timestamps, 2)).toHaveLength(2)
    expect(narrationFrames(transcript, cursor, timeline, [])).toEqual([])
  })

  test('captions are short cues timed by the words', () => {
    const vtt = captionsVtt({
      ...transcript,
      segments: [
        {
          start: 0,
          end: 6000,
          text: 'one two three four five six seven eight nine ten eleven twelve',
          words: words('one two three four five six seven eight nine ten eleven twelve', 0, 250),
        },
      ],
    })
    expect(vtt.startsWith('WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.500\n')).toBe(true)
    expect(vtt).toContain('one two three four five six seven eight nine ten\n')
    expect(vtt).toContain('2\n00:00:02.500 --> 00:00:03.000\neleven twelve')
  })
})
