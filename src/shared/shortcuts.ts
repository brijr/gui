import { type Viewport, viewportKey, viewportSpec } from './types'

/**
 * Gui's keyboard shortcuts, in one place: the app menu (src/main/index.ts) takes its items'
 * labels and keys from here, the Keyboard Shortcuts sheet (⌘/) lists them, and controls name
 * theirs in their tooltip and `aria-keyshortcuts`, so the three can't drift apart. A few keys
 * belong to a page rather than the menu, such as the terminal's ⌘K; they're listed here too.
 */

/** The sheet's sections, in order. */
export const SHORTCUT_GROUPS = [
  { id: 'app', name: 'App' },
  { id: 'preview', name: 'Preview' },
  { id: 'chat', name: 'Chat & agent' },
  { id: 'terminal', name: 'Terminal' },
  { id: 'tabs', name: 'Tabs' },
] as const

export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number]['id']

/** The app menu a shortcut's item is in. */
export type ShortcutMenu = 'app' | 'file' | 'edit' | 'view' | 'agent' | 'window' | 'help'

export interface ShortcutSpec {
  /** The menu item's label, in title case like the rest of the menu bar */
  label: string
  /** Electron's accelerator for it: shown in the menu, and what the key does */
  accelerator: string
  /** Other keys for the same command, hidden from the menu (Safari's ⇧⌘] for the next tab) */
  alternates?: readonly string[]
  /** Null for a key a page handles itself, with no menu item (`matchesShortcut`) */
  menu: ShortcutMenu | null
  group: ShortcutGroup
  /** What it does, in sentence case: the sheet's line for it */
  description: string
}

/** A viewport's item: ⌘1 for the first, and so on, in VIEWPORTS order. */
function viewportShortcut(id: Viewport): ShortcutSpec {
  const { name, size } = viewportSpec(id)
  return {
    label: `${name} Viewport`,
    accelerator: `CmdOrCtrl+${viewportKey(id)}`,
    menu: 'view',
    group: 'preview',
    description: size ? `${name}: ${size.width} × ${size.height}` : `${name}: fill the window`,
  }
}

