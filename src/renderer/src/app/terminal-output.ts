import type { OutputChunk, Unsubscribe } from '../../../shared/ipc'
import { reportError } from '../lib/crash-reports'

/** ESC c: resets the terminal, in turn with what's being drawn. */
const RESET = '\u001bc'

/** The terminal a view draws into. */
export interface OutputTarget {
  write: (data: string) => void
  /** Its memory is past what a terminal needs: Ghostty leaks, and only a new one gives it back */
  outgrown: () => boolean
}

export interface OutputSource {
  /** All main keeps of the output, to draw first */
  snapshot: () => Promise<OutputChunk>
  /** The output as main sends it, while the view is on screen */
  subscribe: (cb: (chunk: OutputChunk) => void) => Unsubscribe
  /** Drawn up to `end`: main sends more, and lets go of a shell it held */
  ack: (id: string, end: number) => void
}

/**
 * Draws a drawer view's output into `target`: main's snapshot, then what main sends, past
 * what's drawn already. Each chunk is acknowledged once drawn: main sends more as the terminal
 * keeps up, and holds a shell printing faster than that. `replaying` is true while old output
 * draws (the snapshot, or all main kept when the view missed more than that): Ghostty answers
 * the queries in it (cursor position, colors) as if just asked, and those answers mustn't
 * reach the shell.
 *
 * A terminal that can't draw, or has outgrown its memory, asks to be made again (`remount`):
 * a new one draws main's snapshot, so nothing on screen is lost. A chunk is acknowledged even
 * when drawing it failed, so main never waits on a view that can't draw. Only a terminal that
 * has drawn before is made again, so one that can't draw main's snapshot doesn't loop.
 */
export function drawOutput(target: OutputTarget, source: OutputSource, remount: () => void) {
  /** Drawn, or on its way to the terminal, up to here; null until the snapshot is */
  let at: number | null = null
  /** Sent before the snapshot came, which main sends after them on the same channel */
  const early: OutputChunk[] = []
  let replaying = false
  let disposed = false
  let drawn = false
  let failed = false
  let remounting = false

  const draw = (chunk: OutputChunk, data: string, replay: boolean) => {
    at = chunk.end
    const drewBefore = drawn
    let threw = false
    try {
      // Waiting to be made again: what it draws now goes with it.
      if (remounting) return
      replaying = replay
      // Ghostty reads it all now, answering any queries in it as it goes; its callback waits
      // for a frame, which a hidden window never draws, and main would hold the shell meanwhile.
      target.write(data)
      drawn = true
    } catch (error) {
      threw = true
      // Once per terminal: one that keeps failing doesn't send a report per chunk.
      if (!failed) reportError(error)
      failed = true
    } finally {
      replaying = false
      if (!disposed) source.ack(chunk.id, chunk.end)
    }
    if (!remounting && drewBefore && (threw || target.outgrown())) {
      remounting = true
      remount()
    }
  }
  const receive = (chunk: OutputChunk) => {
    if (at === null) {
      early.push(chunk)
      return
    }
    if (chunk.end <= at) return
    const start = chunk.end - chunk.data.length
    // Main had already let go of some of what this view missed: it starts over.
    if (start > at) draw(chunk, RESET + chunk.data, true)
    else draw(chunk, chunk.data.slice(at - start), false)
  }

  const off = source.subscribe(receive)
  void source.snapshot().then((snapshot) => {
    if (disposed) return
    draw(snapshot, snapshot.data, true)
    for (const chunk of early.splice(0)) receive(chunk)
  })
  return {
    replaying: () => replaying,
    dispose() {
      disposed = true
      off()
    },
  }
}
