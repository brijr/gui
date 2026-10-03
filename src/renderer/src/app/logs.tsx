import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { ChevronDown, ChevronUp, SquareTerminal } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { WindowState } from '../../../shared/types'
import { grat } from '../lib/api'
import { cn } from '../lib/cn'

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function terminalTheme() {
  return {
    background: cssVar('--canvas'),
    foreground: cssVar('--fg'),
    cursor: cssVar('--canvas'),
    selectionBackground: cssVar('--accent-soft'),
  }
}

export function Logs({ state }: { state: WindowState }) {
  if (!state.project) return null
  const open = state.logsOpen

  return (
    <section aria-label="Dev server logs" className="shrink-0 border-t border-line bg-surface">
      <button
        type="button"
        onClick={() => grat.setLogsOpen(!open)}
        aria-expanded={open}
        className="flex h-7 w-full items-center gap-2 px-3 text-left text-muted hover:text-fg"
      >
        <SquareTerminal className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
          {state.devServer.lastLine || state.devServer.command || 'No output yet'}
        </span>
        {open ? (
          <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronUp className="size-3.5 shrink-0" aria-hidden="true" />
        )}
      </button>
      <div
        className={cn('overflow-hidden bg-canvas px-3', open ? 'h-56 py-2' : 'h-0')}
        aria-hidden={!open}
      >
        {/* Keyed by project so each project gets a fresh terminal with its own log history. */}
        <LogsTerminal key={state.project.root} />
      </div>
    </section>
  )
}

/** Mounted only once a project exists, so its host element is there when the effect runs. */
function LogsTerminal() {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const term = new Terminal({
      fontFamily: '"SF Mono", ui-monospace, Menlo, monospace',
      fontSize: 11,
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
    const off = grat.onLogs((chunk) => {
      if (ready) term.write(chunk)
    })
    void grat.getLogs().then((logs) => {
      if (logs) term.write(logs)
      ready = true
    })

    const resize = () => {
      if (el.clientHeight < 20) return
      fit.fit()
      grat.resizeLogs(term.cols, term.rows)
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