/** In the sheet's order within each group. */
export const SHORTCUTS = {
  settings: {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    menu: 'app',
    group: 'app',
    description: 'Open Settings',
  },
  newWindow: {
    label: 'New Window',
    accelerator: 'CmdOrCtrl+N',
    menu: 'file',
    group: 'app',
    description: 'Open a new window',
  },
  openProject: {
    label: 'Open Project…',
    accelerator: 'CmdOrCtrl+O',
    menu: 'file',
    group: 'app',
    description: 'Open a project folder',
  },
  newProject: {
    label: 'New Project…',
    accelerator: 'Shift+CmdOrCtrl+N',
    menu: 'file',
    group: 'app',
    description: 'Start a project in a new, empty folder',
  },
  newBoard: {
    label: 'New Canvas',
    accelerator: 'Alt+CmdOrCtrl+N',
    menu: 'file',
    group: 'app',
    description: 'Open a new canvas to design on freely',
  },
  cloneRepo: {
    label: 'Clone by URL…',
    accelerator: 'Shift+CmdOrCtrl+O',
    menu: 'file',
    group: 'app',
    description: 'Clone a GitHub repo and open it',
  },
  closeWindow: {
    label: 'Close Window',
    accelerator: 'Shift+CmdOrCtrl+W',
    menu: 'file',
    group: 'app',
    description: 'Close the window and its tabs',
  },
  undo: {
    label: 'Undo',
    accelerator: 'CmdOrCtrl+Z',
    menu: 'edit',
    group: 'app',
    description: "Undo typing, or outside a text field the agent's last change",
  },
  redo: {
    label: 'Redo',
    accelerator: 'Shift+CmdOrCtrl+Z',
    menu: 'edit',
    group: 'app',
    description: "Redo typing, or the agent's change you undid",
  },
  keyboardShortcuts: {
    label: 'Keyboard Shortcuts',
    accelerator: 'CmdOrCtrl+/',
    menu: 'help',
    group: 'app',
    description: 'Show the keyboard shortcuts',
  },
  appDevTools: {
    label: 'App Developer Tools',
    accelerator: 'Alt+CmdOrCtrl+J',
    menu: 'view',
    group: 'app',
    description: "Inspect Gui's own window",
  },

  focusAddress: {
    label: 'Focus Address Bar',
    accelerator: 'Shift+CmdOrCtrl+L',
    menu: 'view',
    group: 'preview',
    description: "Edit the preview's address",
  },
  reload: {
    label: 'Reload Preview',
    accelerator: 'CmdOrCtrl+R',
    menu: 'view',
    group: 'preview',
    description: 'Reload the preview',
  },
  hardReload: {
    label: 'Hard Reload Preview',
    accelerator: 'Shift+CmdOrCtrl+R',
    menu: 'view',
    group: 'preview',
    description: 'Reload the preview, ignoring the cache',
  },
  back: {
    label: 'Back',
    accelerator: 'CmdOrCtrl+[',
    menu: 'view',
    group: 'preview',
    description: 'Go back',
  },
  forward: {
    label: 'Forward',
    accelerator: 'CmdOrCtrl+]',
    menu: 'view',
    group: 'preview',
    description: 'Go forward',
  },
  viewportDesktop: viewportShortcut('desktop'),
  viewportLaptop: viewportShortcut('laptop'),
  viewportTablet: viewportShortcut('tablet'),
  viewportMobile: viewportShortcut('mobile'),
  zoomIn: {
    label: 'Zoom In',
    accelerator: 'CmdOrCtrl+Plus',
    // ⌘= is the same key without Shift, as in Safari and Chrome.
    alternates: ['CmdOrCtrl+='],
    menu: 'view',
    group: 'preview',
    description: 'Zoom in: the page, or a device frame up to the size that fits',
  },
  zoomOut: {
    label: 'Zoom Out',
    accelerator: 'CmdOrCtrl+-',
    menu: 'view',
    group: 'preview',
    description: 'Zoom out',
  },
  actualSize: {
    label: 'Actual Size',
    accelerator: 'CmdOrCtrl+0',
    menu: 'view',
    group: 'preview',
    description: 'Page at 100%, or a device frame back to fit',
  },
  selectElement: {
    label: 'Select Element',
    accelerator: 'CmdOrCtrl+D',
    // Chrome DevTools' key for the same, which Gui had first.
    alternates: ['Shift+CmdOrCtrl+C'],
    menu: 'view',
    group: 'preview',
    description: 'Pick an element to change (Esc cancels)',
  },
  screenshot: {
    label: 'Screenshot…',
    accelerator: 'Shift+CmdOrCtrl+S',
    menu: 'view',
    group: 'preview',
    description: 'Copy, save or attach a screenshot',
  },
  recordPreview: {
    label: 'Record Preview',
    accelerator: 'Alt+CmdOrCtrl+R',
    menu: 'view',
    group: 'preview',
    description: 'Start or stop a video of the preview, to attach to a message',
  },
  focusMode: {
    label: 'Focus Mode',
    accelerator: 'CmdOrCtrl+\\',
    menu: 'view',
    group: 'preview',
    description: 'Show only the preview (Esc exits)',
  },
  previewDevTools: {
    label: 'Preview Developer Tools',
    accelerator: 'Alt+CmdOrCtrl+I',
    menu: 'view',
    group: 'preview',
    description: "Inspect your app's page",
  },

  toggleChat: {
    label: 'Show or Hide Chat',
    accelerator: 'CmdOrCtrl+B',
    menu: 'view',
    group: 'chat',
    description: 'Show or hide the chat',
  },
  focusMessageBox: {
    label: 'Focus Message Box',
    accelerator: 'CmdOrCtrl+L',
    menu: 'view',
    group: 'chat',
    description: 'Put the cursor in the chat’s message box, showing the chat if it’s hidden',
  },
  send: {
    label: 'Send',
    accelerator: 'Enter',
    menu: null,
    group: 'chat',
    description: 'Send the message, or queue it while the agent works (in the message box)',
  },
  newLine: {
    label: 'New Line',
    accelerator: 'Shift+Enter',
    menu: null,
    group: 'chat',
    description: 'Start a new line in the message (in the message box)',
  },
  dockChat: {
    label: 'Chat as Sidebar',
    accelerator: 'Shift+CmdOrCtrl+D',
    menu: 'view',
    group: 'chat',
    description: 'Show the chat as a sidebar, or float it over the preview',
  },
  popOutChat: {
    label: 'Pop Out Chat',
    accelerator: 'Alt+CmdOrCtrl+L',
    menu: 'view',
    group: 'chat',
    description: 'Move the chat into a window of its own, or back into this one',
  },
  chooseModel: {
    label: 'Choose Model…',
    accelerator: 'Shift+CmdOrCtrl+M',
    menu: 'agent',
    group: 'chat',
    description: "Choose the agent's model and effort",
  },
  newChat: {
    label: 'New Chat',
    accelerator: 'Shift+CmdOrCtrl+K',
    menu: 'agent',
    group: 'chat',
    description: 'Start a new chat',
  },
  stop: {
    label: 'Stop',
    accelerator: 'CmdOrCtrl+.',
    menu: 'agent',
    group: 'chat',
    description: 'Stop the agent',
  },
  autoMode: {
    label: 'Auto Mode',
    accelerator: 'Shift+CmdOrCtrl+A',
    menu: 'agent',
    group: 'chat',
    description: "Auto or Ask for the agent's permission requests",
  },
  allow: {
    label: 'Allow',
    accelerator: 'CmdOrCtrl+Enter',
    menu: 'agent',
    group: 'chat',
    description: "Allow what the agent's waiting to do",
  },
  dontAllow: {
    label: "Don't Allow",
    accelerator: 'CmdOrCtrl+Backspace',
    menu: 'agent',
    group: 'chat',
    description: "Don't allow what the agent's waiting to do",
  },

  toggleTerminal: {
    label: 'Show or Hide Terminal',
    accelerator: 'CmdOrCtrl+J',
    menu: 'view',
    group: 'terminal',
    description: "Show or hide the terminal and the dev server's logs",
  },
  clearTerminal: {
    label: 'Clear Terminal',
    accelerator: 'CmdOrCtrl+K',
    menu: null,
    group: 'terminal',
    description: 'Clear the terminal (in a terminal)',
  },
  deleteLine: {
    label: 'Delete Line',
    accelerator: 'CmdOrCtrl+Backspace',
    menu: null,
    group: 'terminal',
    description: "Delete the line you're typing (in a terminal)",
  },

  newTab: {
    label: 'New Tab',
    accelerator: 'CmdOrCtrl+T',
    menu: 'file',
    group: 'tabs',
    description: 'Open a new tab',
  },
  closeTab: {
    label: 'Close Tab',
    accelerator: 'CmdOrCtrl+W',
    menu: 'file',
    group: 'tabs',
    description: 'Close the tab, stopping its agent and app',
  },
  previousTab: {
    label: 'Show Previous Tab',
    accelerator: 'Ctrl+Shift+Tab',
    alternates: ['Shift+CmdOrCtrl+['],
    menu: 'window',
    group: 'tabs',
    description: 'Show the previous tab',
  },
  nextTab: {
    label: 'Show Next Tab',
    accelerator: 'Ctrl+Tab',
    alternates: ['Shift+CmdOrCtrl+]'],
    menu: 'window',
    group: 'tabs',
    description: 'Show the next tab',
  },
} as const satisfies Record<string, ShortcutSpec>

