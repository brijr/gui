import type { WebContents } from 'electron'
import { RECORDING_FPS } from '../shared/bounded'
import { type ViewPoint, viewPoint, viewportFromView } from '../shared/coords'
import type { RecordingCursor } from '../shared/types'

/**
 * Where the mouse was while the preview was recorded, so the agent can tell what the user
 * pointed at ("this button"). Positions are viewport CSS pixels of the previewed page.
 */

export interface CursorSample {
  at: number
  x: number
  y: number
  down?: true
  /** The pointer left the preview; x and y are where it last was */
  out?: true
}

/** The pointer held still: the strongest sign the user is pointing at something. */
export interface CursorDwell {
  at: number
  end: number
  x: number
  y: number
  target: string | null
}

/** The element under the pointer changed. */
export interface CursorTarget {
  at: number
  x: number
  y: number
  target: string
}

export interface CursorLog {
  /** The page's viewport, CSS px: what x and y are measured in */
  viewport: { width: number; height: number }
  samples: CursorSample[]
  dwells: CursorDwell[]
  targets: CursorTarget[]
}

/** Where the pointer is for the recorder drawing it: fractions of the preview's size. */
export type CursorFrame = Omit<RecordingCursor, 'id'>

const POLL_MS = 16
/**
 * The recorder draws at most RECORDING_FPS times a second, so the pointer is sent no more
 * often than that (with half a poll of slack, so every other poll can send). A press or
 * release, or leaving the preview, goes at once.
 */
const SEND_MS = 1000 / RECORDING_FPS - POLL_MS / 2
const LOCATE_MS = 250
/** Moving less than this (view px) still counts as holding still. */
const DWELL_SLOP = 6
const DWELL_MS = 400
const MAX_SAMPLES = 12_000
const MAX_MARKS = 600

const now = () => performance.timeOrigin + performance.now()

export class CursorTrack {
  private samples: CursorSample[] = []
  private dwells: CursorDwell[] = []
  private targets: CursorTarget[] = []
  private timer: NodeJS.Timeout
  private down = false
  private last: { x: number; y: number; inside: boolean; down: boolean } | null = null
  private anchor: { x: number; y: number; since: number } | null = null
  private dwell: CursorDwell | null = null
  private located = { at: 0, x: Number.NaN, y: Number.NaN, target: '' }
  private locating = false
  /** Lookups still running, which `finish` waits for (each gives up within a second) */
  private pending = new Set<Promise<unknown>>()
  private viewport = { width: 0, height: 0 }
  private stopped = false
  /** The newest position not sent to the recorder yet */
  private unsent: CursorFrame | null = null
  private sent: { at: number; down: boolean; inside: boolean } | null = null
  private readonly onInput = (_event: unknown, input: Electron.InputEvent) => {
    if (input.type === 'mouseDown') this.down = true
    else if (input.type === 'mouseUp') this.down = false
    else return
    this.poll()
  }

  constructor(
    private contents: WebContents,
    private options: {
      /** The pointer over the preview in view px, or null when it's elsewhere */
      pointer: () => ViewPoint | null
      /** The preview's size in view px */
      size: () => { width: number; height: number }
      /** Device frame or zoom scale: view px per CSS px */
      scale: () => number
      /** The element at a viewport point, described for the agent */
      locate: (x: number, y: number) => Promise<string | null>
      /** Each change, for the recorder to draw */
      onFrame: (frame: CursorFrame) => void
    },
  ) {
    contents.on('input-event', this.onInput)
    this.timer = setInterval(() => this.poll(), POLL_MS)
    this.poll()
  }

  /** Everything tracked, with times relative to `startedAt` (epoch ms), up to `durationMs`. */
  async finish(startedAt: number, durationMs: number): Promise<CursorLog> {
    this.stop()
    await Promise.allSettled([...this.pending])
    const rel = (at: number) => Math.max(0, Math.round((at - startedAt) * 10) / 10)
    const within = (at: number) => at - startedAt <= durationMs + 50
    const round = (value: number) => Math.round(value * 10) / 10
    return {
      viewport: this.viewport,
      samples: this.samples
        .filter((sample) => within(sample.at))
        .map((sample) => ({
          ...sample,
          at: rel(sample.at),
          x: round(sample.x),
          y: round(sample.y),
        })),
      dwells: this.dwells
        .filter((dwell) => within(dwell.at) && dwell.end - startedAt >= 0)
        .map((dwell) => ({
          ...dwell,
          at: rel(dwell.at),
          end: Math.min(rel(dwell.end), durationMs),
          x: round(dwell.x),
          y: round(dwell.y),
        })),
      targets: this.targets
        .filter((target) => within(target.at))
        .map((target) => ({
          ...target,
          at: rel(target.at),
          x: round(target.x),
          y: round(target.y),
        })),
    }
  }

