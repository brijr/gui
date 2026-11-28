/**
 * When a page in the preview may open a web address in the user's browser (a link with
 * target="_blank", or window.open). Only right after the user clicked or pressed a key in the
 * preview, once for each click or key, as a browser's pop-up rule has it, and never more than a
 * few in a short while. A page can't open tabs by itself, or a flood of them.
 */

/** How long after the user's click or key a page may still open a tab: Chromium's 5 seconds. */
export const OPEN_AFTER_INPUT_MS = 5000
/** The input events that count as the user's: a click or a key, never a move or a scroll. */
export const USER_GESTURES: ReadonlySet<string> = new Set([
  'mouseDown',
  'mouseUp',
  'rawKeyDown',
  'keyDown',
])
/** At most this many tabs in OPEN_WINDOW_MS, however many clicks. */
export const MAX_OPENS = 3
export const OPEN_WINDOW_MS = 10_000

/** The rule itself. `sinceInput` is null when the user's last input already opened a tab. */
export function mayOpenExternal(sinceInput: number | null, opensInWindow: number) {
  return (
    sinceInput !== null &&
    sinceInput >= 0 &&
    sinceInput <= OPEN_AFTER_INPUT_MS &&
    opensInWindow < MAX_OPENS
  )
}

/** One preview's clicks and keys, and the tabs its pages opened. */
export class ExternalOpens {
  private input: number | null = null
  private opened: number[] = []

  constructor(private readonly now: () => number = Date.now) {}

  /** The user clicked or pressed a key in the preview. */
  userInput() {
    this.input = this.now()
  }

  /** Whether the page may open a tab now; when it may, that uses up the input. */
  take() {
    const now = this.now()
    this.opened = this.opened.filter((at) => now - at < OPEN_WINDOW_MS)
    const since = this.input === null ? null : now - this.input
    if (!mayOpenExternal(since, this.opened.length)) return false
    this.input = null
    this.opened.push(now)
    return true
  }
}
