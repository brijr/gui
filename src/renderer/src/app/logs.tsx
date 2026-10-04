import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { SquareTerminal, TriangleAlert, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { WindowState } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { Button, IconButton } from '../lib/ui'
import { crashed } from './server-status'

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

/** The terminal's colors, from the design tokens. */
function terminalTheme() {
  return {
    background: cssVar('--canvas'),
    foreground: cssVar('--fg'),
    cursor: cssVar('--canvas'),
    selectionBackground: cssVar('--accent-soft'),
  }
}

/**
 * The dev server's output, as a drawer under the canvas. It opens from the address bar's
 * status menu, ⇧⌘L, or "Show logs" where something went wrong; closed, nothing shows here
 * unless the dev server crashed under a live preview, which gets a slim bar instead of raw
 * output. (With no preview to show, the canvas says so itself.)
 */
export function Logs({ state }: { state: WindowState }) {
  if (!state.project) return null
  const open = state.logsOpen
  const failed = crashed(state)

  return (
    <>
      {!open && failed && state.preview.visible && <CrashBar />}
      {/* Kept mounted while closed, so the terminal keeps its scrollback and place. */}
      <section
        aria-label="Dev server logs"
        inert={!open}
        className={cn('shrink-0 bg-surface', open && 'border-t border-line')}
      >
        {open && (
          <div className="flex h-9 items-center gap-2 pr-1.5 pl-3">
            <SquareTerminal className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
            <h2 className="shrink-0 text-small font-medium">Logs</h2>
            <span className="min-w-0 flex-1 truncate font-mono text-caption text-subtle">
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
            <IconButton
              label="Hide logs (⇧⌘L)"
              icon={X}
              size="sm"
              onClick={() => gui.setLogsOpen(false)}
            />
          </div>
        )}
        <div className={cn('overflow-hidden bg-canvas px-3', open ? 'h-56 py-2' : 'h-0')}>
          {/* Keyed by project so each project gets a fresh terminal with its own log history. */}
          <LogsTerminal key={state.project.root} />
        </div>
      </section>
    </>
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
      <Button variant="ghost" size="sm" onClick={() => gui.setLogsOpen(true)}>
        Show logs
      </Button>
      <Button size="sm" onClick={() => gui.restartDevServer()}>
        Restart
      </Button>
    </div>
  )
}

/** Mounted only once a project exists, so its host element is there when the effect runs. */
function LogsTerminal() {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const term = new Terminal({
      fontFamily: cssVar('--font-mono'),
      fontSize: Number.parseFloat(cssVar('--text-caption')),
      lineHeight: 1.25,
      disableStdin: true,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      scrollback: 5000,
      theme: terminalTheme(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)

    // Main sends live chunks and the snapshot reply on one ordered channel, so anything
    // that arrives before the snapshot is already in it.
    let ready = false
    const off = gui.onLogs((chunk) => {
      if (ready) term.write(chunk)
    })
    void gui.getLogs().then((logs) => {
      if (logs) term.write(logs)
      ready = true
    })

    const resize = () => {
      if (el.clientHeight < 20) return
      fit.fit()
      gui.resizeLogs(term.cols, term.rows)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(el)

    const scheme = window.matchMedia('(prefers-color-scheme: dark)')
    const retheme = () => {
      term.options.theme = terminalTheme()
    }
    scheme.addEventListener('change', retheme)

    return () => {
      ready = false
      off()
      observer.disconnect()
      scheme.removeEventListener('change', retheme)
      term.dispose()
    }
  }, [])

  return <div ref={host} className="size-full" />
}