  dispose() {
    this.stop()
  }

  private stop() {
    if (this.stopped) return
    this.stopped = true
    clearInterval(this.timer)
    if (!this.contents.isDestroyed()) this.contents.off('input-event', this.onInput)
  }

  private poll() {
    if (this.stopped) return
    const size = this.options.size()
    if (size.width <= 0 || size.height <= 0) return
    const scale = this.options.scale() || 1
    this.viewport = {
      width: Math.round(size.width / scale),
      height: Math.round(size.height / scale),
    }
    const view = this.options.pointer()
    const inside = view !== null
    const at = now()
    const previous = this.last
    // Outside, it stays where it was last seen.
    const point = view ?? (previous ? { x: previous.x, y: previous.y } : null)
    if (!point) return
    const down = inside && this.down
    if (
      previous &&
      previous.inside === inside &&
      previous.down === down &&
      Math.abs(previous.x - point.x) < 0.5 &&
      Math.abs(previous.y - point.y) < 0.5
    ) {
      this.send(at)
      this.track(at, inside, point)
      return
    }
    this.last = { x: point.x, y: point.y, inside, down }
    const css = viewportFromView(viewPoint(point.x, point.y), scale)
    if (this.samples.length < MAX_SAMPLES)
      this.samples.push({
        at,
        x: css.x,
        y: css.y,
        ...(down ? { down: true as const } : {}),
        ...(inside ? {} : { out: true as const }),
      })
    this.unsent = { x: point.x / size.width, y: point.y / size.height, down, inside }
    this.send(at)
    this.track(at, inside, point)
  }

  /** Passes the newest position on to the recorder, at the rate it draws. */
  private send(at: number) {
    const frame = this.unsent
    if (!frame) return
    const sent = this.sent
    const changed = !sent || sent.down !== frame.down || sent.inside !== frame.inside
    if (!changed && at - sent.at < SEND_MS) return
    this.unsent = null
    this.sent = { at, down: frame.down, inside: frame.inside }
    this.options.onFrame(frame)
  }

  /** Holding still and what's underneath, from the pointer's view position. */
  private track(at: number, inside: boolean, point: { x: number; y: number }) {
    if (!inside) {
      this.anchor = null
      this.dwell = null
      return
    }
    const anchor = this.anchor
    if (!anchor || Math.hypot(point.x - anchor.x, point.y - anchor.y) > DWELL_SLOP) {
      this.anchor = { x: point.x, y: point.y, since: at }
      this.dwell = null
    } else if (this.dwell) {
      this.dwell.end = at
    } else if (at - anchor.since >= DWELL_MS && this.dwells.length < MAX_MARKS) {
      const css = viewportFromView(viewPoint(anchor.x, anchor.y), this.options.scale() || 1)
      const dwell: CursorDwell = { at: anchor.since, end: at, x: css.x, y: css.y, target: null }
      this.dwell = dwell
      this.dwells.push(dwell)
      this.wait(
        this.options.locate(css.x, css.y).then((target) => {
          dwell.target = target
        }),
      )
    }
    if (this.locating || at - this.located.at < LOCATE_MS) return
    if (point.x === this.located.x && point.y === this.located.y) return
    this.locating = true
    this.located = { ...this.located, at, x: point.x, y: point.y }
    const css = viewportFromView(viewPoint(point.x, point.y), this.options.scale() || 1)
    this.wait(
      this.options
        .locate(css.x, css.y)
        .then((target) => {
          if (!target || target === this.located.target) return
          this.located.target = target
          if (this.targets.length < MAX_MARKS) this.targets.push({ at, x: css.x, y: css.y, target })
        })
        .finally(() => {
          this.locating = false
        }),
    )
  }

  private wait(task: Promise<unknown>) {
    const settled = task.catch(() => undefined).finally(() => this.pending.delete(settled))
    this.pending.add(settled)
  }
}
