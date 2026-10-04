import { FitAddon } from '@xterm/addon-fit'
import { type ITheme, Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** The colors, from the design tokens of the current appearance. */
function terminalTheme(interactive: boolean): ITheme {
  return {
    background: cssVar('--canvas'),
    foreground: cssVar('--fg'),
    // Read-only output has no cursor to show.
    cursor: cssVar(interactive ? '--fg' : '--canvas'),
    cursorAccent: cssVar('--canvas'),
    selectionBackground: cssVar('--terminal-selection'),
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

interface XtermOptions {
  /** A shell: takes keystrokes and shows its cursor. Otherwise read-only output. */
  interactive: boolean
  /** The element resized: the size in characters that fits it now */
  onResize: (cols: number, rows: number) => void
}

/**
 * An xterm.js terminal in `el`, in the mono font, fitted to the element as it resizes, and in
 * the token colors of the current appearance as it changes. The drawer's dev server output
 * and terminals both draw with it.
 */
export function mountXterm(el: HTMLElement, { interactive, onResize }: XtermOptions) {
  const term = new Terminal({
    fontFamily: cssVar('--font-mono'),
    fontSize: Number.parseFloat(cssVar('--text-small')),
    lineHeight: 1.25,
    disableStdin: !interactive,
    cursorStyle: interactive ? 'block' : 'bar',
    cursorInactiveStyle: interactive ? 'outline' : 'none',
    scrollback: 5000,
    theme: terminalTheme(interactive),
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el)

  const resize = () => {
    // Closed, or not laid out yet: it keeps the size it had.
    if (el.clientHeight < 20) return
    fit.fit()
    onResize(term.cols, term.rows)
  }
  const observer = new ResizeObserver(resize)
  observer.observe(el)

  const scheme = window.matchMedia('(prefers-color-scheme: dark)')
  const retheme = () => {
    term.options.theme = terminalTheme(interactive)
  }
  scheme.addEventListener('change', retheme)

  return {
    term,
    dispose() {
      observer.disconnect()
      scheme.removeEventListener('change', retheme)
      term.dispose()
    },
  }
}
