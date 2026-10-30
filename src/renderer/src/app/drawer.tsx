import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react'
import {
  type AgentId,
  type DrawerTab,
  drawerNeighbor,
  type TerminalId,
  type WindowState,
} from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { ChevronDown, Info, Plus, SquareTerminal, TriangleAlert } from '../lib/icons'
import { StatusDot } from '../lib/status'
import { Banner, PanelHeader } from '../lib/surface'
import {
  rovingTabKeyDown,
  SCROLLING_TABLIST,
  TAB_LABEL,
  TabCloseButton,
  tabClass,
  useScrollingTabs,
} from '../lib/tabs'
import { Button, IconButton, PRESS, TIGHT_HIT_AREA } from '../lib/ui'
import { FixStartupButton } from './fix-startup'
import { useLayoutSlide } from './layout-morph'
import { crashed, serverStatus, stoppedOutside } from './server-status'

// Ghostty (WebAssembly) is most of the main window's code; it loads after the window's first
// paint.
const terminalViews = () => import('./terminal-views')
const LogsView = lazy(() => terminalViews().then((m) => ({ default: m.LogsView })))
const ShellView = lazy(() => terminalViews().then((m) => ({ default: m.ShellView })))

const tabId = (tab: DrawerTab) => `drawer-tab-${tab}`
const panelId = (tab: DrawerTab) => `drawer-panel-${tab}`

interface TabEntry {
  tab: DrawerTab
  label: string
  icon: ReactNode
  /** Read after the label, for assistive tech */
  note?: string
  /** Errors in its output, as a small count after the label */
  errors?: number
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
  const tabList = useRef<HTMLDivElement>(null)
  // More terminals than fit: the row scrolls, and the one shown is always in it.
  useScrollingTabs(tabList, drawn ? (state.drawer.tab ?? 'server') : null)

  const { project, drawer } = state
  if (!project) return null
  const { terminals } = drawer
  const shown = drawer.tab ?? 'server'
  const failed = crashed(state)
  const outside = stoppedOutside(state)
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
      errors: state.serverErrors,
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

