import type { Terminal } from '@xterm/xterm'
import { ChevronDown, Plus, SquareTerminal, TriangleAlert, X } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { MAX_TERMINAL_INPUT } from '../../../shared/ipc'
import { matchesShortcut } from '../../../shared/shortcuts'
import {
  type DrawerTab,
  drawerNeighbor,
  type TerminalId,
  type WindowState,
} from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { StatusDot } from '../lib/status'
import { Button, IconButton } from '../lib/ui'
import { crashed, serverStatus } from './server-status'
import { mountXterm } from './xterm'

const tabId = (tab: DrawerTab) => `drawer-tab-${tab}`
const panelId = (tab: DrawerTab) => `drawer-panel-${tab}`

interface TabEntry {
  tab: DrawerTab
  label: string
  icon: ReactNode
  /** Read after the label, for assistive tech */
  note?: string
}

/**
 * The drawer under the canvas (⌘J): the dev server's output, read-only, and the project's
 * terminals, each the user's own login shell at the project root, started when they open it.
 * "Show logs" wherever something went wrong opens it on the dev server's output. Closed,
 * nothing shows here unless the dev server crashed under a live preview, which gets a slim
 * bar instead of raw output. (With no preview to show, the canvas says so itself.)
 */
export function Drawer({ state }: { state: WindowState }) {
  // A tab that should take the keyboard once it shows: asked by main (⌘J, a new terminal) or
  // by a click on its tab here.
  const [focusRequest, setFocusRequest] = useState<DrawerTab | null>(null)
  useEffect(() => gui.onDrawerFocus(setFocusRequest), [])

  const { project, drawer } = state
  if (!project) return null
  const { open, terminals } = drawer
  const shown = drawer.tab ?? 'server'
  const failed = crashed(state)
  const exited = terminals.find((terminal) => terminal.id === shown)?.exited ?? false

  const tabs: TabEntry[] = [
    {
      tab: 'server',
      label: 'Dev server',
      icon: (
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          <StatusDot status={serverStatus(state).status} />
        </span>
      ),
    },
    ...terminals.map(
      (terminal): TabEntry => ({
        tab: terminal.id,
        label: terminal.title,
        icon: <SquareTerminal className="size-3.5 shrink-0" aria-hidden="true" />,
        note: terminal.exited ? 'exited' : undefined,
      }),
    ),
  ]

  const select = (tab: DrawerTab, focus: boolean) => {
    if (tab !== shown) gui.selectDrawerTab(tab)
    if (focus) setFocusRequest(tab)
  }

  /** The pointer's ×: the drawer shows the neighbor, which takes the keyboard. */
  const close = (id: TerminalId) => {
    if (id === shown) setFocusRequest(drawerNeighbor(terminals, id))
    gui.closeTerminal(id)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const entry = tabs[index]
    if (!entry) return
    if ((event.key === 'Delete' || event.key === 'Backspace') && entry.tab !== 'server') {
      event.preventDefault()
      // Main shows the neighbor; the keyboard stays in the tabs, on it.
      const neighbor = tabs[index + 1] ?? tabs[index - 1]
      if (neighbor) document.getElementById(tabId(neighbor.tab))?.focus()
      gui.closeTerminal(entry.tab)
      return
    }
    const count = tabs.length
    const targets: Record<string, number> = {
      ArrowRight: (index + 1) % count,
      ArrowLeft: (index - 1 + count) % count,
      Home: 0,
      End: count - 1,
    }
    const target = targets[event.key]
    const next = target === undefined ? undefined : tabs[target]
    if (!next) return
    event.preventDefault()
    select(next.tab, false)
    document.getElementById(tabId(next.tab))?.focus()
  }

  return (
    <>
      {!open && failed && state.preview.visible && <CrashBar />}
      {/* Kept mounted while closed, so the terminals keep their scrollback and place. */}
      <section
        aria-label="Terminal"
        inert={!open}
        className={cn('shrink-0 bg-surface', open && 'border-t border-line')}
      >
        {open && (
          <div className="flex h-9 items-center gap-1 pr-1.5 pl-1.5">
            {/*
             * Tabs only, as in the tab strip. A terminal's × is for the pointer and hidden from
             * assistive tech; from the keyboard, Delete on its tab ends it.
             */}
            <div
              role="tablist"
              aria-label="Terminal tabs"
              className="flex min-w-0 shrink items-center gap-1 overflow-hidden"
            >
              {tabs.map((entry, index) => {
                const selected = entry.tab === shown
                const terminal = entry.tab === 'server' ? null : entry.tab
                return (
                  <div
                    key={entry.tab}
                    role="presentation"
                    className={cn(
                      'relative flex h-7 min-w-0 shrink items-center rounded-md',
                      selected
                        ? 'bg-accent-soft text-accent-text'
                        : 'text-muted hover:bg-hover hover:text-fg',
                    )}
                  >
                    <button
                      type="button"
                      role="tab"
                      id={tabId(entry.tab)}
                      aria-controls={panelId(entry.tab)}
                      aria-selected={selected}
                      tabIndex={selected ? 0 : -1}
                      aria-label={entry.note ? `${entry.label}, ${entry.note}` : undefined}
                      title={entry.label}
                      // A click shows it and puts the keyboard in it; Enter or Space only shows it.
                      onClick={(event) => select(entry.tab, event.detail > 0)}
                      // The middle button ends a terminal, rather than starting to scroll.
                      onMouseDown={(event) => {
                        if (event.button === 1) event.preventDefault()
                      }}
                      onAuxClick={(event) => {
                        if (event.button === 1 && terminal) close(terminal)
                      }}
                      onKeyDown={(event) => onKeyDown(event, index)}
                      className={cn(
                        'flex h-full min-w-0 items-center gap-1.5 rounded-md pl-2 text-small font-medium',
                        terminal ? 'pr-7' : 'pr-2.5',
                      )}
                    >
                      {entry.icon}
                      <span className={cn('truncate', entry.note && 'text-subtle')}>
                        {entry.label}
                      </span>
                    </button>
                    {terminal && (
                      <IconButton
                        label={`Close ${entry.label}`}
                        icon={X}
                        size="sm"
                        aria-hidden="true"
                        tabIndex={-1}
                        // Keeps focus where it was rather than on a button hidden from assistive tech.
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => close(terminal)}
                        // Always there: tabs here are as wide as their names, so a hidden one
                        // would leave a gap.
                        className="absolute right-0.5"
                      />
                    )}
                  </div>
                )
              })}
            </div>
            <IconButton
              label="New terminal"
              icon={Plus}
              size="sm"
              onClick={() => gui.newTerminal()}
            />
            <div className="flex min-w-0 flex-1 items-center justify-end gap-2 pl-2">
              {shown === 'server' ? (
                <>
                  <span className="min-w-0 truncate font-mono text-caption text-subtle">
                    {state.devServer.command}
                  </span>
                  {failed && (
                    <>
                      <span className="shrink-0 text-small text-danger">Stopped with an error</span>
                      <Button size="sm" onClick={() => gui.restartDevServer()}>
                        Restart
                      </Button>
                    </>
                  )}
                </>
              ) : (
                exited && (
                  <Button
                    size="sm"
                    onClick={() => {
                      gui.restartTerminal(shown)
                      setFocusRequest(shown)
                    }}
                  >
                    Restart
                  </Button>
                )
              )}
            </div>
            <IconButton
              label="Hide terminal"
              shortcut="toggleTerminal"
              icon={ChevronDown}
              size="sm"
              onClick={() => gui.setDrawerOpen(false)}
            />
          </div>
        )}
        <div className={cn('relative overflow-hidden bg-canvas', open ? 'h-56' : 'h-0')}>
          {/* First, so it's the drawer's first terminal on the page. Keyed by project, so each
              project gets a fresh one with its own log history. */}
          <Panel tab="server" shown={shown === 'server'}>
            <LogsView
              key={project.root}
              focus={open && shown === 'server' && focusRequest === 'server'}
              onFocused={() => setFocusRequest(null)}
            />
          </Panel>
          {terminals.map((terminal) => (
            <Panel key={terminal.id} tab={terminal.id} shown={shown === terminal.id}>
              <ShellView
                id={terminal.id}
                focus={open && shown === terminal.id && focusRequest === terminal.id}
                onFocused={() => setFocusRequest(null)}
              />
            </Panel>
          ))}
        </div>
      </section>
    </>
  )
}