export type ShortcutId = keyof typeof SHORTCUTS

export interface Shortcut extends ShortcutSpec {
  id: ShortcutId
}

export function shortcut(id: ShortcutId): Shortcut {
  const spec: ShortcutSpec = SHORTCUTS[id]
  return { id, ...spec }
}

/** The View menu's item for each viewport. */
export const VIEWPORT_SHORTCUTS: Record<Viewport, ShortcutId> = {
  desktop: 'viewportDesktop',
  laptop: 'viewportLaptop',
  tablet: 'viewportTablet',
  mobile: 'viewportMobile',
}

/** Every shortcut, in the sheet's order within each group. */
export function allShortcuts(): Shortcut[] {
  return (Object.keys(SHORTCUTS) as ShortcutId[]).map(shortcut)
}

/** macOS's order for modifiers, and how menus draw them. */
const MODIFIERS = [
  { names: ['Ctrl', 'Control'], symbol: '⌃', aria: 'Control' },
  { names: ['Alt', 'Option'], symbol: '⌥', aria: 'Alt' },
  { names: ['Shift'], symbol: '⇧', aria: 'Shift' },
  {
    names: ['CmdOrCtrl', 'CommandOrControl', 'Cmd', 'Command', 'Super', 'Meta'],
    symbol: '⌘',
    aria: 'Meta',
  },
] as const