  return (
    <>
      {!drawn &&
        !state.focusMode &&
        state.devServer.status === 'exited' &&
        state.preview.visible && (
          <StoppedBar crashed={failed} outside={outside} agentId={state.agentId} />
        )}
      {/* Kept mounted while closed, so the terminals keep their scrollback and place. */}
      <section
        ref={section}
        aria-label="Terminal"
        inert={!open}
        className={cn(
          // Chrome over the canvas while it slides away on top of it.
          'z-chrome shrink-0 bg-surface',
          leaving ? 'absolute inset-x-0 bottom-0' : 'relative',
          drawn && 'border-t border-line',
        )}
      >
        {drawn && (
          // The header recipe, but its tabs carry their own inset, so the first label lands
          // near the 12px the recipe gives a title. Over the terminal's darker canvas, no
          // hairline is needed.
          <PanelHeader
            borderless
            className="pl-1.5"
            actions={
              <IconButton
                className={TIGHT_HIT_AREA}
                label="Hide terminal"
                shortcut="toggleTerminal"
                icon={ChevronDown}
                size="sm"
                onClick={() => gui.setDrawerOpen(false)}
              />
            }
          >
            {/*
             * Tabs only, as in the tab strip. A terminal's × is for the pointer and hidden from
             * assistive tech; from the keyboard, Delete on its tab ends it.
             */}
            <div
              ref={tabList}
              role="tablist"
              aria-label="Terminal tabs"
              className={cn(SCROLLING_TABLIST, 'shrink')}
            >
              {tabs.map((entry, index) => {
                const selected = entry.tab === shown
                const terminal = entry.tab === 'server' ? null : entry.tab
                return (
                  <div
                    key={entry.tab}
                    role="presentation"
                    className={cn(
                      tabClass('segment', selected),
                      // They narrow to this, then the row scrolls.
                      'min-w-20 transition-[color,background-color]',
                    )}
                  >
                    <button
                      type="button"
                      role="tab"
                      id={tabId(entry.tab)}
                      aria-controls={panelId(entry.tab)}
                      aria-selected={selected}
                      tabIndex={selected ? 0 : -1}
                      aria-label={tabName(entry)}
                      title={tabName(entry) ?? entry.label}
                      // A click shows it and puts the keyboard in it; Enter or Space only shows it.
                      onClick={(event) => select(entry.tab, event.detail > 0)}
                      // The middle button ends a terminal, rather than starting to scroll.
                      onMouseDown={(event) => {
                        if (event.button === 1) event.preventDefault()
                      }}
                      onAuxClick={(event) => {
                        if (event.button === 1 && terminal) close(terminal)
                      }}
                      onKeyDown={(event) =>
                        rovingTabKeyDown(event, {
                          index,
                          count: tabs.length,
                          select: (target) => {
                            const next = tabs[target]
                            if (next) select(next.tab, false)
                          },
                          // Main shows the neighbor, which has the keyboard. The dev server's
                          // output can't be closed.
                          close: terminal ? () => gui.closeTerminal(terminal) : undefined,
                        })
                      }
                      className={cn(TAB_LABEL, 'pl-2', PRESS, terminal ? 'pr-7' : 'pr-2.5')}
                    >
                      {entry.icon}
                      <span className={cn('truncate', entry.note && 'text-subtle')}>
                        {entry.label}
                      </span>
                      {!!entry.errors && (
                        <span aria-hidden="true" className="text-caption text-danger tabular-nums">
                          {entry.errors}
                        </span>
                      )}
                    </button>
                    {/* Always there: tabs here are as wide as their names, so a hidden one
                        would leave a gap. */}
                    {terminal && (
                      <TabCloseButton name={entry.label} onClose={() => close(terminal)} />
                    )}
                  </div>
                )
              })}
            </div>
            <IconButton
              className={TIGHT_HIT_AREA}
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
                      <FixStartupButton agentId={state.agentId} variant="secondary" size="sm" />
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
          </PanelHeader>
        )}
        <div className={cn('relative overflow-hidden bg-canvas', drawn ? 'h-56' : 'h-0')}>
          {/* First, so it's the drawer's first terminal on the page. Keyed by project, so each
              project gets a fresh one with its own log history. */}
          <Panel tab="server" shown={shown === 'server'}>
            <LogsView
              key={project.root}
              active={open && shown === 'server'}
              focus={open && shown === 'server' && focusRequest === 'server'}
              onFocused={() => setFocusRequest(null)}
            />
          </Panel>
          {terminals.map((terminal) => (
            <Panel key={terminal.id} tab={terminal.id} shown={shown === terminal.id}>
              <ShellView
                id={terminal.id}
                active={open && shown === terminal.id}
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

/** A tab's name with what's read after it (exited, its errors); undefined when it's the label alone. */
function tabName({ label, note, errors }: TabEntry) {
  const count = errors ? (errors === 1 ? '1 error' : `${errors} errors`) : undefined
  const extra = [note, count].filter(Boolean)
  return extra.length ? [label, ...extra].join(', ') : undefined
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
      <Suspense fallback={null}>{children}</Suspense>
    </div>
  )
}

/**
 * Under a preview whose app is gone: it crashed (an alert, with the logs to see why), or
 * it exited cleanly or something outside Gui stopped it (said calmly, with a way to restart).
 */
function StoppedBar({
  crashed,
  outside,
  agentId,
}: {
  crashed: boolean
  outside: boolean
  agentId: AgentId
}) {
  return (
    // The banner's soft tint goes over the window's surface, as the rest of the chrome's bars.
    <div className="relative z-chrome shrink-0 bg-surface">
      <Banner
        edge="bottom"
        tone={crashed ? 'danger' : 'neutral'}
        icon={crashed ? TriangleAlert : Info}
        role={crashed ? 'alert' : 'status'}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => gui.showLogs()}>
              Show logs
            </Button>
            {crashed && <FixStartupButton agentId={agentId} variant="secondary" size="sm" />}
            <Button size="sm" onClick={() => gui.restartDevServer()}>
              {outside ? 'Start' : 'Restart'}
            </Button>
          </>
        }
      >
        <span className="truncate">
          {crashed
            ? 'Your app stopped with an error.'
            : outside
              ? 'Your app was stopped outside Gui.'
              : 'Your app stopped.'}
        </span>
      </Banner>
    </div>
  )
}
