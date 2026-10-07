import type { Terminal } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import { MAX_TERMINAL_INPUT } from '../../../shared/ipc'
import { matchesShortcut } from '../../../shared/shortcuts'
import type { TerminalId } from '../../../shared/types'
import { gui } from '../lib/api'
import { drawOutput, mountXterm } from './xterm'

// The drawer's terminals, apart from it so xterm.js loads only once one is first drawn.

interface ViewProps {
  /** Take the keyboard now that it shows; `onFocused` says it has */
  focus: boolean
  onFocused: () => void
}

/** Puts the keyboard in `term` when asked, once its tab shows. */
function useFocus(term: { current: Terminal | null }, { focus, onFocused }: ViewProps) {
  useEffect(() => {
    if (!focus || !term.current) return
    term.current.focus()
    onFocused()
  }, [focus, term, onFocused])
}

/** The dev server's output, read-only. Mounted only once a project exists. */
export function LogsView(props: ViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const xterm = mountXterm(el, {
      interactive: false,
      onResize: (cols, rows) => gui.resizeLogs(cols, rows),
    })
    term.current = xterm.term
    const output = drawOutput(xterm.term, { snapshot: gui.getLogs, subscribe: gui.onLogs })

    return () => {
      output.dispose()
      term.current = null
      xterm.dispose()
    }
  }, [])
  // After the terminal is made, which a tab that's new asks for in the same render.
  useFocus(term, props)

  return <div ref={host} className="size-full" />
}

/** One of the project's terminals: what its shell prints, and the keys typed into it. */
export function ShellView({ id, ...props }: ViewProps & { id: TerminalId }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const xterm = mountXterm(el, {
      interactive: true,
      onResize: (cols, rows) => gui.resizeTerminal(id, cols, rows),
    })
    term.current = xterm.term
    const output = drawOutput(xterm.term, {
      snapshot: () => gui.getTerminal(id),
      subscribe: (cb) =>
        gui.onTerminalData((chunk) => {
          if (chunk.id === id) cb(chunk)
        }),
    })
    const input = xterm.term.onData((data) => {
      // An answer to a query in old output, which starts with ESC as answers do, stays here.
      // Keys typed meanwhile still go: ⌃C, just after switching to a terminal that floods.
      if (!(output.replaying() && data.startsWith(ESC))) sendInput(id, data)
    })
    // xterm would type ⌘↩ and ⌘⌫ as Return and Delete: the app's keys, and a text field's,
    // come first. Returning false leaves a key to the page, and unhandled, to the app menu.
    xterm.term.attachCustomKeyEventHandler((event) => {
      // ⌘K clears it, as in Terminal; the shell isn't told. Handled, so nothing beeps.
      if (matchesShortcut(event, 'clearTerminal')) {
        if (event.type === 'keydown') {
          event.preventDefault()
          xterm.term.clear()
          gui.clearTerminal(id)
        }
        return false
      }
      // ⌘⌫ deletes the line being typed, as in a text field (the shell's ⌃U, as in iTerm).
      // Handled here, it never answers a waiting permission card from the terminal.
      if (matchesShortcut(event, 'deleteLine')) {
        if (event.type === 'keydown') {
          event.preventDefault()
          sendInput(id, KILL_LINE)
        }
        return false
      }
      // ⌘↩ is the app's: Agent → Allow, for a waiting card. Never a second Return here.
      return !matchesShortcut(event, 'allow')
    })

    return () => {
      output.dispose()
      input.dispose()
      term.current = null
      xterm.dispose()
    }
  }, [id])
  useFocus(term, props)

  return <div ref={host} className="size-full" />
}

/** ⌃U: deletes the line being typed, in zsh and bash. */
const KILL_LINE = '\x15'
const ESC = '\x1b'

/** Keystrokes, and pastes in pieces main accepts; a piece never splits a character. */
function sendInput(id: TerminalId, data: string) {
  for (let start = 0; start < data.length; ) {
    let end = Math.min(start + MAX_TERMINAL_INPUT, data.length)
    const last = data.charCodeAt(end - 1)
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--
    gui.writeTerminal(id, data.slice(start, end))
    start = end
  }
}
