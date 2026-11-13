import type { Terminal } from 'ghostty-web'
import {
  type RefObject,
  useEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  applyFindAction,
  CLOSED_FIND,
  type FindAction,
  type FindResult,
  findInLines,
  findStatus,
  stepMatch,
  type TextMatch,
} from '../../../shared/find'
import { MAX_TERMINAL_INPUT } from '../../../shared/ipc'
import { matchesShortcut } from '../../../shared/shortcuts'
import type { TerminalId } from '../../../shared/types'
import { gui } from '../lib/api'
import { FIND_EVENT, FloatingFindBar } from './find-bar'
import { mountTerminal, showMatch, terminalLines } from './terminal'
import { drawOutput } from './terminal-output'

// The drawer's terminals, apart from it so Ghostty loads only once one is first drawn.

const DARK = window.matchMedia('(prefers-color-scheme: dark)')

/** Whether the app is dark now. A terminal takes its colors when made, so it's made again. */
function useDark() {
  return useSyncExternalStore(
    (changed) => {
      DARK.addEventListener('change', changed)
      return () => DARK.removeEventListener('change', changed)
    },
    () => DARK.matches,
  )
}

interface ViewProps {
  active: boolean
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

/**
 * Edit → Find in a terminal (⌘F while it has the keyboard): its find bar, floating over the
 * top of the drawer. The drawer hands it the menu's commands as `FIND_EVENT` on its scope.
 */
function useTerminalFind(
  // Named as refs, so the React Compiler doesn't memoize on what's in them: a past terminal,
  // with its Ghostty and all its memory, would be kept.
  termRef: RefObject<Terminal | null>,
  scopeRef: RefObject<HTMLElement | null>,
) {
  const [find, setFind] = useState(CLOSED_FIND)
  const [result, setResult] = useState<FindResult | null>(null)
  // As they are now, for a command that comes before the next render.
  const current = useRef(find)
  const shown = useRef<TextMatch | null>(null)
  const update = (next: typeof find) => {
    current.current = next
    setFind(next)
  }
  /** Searches all its lines again (output keeps coming), and shows the match `step` away. */
  const search = (query: string, step: 1 | -1 | null) => {
    const terminal = termRef.current
    if (!terminal) return
    const matches = findInLines(terminalLines(terminal), query)
    const index = stepMatch(matches, step ? shown.current : null, step ?? 1)
    const match = matches[index] ?? null
    shown.current = match
    if (match) showMatch(terminal, match)
    else terminal.clearSelection()
    setResult({ active: index + 1, total: matches.length })
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: `update` and `search` read refs.
  useEffect(() => {
    const el = scopeRef.current
    if (!el) return
    const onFind = (event: Event) => {
      const was = current.current
      const { state, step } = applyFindAction(was, (event as CustomEvent<FindAction>).detail)
      update(state)
      if (step) search(state.query, step)
      else if (!was.open && state.query) search(state.query, null)
    }
    el.addEventListener(FIND_EVENT, onFind)
    return () => el.removeEventListener(FIND_EVENT, onFind)
  }, [scopeRef])

  if (!find.open) return null
  return (
    <FloatingFindBar
      className="absolute top-0 right-0 z-10"
      label="Find in terminal"
      query={find.query}
      status={findStatus(find.query, result)}
      found={(result?.total ?? 0) > 0 && find.query !== ''}
      focusKey={find.focusKey}
      onQuery={(text) => {
        update({ ...current.current, query: text })
        shown.current = null
        if (text) search(text, null)
        else {
          termRef.current?.clearSelection()
          setResult(null)
        }
      }}
      onStep={(step) => {
        const { query } = current.current
        if (query) search(query, step)
      }}
      onClose={() => {
        update({ ...current.current, open: false })
        setResult(null)
        termRef.current?.focus()
      }}
    />
  )
}

/** The dev server's output, read-only. Mounted only once a project exists. */
export function LogsView(props: ViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const scope = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const dark = useDark()
  const mounted = useRef<ReturnType<typeof mountTerminal> | null>(null)
  const [generation, remount] = useReducer(nextGeneration, 0)
  const hadFocus = useRef(false)

  useEffect(() => {
    const el = host.current
    if (!el) return
    // Made again, in the new colors, when the appearance changes; or when it asks to be.
    void dark
    void generation
    const terminal = mountTerminal(el, {
      interactive: false,
      onResize: (cols, rows) => gui.resizeLogs(cols, rows),
    })
    mounted.current = terminal
    term.current = terminal.term
    // Made again with the keyboard in it, it keeps it.
    if (hadFocus.current) terminal.term.focus()
    const output = drawOutput(
      terminal,
      { snapshot: gui.getLogs, subscribe: gui.onLogs, ack: gui.ackOutput },
      remount,
    )

    return () => {
      hadFocus.current = el.contains(document.activeElement)
      output.dispose()
      mounted.current = null
      term.current = null
      terminal.dispose()
    }
  }, [dark, generation])
  // After the terminal is made, which a tab that's new asks for in the same render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new terminal starts drawing.
  useEffect(() => {
    if (props.active) mounted.current?.resume()
    else mounted.current?.pause()
  }, [props.active, dark, generation])
  useFocus(term, props)
  const find = useTerminalFind(term, scope)

  return (
    <div ref={scope} data-find-scope="terminal" className={SCOPE}>
      <div ref={host} data-terminal="" className={HOST} />
      {find}
    </div>
  )
}

/** One of the project's terminals: what its shell prints, and the keys typed into it. */
export function ShellView({ id, ...props }: ViewProps & { id: TerminalId }) {
  const host = useRef<HTMLDivElement>(null)
  const scope = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const dark = useDark()
  const mounted = useRef<ReturnType<typeof mountTerminal> | null>(null)
  const [generation, remount] = useReducer(nextGeneration, 0)
  const hadFocus = useRef(false)

  useEffect(() => {
    const el = host.current
    if (!el) return
    // Made again, in the new colors, when the appearance changes; or when it asks to be.
    void dark
    void generation
    // ⌘K clears it, as in Terminal; the shell isn't told. ⌘⌫ deletes the line being typed, as
    // in a text field (the shell's ⌃U, as in iTerm); handled here, it never answers a waiting
    // permission card from the terminal. ⌘↩ and the rest go on to the app.
    const onCommand = (event: KeyboardEvent) => {
      if (matchesShortcut(event, 'clearTerminal')) {
        term.current?.clear()
        gui.clearTerminal(id)
        return true
      }
      if (matchesShortcut(event, 'deleteLine')) {
        sendInput(id, KILL_LINE)
        return true
      }
      return false
    }
    const terminal = mountTerminal(el, {
      interactive: true,
      onResize: (cols, rows) => gui.resizeTerminal(id, cols, rows),
      onCommand,
    })
    mounted.current = terminal
    term.current = terminal.term
    // Made again with the keyboard in it, it keeps it.
    if (hadFocus.current) terminal.term.focus()
    const output = drawOutput(
      terminal,
      {
        snapshot: () => gui.getTerminal(id),
        subscribe: (cb) =>
          gui.onTerminalData((chunk) => {
            if (chunk.id === id) cb(chunk)
          }),
        ack: gui.ackOutput,
      },
      remount,
    )
    const input = terminal.term.onData((data) => {
      // An answer to a query in old output, which starts with ESC as answers do, stays here.
      // Keys typed meanwhile still go: ⌃C, just after switching to a terminal that floods.
      if (!(output.replaying() && data.startsWith(ESC))) sendInput(id, data)
    })

    return () => {
      hadFocus.current = el.contains(document.activeElement)
      output.dispose()
      input.dispose()
      mounted.current = null
      term.current = null
      terminal.dispose()
    }
  }, [id, dark, generation])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new terminal starts drawing.
  useEffect(() => {
    if (props.active) mounted.current?.resume()
    else mounted.current?.pause()
  }, [props.active, dark, id, generation])
  useFocus(term, props)
  const find = useTerminalFind(term, scope)

  return (
    <div ref={scope} data-find-scope="terminal" className={SCOPE}>
      <div ref={host} data-terminal="" className={HOST} />
      {find}
    </div>
  )
}

const nextGeneration = (generation: number) => generation + 1

/** Ghostty makes the host editable for its keys; the page's caret mustn't show in it. */
const HOST = 'size-full caret-transparent'
/** The terminal and its find bar: the keyboard in either is "in the terminal" for Find. */
const SCOPE = 'relative size-full'

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
