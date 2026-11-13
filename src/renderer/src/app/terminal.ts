import { FitAddon, Ghostty, type ITheme, Terminal } from 'ghostty-web'
import wasmUrl from 'ghostty-web/ghostty-vt.wasm?url'
import type { TextMatch } from '../../../shared/find'

// Ghostty's terminal, compiled to WebAssembly: loaded once, with the module that draws the
// drawer's terminals. It measures the mono font as it draws, so that loads first too.
const [wasm] = await Promise.all([
  fetch(wasmUrl)
    .then((response) => response.arrayBuffer())
    .then((bytes) => WebAssembly.compile(bytes)),
  document.fonts.ready,
])

/**
 * Past this, a terminal is made again from main's output (`drawOutput`). Its WebAssembly
 * memory only grows, and Ghostty 0.4 leaks in it: a few KB a line once the lines it keeps have
 * more than about a hundred distinct colors (syntax-highlighted diffs, an agent's output). At 2 GB
 * its pointers turn negative in JavaScript, and every write throws "offset is out of bounds".
 * A terminal needs a few MB.
 */
const MAX_TERMINAL_MEMORY = 128 * 1024 * 1024

/**
 * A Ghostty of the terminal's own, so that what it leaks goes with it: one shared by every
 * terminal the window ever made would only grow.
 */
