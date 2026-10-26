/**
 * The View menu says what ⌘B and ⌘J will do: "Show Chat" or "Hide Chat", "Show Terminal" or
 * "Hide Terminal" (docs/glossary.md). Electron can't relabel an item once the menu is built,
 * so each is two items, one of them hidden; `syncMenuItems` swaps them as the active tab
 * changes.
 */

/** What ⌘B acts on: the active tab's chat, and the window it's in. */
export interface ChatToggleState {
  chatVisible: boolean
  poppedOut: boolean
  focusMode: boolean
}

/**
 * ⌘B hides the chat only when it's showing in the window. Popped out or in focus mode, it
 * brings the chat forward instead (`ChatPanel.toggleChat`).
 */
export function chatWillHide({ chatVisible, poppedOut, focusMode }: ChatToggleState) {
  return chatVisible && !poppedOut && !focusMode
}

/** What ⌘J acts on: the active tab's drawer, and the window it's in. */
export interface TerminalToggleState {
  drawerOpen: boolean
  focusMode: boolean
}

/** ⌘J closes an open drawer; focus mode hides it whatever its setting, so ⌘J shows it. */
export function terminalWillHide({ drawerOpen, focusMode }: TerminalToggleState) {
  return drawerOpen && !focusMode
}
