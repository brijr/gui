import { FitAddon, Ghostty, type ITheme, Terminal } from 'ghostty-web'
import wasmUrl from 'ghostty-web/ghostty-vt.wasm?url'
import type { OutputChunk, Unsubscribe } from '../../../shared/ipc'
import { gui } from '../lib/api'

/** ESC c: resets the terminal, in turn with what's being drawn. */
const RESET = '\u001bc'

// Ghostty's terminal, compiled to WebAssembly: loaded once, with the module that draws the
// drawer's terminals. It measures the mono font as it draws, so that loads first too.
const [ghostty] = await Promise.all([Ghostty.load(wasmUrl), document.fonts.ready])

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

interface TerminalOptions {
  /** A shell: takes keystrokes and shows its cursor. Otherwise read-only output. */
  interactive: boolean
  /** The element resized: the size in characters that fits it now */
  onResize: (cols: number, rows: number) => void
  /** A ⌘ key the view handles itself (true), before the app's menu would */
  onCommand?: (event: KeyboardEvent) => boolean
}

/** What a terminal's host shows: its last screen of text, for tests and tools to read. */
export interface TerminalHost extends HTMLElement {
  readonly terminalRendering?: boolean
  readonly terminalText?: string
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
  const releaseDocument = documentListeners(() => term.open(el))
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
  Object.defineProperty(el, 'terminalRendering', {
    configurable: true,
    get: () => loop.animationFrameId !== null,
  })
  // Its pixels are on a canvas; this is its text.
  Object.defineProperty(el, 'terminalText', {
    configurable: true,
    get: () => screenText(term),
  })

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
      delete (el as { terminalText?: string }).terminalText
      delete (el as { terminalRendering?: boolean }).terminalRendering
      term.dispose()
      releaseDocument()
    },
  }
}

type Listener = Parameters<Document['addEventListener']>

/**
 * Runs `open`, noting the listeners it adds to the document; the returned function takes them
 * all off. Ghostty's dispose leaves one behind (its selection's mousedown), and through it the
 * page would keep every terminal ever made, canvas and all.
 */
function documentListeners(open: () => void) {
  const added: Listener[] = []
  const add = document.addEventListener
  document.addEventListener = function (this: Document, ...args: Listener) {
    added.push(args)
    add.apply(this, args)
  } as Document['addEventListener']
  try {
    open()
  } finally {
    document.addEventListener = add
  }
  return () => {
    for (const [type, listener, options] of added.splice(0)) {
      document.removeEventListener(type, listener, options)
    }
  }
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

interface OutputSource {
  /** All main keeps of the output, to draw first */
  snapshot: () => Promise<OutputChunk>
  /** The output as main sends it, while the view is on screen */
  subscribe: (cb: (chunk: OutputChunk) => void) => Unsubscribe
}

/**
 * Draws a drawer view's output into `term`: main's snapshot, then what main sends, past what's
 * drawn already. Each chunk is acknowledged once drawn: main sends more as the terminal keeps
 * up, and holds a shell printing faster than that. `replaying` is true while old output draws
 * (the snapshot, or all main kept when the view missed more than that): Ghostty answers the
 * queries in it (cursor position, colors) as if just asked, and those answers mustn't reach
 * the shell.
 */
export function drawOutput(term: Terminal, source: OutputSource) {
  /** Drawn, or on its way to the terminal, up to here; null until the snapshot is */
  let at: number | null = null
  /** Sent before the snapshot came, which main sends after them on the same channel */
  const early: OutputChunk[] = []
  let replaying = false
  let disposed = false

  const draw = (chunk: OutputChunk, data: string, replay: boolean) => {
    at = chunk.end
    replaying = replay
    // Ghostty reads it all now, answering any queries in it as it goes; its callback waits
    // for a frame, which a hidden window never draws, and main would hold the shell meanwhile.
    term.write(data)
    replaying = false
    if (!disposed) gui.ackOutput(chunk.id, chunk.end)
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