function ownGhostty() {
  const instance: WebAssembly.Instance = new WebAssembly.Instance(wasm, {
    env: {
      // As Ghostty.load has it: what Ghostty logs, to the console.
      log: (at: number, length: number) => {
        const text = new Uint8Array(memory().buffer, at, length)
        console.log('[ghostty-vt]', new TextDecoder().decode(text))
      },
    },
  })
  const memory = () => instance.exports.memory as WebAssembly.Memory
  return { ghostty: new Ghostty(instance), memory }
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/**
 * The colors, from the design tokens of the current appearance. Ghostty takes them when the
 * terminal is made, so a terminal is made again when the appearance changes
 * (`useAppearance`). Its palette is readable on --canvas as it is: Ghostty doesn't lift
 * colors to a contrast the way xterm.js did.
 */
function terminalTheme(interactive: boolean): ITheme {
  return {
    background: cssVar('--canvas'),
    foreground: cssVar('--fg'),
    // Read-only output has no cursor to show.
    cursor: cssVar(interactive ? '--fg' : '--canvas'),
    cursorAccent: cssVar('--canvas'),
    selectionBackground: cssVar('--selection'),
    black: cssVar('--terminal-black'),
    red: cssVar('--terminal-red'),
    green: cssVar('--terminal-green'),
    yellow: cssVar('--terminal-yellow'),
    blue: cssVar('--terminal-blue'),
    magenta: cssVar('--terminal-magenta'),
    cyan: cssVar('--terminal-cyan'),
    white: cssVar('--terminal-white'),
    brightBlack: cssVar('--terminal-bright-black'),
    brightRed: cssVar('--terminal-bright-red'),
    brightGreen: cssVar('--terminal-bright-green'),
    brightYellow: cssVar('--terminal-bright-yellow'),
    brightBlue: cssVar('--terminal-bright-blue'),
    brightMagenta: cssVar('--terminal-bright-magenta'),
    brightCyan: cssVar('--terminal-bright-cyan'),
    brightWhite: cssVar('--terminal-bright-white'),
  }
}

type Keys = (event: KeyboardEvent) => void

/** What a terminal's host shows, for tests and tools to read: whether it draws, and its text. */
const hosts = new WeakMap<Element, { rendering: () => boolean; text: () => string }>()
/**
 * One getter for every host, reading `hosts`: V8 keeps a property's first getter in a shape
 * other elements share, and one that closed over a terminal would keep it and its Ghostty.
 */
const HOST_PROPERTIES: PropertyDescriptorMap = {
  terminalRendering: {
    configurable: true,
    get(this: Element) {
      return hosts.get(this)?.rendering() ?? false
    },
  },
  // Its pixels are on a canvas; this is its text.
  terminalText: {
    configurable: true,
    get(this: Element) {
      return hosts.get(this)?.text() ?? ''
    },
  },
}

interface TerminalOptions {
  /** A shell: takes keystrokes and shows its cursor. Otherwise read-only output. */
  interactive: boolean
  /** The element resized: the size in characters that fits it now */
  onResize: (cols: number, rows: number) => void
  /** A ⌘ key the view handles itself (true), before the app's menu would */
  onCommand?: (event: KeyboardEvent) => boolean
}

/**
 * A Ghostty terminal in `el`, in the mono font and the token colors of the current
 * appearance, fitted to the element as it resizes. The drawer's dev server output and
 * terminals both draw with it.
 */
export function mountTerminal(
  el: HTMLElement,
  { interactive, onResize, onCommand }: TerminalOptions,
) {
  const { ghostty, memory } = ownGhostty()
  const term = new Terminal({
    ghostty,
    fontFamily: cssVar('--font-mono'),
    fontSize: Number.parseFloat(cssVar('--text-small')),
    disableStdin: !interactive,
    cursorStyle: interactive ? 'block' : 'bar',
    scrollback: 5000,
    theme: terminalTheme(interactive),
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  // Ghostty takes the keyboard as it opens. The drawer gives it to a terminal when asked
  // (`useFocus`); one made again (new colors, a new Ghostty) keeps it only if it had it.
  const focus = term.focus
  term.focus = () => {}
  const releaseListeners = listenersAdded([document, el], () => term.open(el))
  term.focus = focus
  // Ghostty exposes these only at runtime. Own the loop so hidden terminals keep
  // parsing output without scheduling canvas work (including indirect restarts).
  const loop = term as unknown as {
    animationFrameId: number | null
    startRenderLoop: () => void
  }
  const start = loop.startRenderLoop.bind(term)
  let paused = false
  let disposed = false
  loop.startRenderLoop = () => {
    if (!paused && !disposed && loop.animationFrameId === null) start()
  }
  const pause = () => {
    paused = true
    if (loop.animationFrameId !== null) cancelAnimationFrame(loop.animationFrameId)
    loop.animationFrameId = null
  }
  hosts.set(el, { rendering: () => loop.animationFrameId !== null, text: () => screenText(term) })
  Object.defineProperties(el, HOST_PROPERTIES)

  // ⌘ keys are the app's, as in Terminal. Ghostty would type them and keep them from the menu,
  // so its listener never hears them; they go on, unhandled, to the page and the menu. Not ⌘C
  // and ⌘V, which it leaves to Edit → Copy and Paste.
  const input = (term as unknown as { inputHandler?: { keydownListener: Keys | null } })
    .inputHandler
  const ghosttyKeys = input?.keydownListener
  if (!input || !ghosttyKeys) throw new Error('ghostty-web: no key listener to wrap')
  const keys: Keys = (event) => {
    if (!event.metaKey || event.code === 'KeyC' || event.code === 'KeyV') return ghosttyKeys(event)
    if (onCommand?.(event)) return event.preventDefault()
    // Edit → Select All selects the terminal's text, as it did the page's.
    if (event.code === 'KeyA') term.selectAll()
  }
  el.removeEventListener('keydown', ghosttyKeys)
  el.addEventListener('keydown', keys)
  // Ghostty's dispose takes it off.
  input.keydownListener = keys
  // Edit → Copy copies what's selected in it.
  const copy = (event: ClipboardEvent) => {
    if (!term.hasSelection()) return
    event.clipboardData?.setData('text/plain', term.getSelection())
    event.preventDefault()
  }
  el.addEventListener('copy', copy)

  let reportedCols = -1
  let reportedRows = -1
  const resize = () => {
    // Closed, or not laid out yet: it keeps the size it had.
    if (el.clientHeight < 20) return
    fit.fit()
    if (term.cols === reportedCols && term.rows === reportedRows) return
    reportedCols = term.cols
    reportedRows = term.rows
    onResize(term.cols, term.rows)
  }
  const observer = new ResizeObserver(resize)
  observer.observe(el)

  return {
    term,
    write: (data: string) => term.write(data),
    outgrown: () => memory().buffer.byteLength > MAX_TERMINAL_MEMORY,
    pause,
    resume() {
      if (disposed) return
      paused = false
      resize()
      loop.startRenderLoop()
    },
    dispose() {
      disposed = true
      pause()
      observer.disconnect()
      el.removeEventListener('copy', copy)
      hosts.delete(el)
      delete (el as { terminalText?: string }).terminalText
      delete (el as { terminalRendering?: boolean }).terminalRendering
      term.dispose()
      releaseListeners()
    },
  }
}

type Listener = Parameters<EventTarget['addEventListener']>

/**
 * Runs `open`, noting the listeners it adds to `targets`; the returned function takes them all
 * off. Ghostty's dispose leaves some behind: its selection's mousedown on the document, and a
 * beforeinput on the host, whose closure holds the terminal. Through them the page would keep
 * every terminal ever made, canvas, Ghostty, and all its memory.
 */
function listenersAdded(targets: EventTarget[], open: () => void) {
  const added: [EventTarget, Listener][] = []
  const adds = targets.map((target) => target.addEventListener)
  targets.forEach((target, i) => {
    target.addEventListener = function (this: EventTarget, ...args: Listener) {
      added.push([target, args])
      adds[i].apply(this, args)
    }
  })
  try {
    open()
  } finally {
    targets.forEach((target, i) => {
      target.addEventListener = adds[i]
    })
  }
  return () => {
    for (const [target, [type, listener, options]] of added.splice(0)) {
      target.removeEventListener(type, listener, options)
    }
  }
}

/** Every line `term` keeps, scrollback first, as text: what Find searches. */
export function terminalLines(term: Terminal) {
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let y = 0; y < buffer.length; y++) {
    lines.push(buffer.getLine(y)?.translateToString(true) ?? '')
  }
  return lines
}

/** The selection Ghostty draws, set directly: its own `select` counts rows from elsewhere. */
interface Selection {
  selectionStart: { col: number; absoluteRow: number } | null
  selectionEnd: { col: number; absoluteRow: number } | null
  markCurrentSelectionDirty(): void
}

function selectionOf(term: Terminal) {
  return (term as unknown as { selectionManager?: Selection }).selectionManager
}

/**
 * Selects a match Find found in `terminalLines` and scrolls it into view, in the middle when
 * it was out of sight. Selected, ⌘C copies it.
 */
export function showMatch(term: Terminal, { row, col, length }: TextMatch) {
  const selection = selectionOf(term)
  if (!selection) return
  const scrollback = term.getScrollbackLength()
  // A full-screen app's screen (vim, less) has no scrollback of its own: its rows follow it.
  const absolute = term.buffer.active.type === 'alternate' ? scrollback + row : row
  const top = scrollback - term.getViewportY()
  if (absolute < top || absolute >= top + term.rows) {
    const centered = scrollback - absolute + Math.floor(term.rows / 2)
    term.scrollToLine(Math.max(0, Math.min(scrollback, centered)))
  }
  // The old match's rows are drawn again without it.
  selection.markCurrentSelectionDirty()
  selection.selectionStart = { col, absoluteRow: absolute }
  selection.selectionEnd = { col: col + length - 1, absoluteRow: absolute }
}

/** The bottom screen of `term`'s lines, trimmed. */
function screenText(term: Terminal) {
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let y = Math.max(0, buffer.length - term.rows); y < buffer.length; y++) {
    lines.push(buffer.getLine(y)?.translateToString(true) ?? '')
  }
  return lines.join('\n')
}