/** Keys drawn as a symbol, and their name in `aria-keyshortcuts` where it isn't the key. */
const KEYS: Record<string, { symbol: string; aria: string }> = {
  Plus: { symbol: '+', aria: 'Plus' },
  '-': { symbol: '−', aria: '-' },
  Enter: { symbol: '↩', aria: 'Enter' },
  Return: { symbol: '↩', aria: 'Enter' },
  Backspace: { symbol: '⌫', aria: 'Backspace' },
  Delete: { symbol: '⌦', aria: 'Delete' },
  Tab: { symbol: '⇥', aria: 'Tab' },
  Escape: { symbol: 'Esc', aria: 'Escape' },
  Esc: { symbol: 'Esc', aria: 'Escape' },
  Space: { symbol: 'Space', aria: 'Space' },
  Up: { symbol: '↑', aria: 'ArrowUp' },
  Down: { symbol: '↓', aria: 'ArrowDown' },
  Left: { symbol: '←', aria: 'ArrowLeft' },
  Right: { symbol: '→', aria: 'ArrowRight' },
}

/** An accelerator's parts: its modifiers in macOS's order, and its key. */
function parse(accelerator: string) {
  // The key may itself be "+" ("CmdOrCtrl++" isn't used, but split keeps it intact).
  const parts = accelerator.split('+')
  const key = parts.pop() || '+'
  const modifiers = MODIFIERS.filter((modifier) =>
    parts.some((part) => (modifier.names as readonly string[]).includes(part)),
  )
  return { modifiers, key }
}

/** The keys to press, as menus draw them: `Shift+CmdOrCtrl+L` is ⇧ ⌘ L. */
export function acceleratorKeys(accelerator: string): string[] {
  const { modifiers, key } = parse(accelerator)
  const symbol = KEYS[key]?.symbol ?? key.toUpperCase()
  return [...modifiers.map((modifier) => modifier.symbol), symbol]
}

/** A shortcut's keys as one string, as the menu shows them: "⇧⌘L". */
export function shortcutText(id: ShortcutId): string {
  return acceleratorKeys(SHORTCUTS[id].accelerator).join('')
}

/** "Reload preview (⌘R)": a control's tooltip, with its shortcut. */
export function withShortcut(label: string, id: ShortcutId): string {
  return `${label} (${shortcutText(id)})`
}

/** The modifiers and key a keyboard event carries, as `matchesShortcut` reads them. */
interface KeyPress {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * The event is the shortcut's key (or one of its other keys), with exactly its modifiers: for
 * a page that handles a key itself. CmdOrCtrl is ⌘, as everywhere Gui runs.
 */
export function matchesShortcut(event: KeyPress, id: ShortcutId): boolean {
  const { accelerator, alternates = [] }: ShortcutSpec = SHORTCUTS[id]
  return [accelerator, ...alternates].some((keys) => {
    const { modifiers, key } = parse(keys)
    const has = (aria: string) => modifiers.some((modifier) => modifier.aria === aria)
    const name = KEYS[key]?.aria ?? key
    return (
      event.key.toLowerCase() === name.toLowerCase() &&
      event.metaKey === has('Meta') &&
      event.ctrlKey === has('Control') &&
      event.altKey === has('Alt') &&
      event.shiftKey === has('Shift')
    )
  })
}

/** For `aria-keyshortcuts`: "Shift+Meta+L", its other keys after a space. */
export function ariaShortcut(id: ShortcutId): string {
  const { accelerator, alternates = [] }: ShortcutSpec = SHORTCUTS[id]
  return [accelerator, ...alternates]
    .map((keys) => {
      const { modifiers, key } = parse(keys)
      const name = KEYS[key]?.aria ?? (key.length === 1 ? key.toUpperCase() : key)
      return [...modifiers.map((modifier) => modifier.aria), name].join('+')
    })
    .join(' ')
}
