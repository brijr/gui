import type { Terminal } from '@xterm/xterm'
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
import { ChevronDown, Info, Plus, SquareTerminal, TriangleAlert, X } from '../lib/icons'
import { StatusDot } from '../lib/status'
import { Button, IconButton } from '../lib/ui'
import { useLayoutSlide } from './layout-morph'
import { crashed, serverStatus, stoppedOutside } from './server-status'
import { drawOutput, mountXterm } from './xterm'

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
  // Focus mode hides it, with the rest of the chrome.
  const open = state.drawer.open && !state.focusMode && state.project !== null
  const section = useRef<HTMLElement>(null)
  // It slides up from the window's bottom edge as the preview's edge rises over it, and back
  // down; while it goes it's still drawn open, over the canvas that already has its room.
  const leaving = useLayoutSlide(open, section, { edge: 'bottom' })
  const drawn = open || leaving

  const { project, drawer } = state
  if (!project) return null
  const { terminals } = drawer
  const shown = drawer.tab ?? 'server'
  const failed = crashed(state)
  const stopped = stoppedOutside(state)
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
      {!drawn && !state.focusMode && (failed || stopped) && state.preview.visible && (
        <StoppedBar crashed={failed} />
      )}
      {/* Kept mounted while closed, so the terminals keep their scrollback and place. */}
      <section
        ref={section}
        aria-label="Terminal"
        inert={!open}
        className={cn(
          'z-20 shrink-0 bg-surface',
          leaving ? 'absolute inset-x-0 bottom-0' : 'relative',
          drawn && 'border-t border-line',
        )}
      >
        {drawn && (
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
        <div className={cn('relative overflow-hidden bg-canvas', drawn ? 'h-56' : 'h-0')}>
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
/**
 * Under a preview whose app is gone: it crashed (an alert, with the logs to see why), or
 * something outside Gui stopped it (said calmly, with a way to start it again).
 */
function StoppedBar({ crashed }: { crashed: boolean }) {
  return (
    // Its tint over the window's surface, as the rest of the chrome's bars.
    <div
      role={crashed ? 'alert' : 'status'}
      className="relative z-20 shrink-0 border-t border-line bg-surface"
    >
      <div className={cn('flex h-9 items-center gap-2 pr-1.5 pl-3', crashed && 'bg-danger-soft')}>
        {crashed ? (
          <TriangleAlert className="size-3.5 shrink-0 text-danger" aria-hidden="true" />
        ) : (
          <Info className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
        )}
        <p className="min-w-0 flex-1 truncate text-small">
          {crashed
            ? "Your app stopped with an error, so the preview won't update."
            : "Your app was stopped outside Gui, so the preview won't update."}
        </p>
        <Button variant="ghost" size="sm" onClick={() => gui.showLogs()}>
          Show logs
        </Button>
        <Button size="sm" onClick={() => gui.restartDevServer()}>
          {crashed ? 'Restart' : 'Start'}
        </Button>
      </div>
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
