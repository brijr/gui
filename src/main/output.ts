import { MAX_OUTPUT_BYTES } from '../shared/bounded'
import type { OutputChunk } from '../shared/ipc'

/** Output kept per terminal and for the dev server, to draw it again after switching tabs. */
const MAX_OUTPUT = MAX_OUTPUT_BYTES
/** Trimmed back to `MAX_OUTPUT` only past this much more, so a flood isn't copied per read. */
const TRIM_SLACK = 64 * 1024
/** Output waits this long to go out with what follows it: about a frame. */
const FRAME_MS = 16
/** Or at once when there's this much: more in one message would hold up the page drawing it. */
const BATCH = 256 * 1024
/**
 * Sent but not yet drawn: past the high mark the program printing is held, or for one that
 * can't be held nothing more is sent; below the low mark it goes on.
 */
const HIGH_WATER = 512 * 1024
const LOW_WATER = 128 * 1024
/** Longest a program is held for a view that isn't catching up (a hidden window draws rarely). */
const STALL_MS = 1000

export interface OutputOptions {
  /** Main → the view drawing it (the chrome's drawer) */
  send: (chunk: OutputChunk) => void
  /** Holds or lets go of the program printing it: a terminal's shell. The dev server never waits. */
  hold?: (held: boolean) => void
}

/**
 * Output for one of the drawer's views, a terminal's or the dev server's. Main keeps the last
 * of it, to draw it again, and sends only what the view showing it can draw: a frame's worth
 * at a time, and only while that view is on screen. Out of sight, the program goes on and its
 * output is only kept; the view catches up once shown. On screen, the view acknowledges what
 * it has drawn, and a program that prints faster than that is held until it catches up, as a
 * terminal is when it can't keep up.
 *
 * Positions are in characters since the output began, so the view can tell what it has.
 */
export class Output {
  private text = ''
  /** Where the output so far ends */
  private end = 0
  /** Sent to the view, up to here */
  private sent = 0
  /** Drawn by the view, as it last said */
  private drawn = 0
  private shown = false
  private held = false
  /** The view stopped keeping up while the program was held, which then went on without it. */
  private stalled = false
  private flushTimer: NodeJS.Timeout | null = null
  private stallTimer: NodeJS.Timeout | null = null

  constructor(
    readonly id: string,
    private readonly options: OutputOptions,
  ) {}

  /** All main keeps, for a view to start from. */
  snapshot(): OutputChunk {
    return { id: this.id, data: this.text, end: this.end }
  }

  append(chunk: string) {
    this.text += chunk
    this.end += chunk.length
    if (this.text.length > MAX_OUTPUT + TRIM_SLACK) {
      // From the start of a line, so drawing it again doesn't begin inside an escape sequence.
      const kept = this.text.slice(-MAX_OUTPUT)
      this.text = kept.slice(kept.indexOf('\n') + 1)
    }
    // Out of sight it's only kept, and the program goes on.
    if (!this.streaming) return
    if (this.end - this.sent >= BATCH) this.flush()
    else this.flushTimer ??= setTimeout(() => this.flush(), FRAME_MS)
    this.updateHold()
  }

  /** ⌘K: forgets what was printed, except the line the cursor is on (the prompt). */
  clear() {
    this.text = this.text.slice(this.text.lastIndexOf('\n') + 1)
  }

  /** On screen or not: only output on screen is sent, and only its program is ever held. */
  setShown(shown: boolean) {
    if (shown === this.shown) return
    this.shown = shown
    // What it printed meanwhile, at once.
    this.flush()
    this.updateHold()
  }

  /** The view has drawn everything before `end`. */
  ack(end: number) {
    // A view that drew main's snapshot can be further on than what was sent to it.
    const drawn = Math.min(end, this.end)
    if (drawn <= this.drawn) return
    this.drawn = drawn
    this.sent = Math.max(this.sent, drawn)
    if (this.stalled && this.drawn === this.sent) {
      this.stalled = false
      this.flush()
    } else if (this.streaming && this.end > this.sent) {
      // What waited for it to catch up.
      this.flushTimer ??= setTimeout(() => this.flush(), FRAME_MS)
    }
    this.updateHold()
  }

  /** Lets go of the program, if it's held, and sends nothing more. */
  dispose() {
    this.shown = false
    this.updateHold()
    this.clearTimers()
  }

  private get streaming() {
    return this.shown && !this.stalled
  }

  private flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (!this.streaming || this.end === this.sent) return
    // The view is far enough behind that more would only queue up there; for a program that
    // can't be held, its output is only kept until the view catches up.
    if (this.sent - this.drawn >= HIGH_WATER) return
    // What's new since; or, if some of it was already let go (it printed a lot out of sight),
    // all that's left, which the view starts over with.
    const start = this.end - this.text.length
    const data = this.text.slice(Math.max(0, this.sent - start))
    this.sent = this.end
    this.options.send({ id: this.id, data, end: this.end })
  }

  private updateHold() {
    if (!this.options.hold) return
    const behind = this.end - this.drawn
    const hold = this.streaming && behind >= (this.held ? LOW_WATER : HIGH_WATER)
    if (hold === this.held) return
    this.held = hold
    this.options.hold(hold)
    if (this.stallTimer) clearTimeout(this.stallTimer)
    this.stallTimer = null
    if (!hold) return
    // A program is never held for long by a view that isn't drawing: it goes on, and the view
    // catches up from what's kept once it has drawn what it was sent.
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null
      this.stalled = true
      this.updateHold()
    }, STALL_MS)
  }

  private clearTimers() {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.stallTimer) clearTimeout(this.stallTimer)
    this.flushTimer = null
    this.stallTimer = null
  }
}
