import { type DeviceViewport, viewportKey, viewportSpec } from './types'

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
  { id: 'canvas', name: 'Canvas' },
  { id: 'terminal', name: 'Terminal' },
  { id: 'tabs', name: 'Tabs' },
] as const

export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number]['id']

/** The app menu a shortcut's item is in. */
export type ShortcutMenu = 'app' | 'file' | 'edit' | 'view' | 'agent' | 'window' | 'help'

export interface ShortcutSpec {
  /** The menu item's label, in title case like the rest of the menu bar */
  label: string
  /**
   * For a key that shows or hides something: the menu says which it will do, with one of
   * these in place of `label` ("Show Chat", "Hide Chat"). The sheet still shows `label`.
   */
  menuLabels?: { show: string; hide: string }
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
function viewportShortcut(id: DeviceViewport): ShortcutSpec {
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
    label: 'Clone…',
    accelerator: 'Shift+CmdOrCtrl+O',
    menu: 'file',
    group: 'app',
    description: 'Copy a GitHub repository to your Mac and open it',
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
    description: "Undo typing, or with the chat showing, the agent's last change",
  },
  redo: {
    label: 'Redo',
    accelerator: 'Shift+CmdOrCtrl+Z',
    menu: 'edit',
    group: 'app',
    description: "Redo typing, or with the chat showing, the agent's change you undid",
  },
  find: {
    label: 'Find…',
    accelerator: 'CmdOrCtrl+F',
    menu: 'edit',
    group: 'app',
    description: 'Find text in the preview, or in the terminal you’re typing in',
  },
  findNext: {
    label: 'Find Next',
    accelerator: 'CmdOrCtrl+G',
    menu: 'edit',
    group: 'app',
    description: 'Show the next match',
  },
  findPrevious: {
    label: 'Find Previous',
    accelerator: 'Shift+CmdOrCtrl+G',
    menu: 'edit',
    group: 'app',
    description: 'Show the previous match',
  },
  closeFind: {
    label: 'Close Find',
    accelerator: 'Escape',
    menu: null,
    group: 'app',
    description: 'Close the find bar (in it)',
  },
  keyboardShortcuts: {
    label: 'Keyboard Shortcuts',
    accelerator: 'CmdOrCtrl+/',
    menu: 'help',
    group: 'app',
    description: 'Show the keyboard shortcuts',
  },
  nextPane: {
    label: 'Focus Next Pane',
    accelerator: 'F6',
    menu: 'view',
    group: 'app',
    description: 'Move the keyboard to the next pane: toolbar, preview, chat',
  },
  previousPane: {
    label: 'Focus Previous Pane',
    accelerator: 'Shift+F6',
    menu: 'view',
    group: 'app',
    description: 'Move the keyboard to the previous pane',
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
    label: 'Design Mode',
    accelerator: 'CmdOrCtrl+D',
    // Chrome DevTools' key for the same, which Gui had first.
    alternates: ['Shift+CmdOrCtrl+C'],
    menu: 'view',
    group: 'preview',
    description: 'Design mode: click an element or drag out an area to change (Esc when done)',
  },
  rulers: {
    label: 'Show or Hide Rulers',
    // Outside text fields only, so it's the pages' own (main/index.ts toggleRulers), not the menu's.
    accelerator: 'Shift+R',
    menu: null,
    group: 'preview',
    description: 'Show or hide rulers; drag a guide out of one, back onto it to remove',
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
    menuLabels: { show: 'Show Chat', hide: 'Hide Chat' },
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

  // The canvas's own keys, while it has the keyboard (board.tsx).
  canvasHand: {
    label: 'Hand Tool',
    accelerator: 'H',
    menu: null,
    group: 'canvas',
    description: 'Hand tool: drag to pan',
  },
  canvasMove: {
    label: 'Move Tool',
    accelerator: 'V',
    menu: null,
    group: 'canvas',
    description: 'Move tool: select and drag frames',
  },
  canvasZoomTool: {
    label: 'Zoom Tool',
    accelerator: 'Z',
    menu: null,
    group: 'canvas',
    description:
      'Zoom tool while held: click to zoom in, ⌥-click to zoom out, drag to zoom to an area',
  },
  canvasZoomIn: {
    label: 'Zoom In on Canvas',
    accelerator: 'Plus',
    alternates: ['=', 'CmdOrCtrl+Plus'],
    menu: null,
    group: 'canvas',
    description: 'Zoom the canvas in',
  },
  canvasZoomOut: {
    label: 'Zoom Out on Canvas',
    accelerator: '-',
    alternates: ['CmdOrCtrl+-'],
    menu: null,
    group: 'canvas',
    description: 'Zoom the canvas out',
  },
  canvasZoomActual: {
    label: 'Zoom to 100%',
    accelerator: 'Shift+0',
    menu: null,
    group: 'canvas',
    description: 'Zoom to 100%',
  },
  canvasZoomFit: {
    label: 'Zoom to Fit',
    accelerator: 'Shift+1',
    alternates: ['CmdOrCtrl+0'],
    menu: null,
    group: 'canvas',
    description: 'Zoom to fit every frame',
  },
  canvasZoomSelection: {
    label: 'Zoom to Selection',
    accelerator: 'Shift+2',
    menu: null,
    group: 'canvas',
    description: 'Zoom to the selected frames, or the section picked by its name',
  },
  canvasStep: {
    label: 'Next Frame',
    accelerator: 'Tab',
    alternates: ['Shift+Tab'],
    menu: null,
    group: 'canvas',
    description: 'Select the next section or frame, or the previous one',
  },
  canvasOpen: {
    label: 'Open Frame',
    accelerator: 'Enter',
    menu: null,
    group: 'canvas',
    description: 'Open the selected frame',
  },
  canvasRename: {
    label: 'Rename Frame',
    accelerator: 'F2',
    menu: null,
    group: 'canvas',
    description: 'Rename the selected frame or section',
  },
  canvasMenu: {
    label: 'Frame Menu',
    accelerator: 'Shift+F10',
    menu: null,
    group: 'canvas',
    description: "Show the selected frame's or section's menu",
  },
  canvasNudge: {
    label: 'Nudge Frames',
    accelerator: 'Left',
    alternates: ['Right', 'Up', 'Down'],
    menu: null,
    group: 'canvas',
    description: 'Move the selected frames a pixel',
  },
  canvasShove: {
    label: 'Shove Frames',
    accelerator: 'Shift+Left',
    alternates: ['Shift+Right', 'Shift+Up', 'Shift+Down'],
    menu: null,
    group: 'canvas',
    description: 'Move the selected frames 10 pixels',
  },
  canvasSelectAll: {
    label: 'Select All Frames',
    accelerator: 'CmdOrCtrl+A',
    menu: null,
    group: 'canvas',
    description: 'Select every frame',
  },
  canvasSection: {
    label: 'Make Section',
    accelerator: 'Alt+CmdOrCtrl+G',
    menu: null,
    group: 'canvas',
    description: 'Group the selected frames in a section',
  },
  canvasDuplicate: {
    label: 'Duplicate Frames',
    accelerator: 'Alt+CmdOrCtrl+D',
    menu: null,
    group: 'canvas',
    description: 'Duplicate the selected frames',
  },
  canvasCopy: {
    label: 'Copy Frames',
    accelerator: 'CmdOrCtrl+C',
    menu: null,
    group: 'canvas',
    description: 'Copy the selected frames, to paste on any canvas',
  },
  canvasCut: {
    label: 'Cut Frames',
    accelerator: 'CmdOrCtrl+X',
    menu: null,
    group: 'canvas',
    description: 'Cut the selected frames',
  },
  canvasPaste: {
    label: 'Paste Frames',
    accelerator: 'CmdOrCtrl+V',
    menu: null,
    group: 'canvas',
    description: 'Paste copied frames onto this canvas',
  },
  canvasExport: {
    label: 'Export Frames',
    accelerator: 'Shift+CmdOrCtrl+E',
    menu: null,
    group: 'canvas',
    description: 'Export the selected frames as PNG',
  },
  canvasDelete: {
    label: 'Delete Frames',
    accelerator: 'Backspace',
    alternates: ['Delete'],
    menu: null,
    group: 'canvas',
    description: 'Delete the selected frames, or the section picked by its name',
  },

  toggleTerminal: {
    label: 'Show or Hide Terminal',
    menuLabels: { show: 'Show Terminal', hide: 'Hide Terminal' },
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
  reopenClosedTab: {
    label: 'Reopen Closed Tab',
    accelerator: 'Shift+CmdOrCtrl+T',
    menu: 'file',
    group: 'tabs',
    description: 'Open the tab you closed last again, with its chat',
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
export const VIEWPORT_SHORTCUTS: Record<DeviceViewport, ShortcutId> = {
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
export interface KeyPress {
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
