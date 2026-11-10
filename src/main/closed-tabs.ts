/** How many closed tabs a window remembers for File → Reopen Closed Tab (⇧⌘T). */
export const CLOSED_TAB_LIMIT = 10

/** A tab closed with a project or a canvas in it: enough to open it again where it was. */
export interface ClosedTab {
  kind: 'project' | 'canvas'
  /** The project's folder, or the canvas's */
  root: string
  /** Where it was in the tab strip */
  index: number
}

/**
 * A window's closed tabs, the most recent last, as Safari and Chrome keep them. Only what's
 * needed to open each again: reopening is a fresh opening, never the old tab revived.
 */
export class ClosedTabs {
  private stack: ClosedTab[] = []

  constructor(private readonly limit = CLOSED_TAB_LIMIT) {}

  get size() {
    return this.stack.length
  }

  /** Remembers a closed tab, forgetting the oldest past the limit. */
  push(tab: ClosedTab) {
    this.stack.push(tab)
    if (this.stack.length > this.limit) this.stack.splice(0, this.stack.length - this.limit)
  }

  /** The tab closed most recently, no longer remembered. */
  pop() {
    return this.stack.pop()
  }
}

/** Where a reopened tab goes: where it was, or the end if the strip has fewer tabs now. */
export function reopenIndex(tab: ClosedTab, tabCount: number) {
  return Math.max(0, Math.min(tab.index, tabCount))
}
