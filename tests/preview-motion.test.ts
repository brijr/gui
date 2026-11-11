import { describe, expect, test } from 'bun:test'
import {
  composeSheet,
  drawText,
  frameLabel,
  MAX_MOTION_FRAMES,
  motionSummary,
  motionTimeline,
  planMotion,
  SHEET_MAX,
  sheetLayout,
  textWidth,
} from '../src/main/preview-motion-format'
import type { TraceEntry } from '../src/main/recording-trace'

describe('planMotion', () => {
  test('fills in defaults', () => {
    expect(planMotion({})).toMatchObject({
      play: 'watch',
      durationMs: 1000,
      frames: 8,
      slowMotion: 1,
      reducedMotion: false,
      filmingMs: 1000,
    })
    expect(planMotion({ play: 'scroll' }).deltaY).toBe(400)
  })

  test('slow motion stretches filming', () => {
    expect(planMotion({ durationMs: 300, slowMotion: 4 }).filmingMs).toBe(1200)
  })

  test('caps say what to do instead', () => {
    expect(() => planMotion({ durationMs: 6000 })).toThrow(/capped at 5000 ms.*in parts/)
    expect(() => planMotion({ frames: 13 })).toThrow(/2–12.*slowMotion/)
    expect(() => planMotion({ frames: 1 })).toThrow(/2–12/)
    expect(() => planMotion({ slowMotion: 0.5 })).toThrow(/can't speed them up/)
    expect(() => planMotion({ slowMotion: 11 })).toThrow(/1–10/)
    expect(() => planMotion({ durationMs: 3000, slowMotion: 4 })).toThrow(
      /12\.0 s to film; the cap is 10 s/,
    )
  })

  test('each play gets what it needs', () => {
    expect(() => planMotion({ play: 'click' })).toThrow(/needs `selector`/)
    expect(() => planMotion({ play: 'hover' })).toThrow(/needs `selector`/)
    expect(() => planMotion({ play: 'press' })).toThrow(/needs `key`/)
    expect(() => planMotion({ play: 'watch', selector: '#a' })).toThrow(/pass it as `crop`/)
    expect(planMotion({ play: 'press', key: 'Escape' }).key).toBe('Escape')
  })
})

describe('sheetLayout', () => {
  test('stays within the image cap for every frame count and shape', () => {
    for (let count = 2; count <= MAX_MOTION_FRAMES; count++) {
      for (const frame of [
        { width: 2880, height: 1800 },
        { width: 780, height: 1688 },
        { width: 4000, height: 200 },
        { width: 200, height: 4000 },
      ]) {
        const layout = sheetLayout(count, frame)
        expect(layout.width).toBeLessThanOrEqual(SHEET_MAX.width)
        expect(layout.height).toBeLessThanOrEqual(SHEET_MAX.height)
        expect(layout.columns * layout.rows).toBeGreaterThanOrEqual(count)
        expect(layout.cells).toHaveLength(count)
        // Frames keep their shape.
        expect(layout.cellWidth / layout.cellHeight).toBeCloseTo(frame.width / frame.height, 0)
        for (const cell of layout.cells) {
          expect(cell.x + layout.cellWidth).toBeLessThanOrEqual(layout.width)
          expect(cell.y + layout.cellHeight).toBeLessThanOrEqual(layout.height)
        }
      }
    }
  })

  test('never draws frames larger than captured', () => {
    const layout = sheetLayout(2, { width: 120, height: 80 })
    expect(layout.cellWidth).toBe(120)
    expect(layout.cellHeight).toBe(80)
  })

  test('picks the grid that draws a laptop viewport largest', () => {
    const layout = sheetLayout(12, { width: 2880, height: 1800 })
    expect(layout.columns).toBe(3)
    expect(layout.rows).toBe(4)
    expect(layout.cellWidth).toBeGreaterThan(500)
  })

  test('frames read left to right, then down', () => {
    const { cells } = sheetLayout(4, { width: 100, height: 100 }, { width: 230, height: 300 })
    expect(cells[1].y).toBe(cells[0].y)
    expect(cells[1].x).toBeGreaterThan(cells[0].x)
    expect(cells[2].y).toBeGreaterThan(cells[0].y)
  })
})

describe('composeSheet', () => {
  const solid = (width: number, height: number, gray: number) => ({
    width,
    height,
    pixels: new Uint8Array(width * height * 4).fill(gray),
  })
  const at = (bitmap: { width: number; pixels: Uint8Array }, x: number, y: number) =>
    bitmap.pixels[(y * bitmap.width + x) * 4]

  test('places each frame in its cell, with a label above it', () => {
    const layout = sheetLayout(3, { width: 40, height: 30 })
    const sheet = composeSheet(
      layout,
      [solid(40, 30, 200), null, solid(40, 30, 120)],
      ['#1 0 ms', '#2 50 ms', '#3 100 ms'],
    )
    expect(sheet.width).toBe(layout.width)
    expect(sheet.pixels).toHaveLength(layout.width * layout.height * 4)
    const [first, missing, third] = layout.cells
    expect(at(sheet, first.x + 20, first.y + 15)).toBe(200)
    expect(at(sheet, third.x + 20, third.y + 15)).toBe(120)
    // A frame that wasn't captured is a flat cell, not the background.
    expect(at(sheet, missing.x + 20, missing.y + 15)).toBe(48)
    // Some of the label's pixels are lit above the first frame.
    let lit = 0
    for (let y = first.y - 20; y < first.y; y++)
      for (let x = first.x; x < first.x + textWidth('#1 0 ms'); x++)
        if (at(sheet, x, y) === 240) lit++
    expect(lit).toBeGreaterThan(20)
  })

  test('draws every character a label uses', () => {
    const label = frameLabel(11, 1234.4)
    expect(label).toBe('#12 1234 ms')
    for (const char of '#0123456789ms.-') {
      const bitmap = solid(20, 20, 0)
      drawText(bitmap, char, 2, 2)
      expect(bitmap.pixels.some((value) => value === 240)).toBe(true)
    }
  })
})

describe('motionTimeline', () => {
  const transition: TraceEntry = {
    kind: 'animation',
    at: 8,
    type: 'transition',
    target: 'div#panel',
    name: 'opacity',
    duration: 200,
    delay: 0,
    easing: 'ease-out',
    iterations: 1,
    changes: ['opacity 0 → 1'],
  }

  test('pairs each animation with its end', () => {
    const log = motionTimeline([
      { kind: 'input', at: 0, event: 'click', target: 'button#toggle' },
      transition,
      { kind: 'animation-end', at: 212, target: 'div#panel', name: 'opacity' },
      { kind: 'class', at: 2, target: 'div#panel', added: ['open'], removed: [] },
    ])
    expect(log).toContain('CSS and Web Animations (1), start–end:')
    expect(log).toContain('8–212 ms  CSS transition opacity on div#panel: 200 ms ease-out')
    expect(log).toContain('opacity 0 → 1')
    expect(log).toContain('Also in the page:')
    expect(log).toContain('click button#toggle')
    expect(log).toContain('class on div#panel: +open')
    expect(log).not.toContain('finished:')
  })

  test('says what still runs, was cancelled, or ran before filming', () => {
    const log = motionTimeline([
      { ...transition, at: 0, running: true },
      {
        ...transition,
        type: 'css-animation',
        name: 'spin',
        target: 'span.loader',
        iterations: 'infinite',
      },
      { ...transition, target: 'p', at: 10 },
      { kind: 'animation-end', at: 40, target: 'p', name: 'opacity', cancelled: true },
    ])
    expect(log).toContain(
      '…–… ms  CSS transition opacity on div#panel: 200 ms ease-out (already running as filming began; still running at the end)',
    )
    expect(log).toContain(
      'CSS animation spin on span.loader: 200 ms ease-out, infinite iterations (still running at the end)',
    )
    expect(log).toContain('10–40 ms  CSS transition opacity on p')
    expect(log).toContain('(cancelled)')
  })

  test('a replay starts what it restarted at 0', () => {
    const log = motionTimeline(
      [
        { ...transition, type: 'css-animation', name: 'pulse', at: 0, running: true },
        { kind: 'animation-end', at: 800, target: 'div#panel', name: 'pulse' },
      ],
      { replayed: true },
    )
    expect(log).toContain('0–800 ms  CSS animation pulse on div#panel: 200 ms ease-out\n')
  })

  test('slow motion puts times in the animations’ own time', () => {
    const log = motionTimeline(
      [
        { ...transition, at: 32 },
        { kind: 'animation-end', at: 832, target: 'div#panel', name: 'opacity' },
        { kind: 'slow-frame', at: 400, duration: 80, blocking: 0 },
      ],
      { slowMotion: 4 },
    )
    expect(log).toContain('8–208 ms')
    expect(log).toContain('100 ms  slow frame: 80 ms')
  })

  test('without animations, it points at the frames for script-driven motion', () => {
    expect(motionTimeline([])).toContain('Motion driven by JavaScript')
  })
})

describe('motionSummary', () => {
  const frames = (gaps: number[]) => {
    const out = [{ at: 0, captured: true }]
    for (const gap of gaps) out.push({ at: (out.at(-1)?.at ?? 0) + gap, captured: true })
    return out
  }

  test('says what it played and how the sheet reads', () => {
    const plan = planMotion({ play: 'click', selector: '#toggle', durationMs: 600, frames: 4 })
    const text = motionSummary(plan, frames([200, 200, 200]), { width: 800, height: 600 })
    expect(text).toContain('Clicked `#toggle` and filmed 600 ms: 4 frames in one 800×600 image')
    expect(text).not.toContain('keep up')
    expect(text).not.toContain('back to normal')
  })

  test('says slow and reduced motion were undone', () => {
    const plan = planMotion({ durationMs: 300, frames: 4, slowMotion: 4, reducedMotion: true })
    const text = motionSummary(plan, frames([100, 100, 100]), { width: 1, height: 1 })
    expect(text).toContain('Slow motion 4×')
    expect(text).toContain('filming took 1200 ms')
    expect(text).toContain('prefers-reduced-motion: reduce was emulated')
    expect(text).toContain('back to normal speed')
  })

  test('owns up to frames further apart than asked, and blank ones', () => {
    const plan = planMotion({ durationMs: 100, frames: 6 })
    const timed = frames([60, 10, 10, 10, 10])
    timed[2].captured = false
    const text = motionSummary(plan, timed, { width: 1, height: 1 })
    expect(text).toContain('frames are up to 60 ms apart (20 ms planned)')
    expect(text).toContain("1 frame couldn't be captured")
  })
})
