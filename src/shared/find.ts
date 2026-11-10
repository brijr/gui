/**
 * Edit → Find (⌘F), Find Next (⌘G) and Find Previous (⇧⌘G): what they search, and the plain
 * text search the drawer's terminals use. The preview searches with Chromium's own find.
 */

/** The longest text the find bar searches for. */
export const MAX_FIND_TEXT = 1000

/** What Find searches: the preview's page, or the drawer's terminal that has the keyboard. */
export type FindArea = 'preview' | 'terminal'

/** Which Find command was chosen. */
export type FindAction = 'show' | 'next' | 'previous'

/** A Find command main hands the window's chrome, which has both find bars. */
export interface FindCommand {
  action: FindAction
  area: FindArea
}

/** The preview's matches, as Chromium counts them. */
export interface FindResult {
  /** Which match is selected, from 1; 0 while there's none */
  active: number
  total: number
}

export interface FindContext {
  /** The page with the keyboard: Gui's chrome (toolbar, drawer), the preview, the chat, or none */
  focus: 'chrome' | 'preview' | 'chat' | 'none'
  /** In the chrome, the keyboard is in one of the drawer's terminals, or its find bar */
  inTerminal: boolean
  /** The preview shows a page to search */
  previewShown: boolean
}

/**
 * Where Find goes: the terminal that has the keyboard, otherwise the preview. The chat's
 * transcript draws only the turns in sight, so a find there would miss the rest: from the
 * chat, Find searches the preview too. Null when there's nothing to search.
 */
export function findArea({ focus, inTerminal, previewShown }: FindContext): FindArea | null {
  if (focus === 'chrome' && inTerminal) return 'terminal'
  return previewShown ? 'preview' : null
}

/** A match in a terminal's lines: its line, where it starts in it, and how long it is. */
export interface TextMatch {
  row: number
  col: number
  length: number
}

/** Every match of `query` in `lines`, ignoring case, in reading order, none overlapping. */
export function findInLines(lines: readonly string[], query: string): TextMatch[] {
  const needle = query.toLowerCase()
  if (!needle) return []
  const matches: TextMatch[] = []
  lines.forEach((line, row) => {
    const haystack = line.toLowerCase()
    for (let col = haystack.indexOf(needle); col !== -1; col = haystack.indexOf(needle, col)) {
      matches.push({ row, col, length: needle.length })
      col += needle.length
    }
  })
  return matches
}

const before = (a: TextMatch, b: TextMatch) => a.row < b.row || (a.row === b.row && a.col < b.col)

/**
 * The match to show after `from` (step 1) or before it (step -1), wrapping around; -1 when
 * there's none. With nothing shown yet, the last match: a terminal's newest output is at
 * the bottom.
 */
export function stepMatch(matches: readonly TextMatch[], from: TextMatch | null, step: 1 | -1) {
  if (matches.length === 0) return -1
  if (!from) return matches.length - 1
  if (step === 1) {
    const next = matches.findIndex((match) => before(from, match))
    return next === -1 ? 0 : next
  }
  const previous = matches.findLastIndex((match) => before(match, from))
  return previous === -1 ? matches.length - 1 : previous
}

/** What the find bar says of its matches: "3 of 12", "No matches", or nothing yet. */
export function findStatus(query: string, result: FindResult | null) {
  if (!query || !result) return ''
  if (result.total === 0) return 'No matches'
  return result.active > 0 ? `${result.active} of ${result.total}` : `${result.total} matches`
}

/** A find bar: closed, or open with what's typed in it. */
export interface FindBarState {
  open: boolean
  query: string
  /** Bumped each time the field should take the keyboard, its text selected */
  focusKey: number
}

export const CLOSED_FIND: FindBarState = { open: false, query: '', focusKey: 0 }

/**
 * A find bar after Find (⌘F), Find Next (⌘G) or Find Previous (⇧⌘G): each opens it, keeping
 * what was typed; ⌘F, or opening it, puts the keyboard in it. `step` is the match to move
 * to, if there's text to find.
 */
export function applyFindAction(state: FindBarState, action: FindAction) {
  const next: FindBarState = {
    open: true,
    query: state.query,
    focusKey: action === 'show' || !state.open ? state.focusKey + 1 : state.focusKey,
  }
  const step: 1 | -1 | null = action === 'show' || !next.query ? null : action === 'next' ? 1 : -1
  return { state: next, step }
}