/** A tab's terminal: all stay laid out at the drawer's size, the ones not shown invisible. */
function Panel({ tab, shown, children }: { tab: DrawerTab; shown: boolean; children: ReactNode }) {
  return (
    <div
      role="tabpanel"
      id={panelId(tab)}
      aria-labelledby={tabId(tab)}
      className={cn('absolute inset-0 px-3 py-2', !shown && 'invisible')}
    >
      {children}
    </div>
  )
}

/** The dev server crashed while its last page is still on screen. */
function CrashBar() {
  return (
    <div
      role="alert"
      className="flex h-9 shrink-0 items-center gap-2 border-t border-line bg-danger-soft pr-1.5 pl-3"
    >
      <TriangleAlert className="size-3.5 shrink-0 text-danger" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate text-small">
        Your app stopped with an error, so the preview won't update.
      </p>
      <Button variant="ghost" size="sm" onClick={() => gui.showLogs()}>
        Show logs
      </Button>
      <Button size="sm" onClick={() => gui.restartDevServer()}>
        Restart
      </Button>
    </div>
  )
}

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
function LogsView(props: ViewProps) {
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

    // Main sends live chunks and the snapshot reply on one ordered channel, so anything
    // that arrives before the snapshot is already in it.
    let ready = false
    const off = gui.onLogs((chunk) => {
      if (ready) xterm.term.write(chunk)
    })
    void gui.getLogs().then((logs) => {
      if (logs) xterm.term.write(logs)
      ready = true
    })

    return () => {
      ready = false
      off()
      term.current = null
      xterm.dispose()
    }
  }, [])
  // After the terminal is made, which a tab that's new asks for in the same render.
  useFocus(term, props)

  return <div ref={host} className="size-full" />
}

/** One of the project's terminals: what its shell prints, and the keys typed into it. */
function ShellView({ id, ...props }: ViewProps & { id: TerminalId }) {
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

    // As with the logs: output that arrives before the snapshot is already in it. Drawing
    // the snapshot makes xterm answer the queries in it (cursor position, colors) as if the
    // shell had just asked; those answers mustn't reach the shell.
    let ready = false
    let replaying = true
    const off = gui.onTerminalData((output) => {
      if (ready && output.id === id) xterm.term.write(output.data)
    })
    void gui.getTerminal(id).then((output) => {
      ready = true
      if (!output) {
        replaying = false
        return
      }
      xterm.term.write(output, () => {
        replaying = false
      })
    })
    const input = xterm.term.onData((data) => {
      if (!replaying) sendInput(id, data)
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
      ready = false
      off()
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
