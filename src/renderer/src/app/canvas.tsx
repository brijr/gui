import { ChevronDown, FolderOpen, TriangleAlert } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'
import type { WindowState } from '../../../shared/types'
import { AgentCard } from '../agents/agent-card'
import { grat } from '../lib/api'
import { Button, Spinner } from '../lib/ui'

/**
 * The preview is a native view layered over this element; we report our bounds so
 * main can position it. What we render here only shows while the preview is hidden.
 */
export function Canvas({ state }: { state: WindowState }) {
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let frame = 0
    const report = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect()
        grat.setCanvasRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
      })
    }
    const observer = new ResizeObserver(report)
    observer.observe(el)
    window.addEventListener('resize', report)
    report()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', report)
    }
  }, [])

  return (
    <main ref={ref} className="relative min-h-0 flex-1 bg-canvas">
      <div className="absolute inset-0 flex items-center justify-center p-8">
        <CanvasMessage state={state} />
      </div>
    </main>
  )
}

function CanvasMessage({ state }: { state: WindowState }) {
  const { project, devServer, preview } = state

  if (!project) return <EmptyState state={state} />

  if (preview.error) {
    return (
      <Message
        icon={<TriangleAlert className="size-5 text-danger" aria-hidden="true" />}
        title="Your app couldn't load"
        detail={preview.error}
        action={
          <>
            <Button onClick={() => grat.reload()}>Try again</Button>
            <ShowLogs />
          </>
        }
      />
    )
  }

  if (devServer.status === 'starting' && devServer.slow) {
    return (
      <Message
        icon={<Spinner className="size-4 text-muted" />}
        title="Your app is taking a while to start"
        detail="Grat is waiting for it to show an address. Check the logs, or enter your app's address if it's already running."
        note={devServer.lastLine}
        action={
          <>
            <ShowLogs />
            <Button variant="ghost" onClick={focusAddressBar}>
              Enter address
            </Button>
          </>
        }
      />
    )
  }

  if (devServer.status === 'starting' || (devServer.status === 'running' && !preview.visible)) {
    return (
      <Message
        icon={<Spinner className="size-4 text-muted" />}
        title={devServer.status === 'starting' ? 'Starting your app…' : 'Loading your app…'}
        note={devServer.lastLine || devServer.command || ''}
      />
    )
  }

  if (devServer.status === 'exited') {
    const crashed = devServer.exitCode !== 0
    return (
      <Message
        icon={<TriangleAlert className="size-5 text-danger" aria-hidden="true" />}
        title="Your app stopped"
        detail={crashed ? 'It quit with an error. The logs show what happened.' : ''}
        note={devServer.lastLine || `Exit code ${devServer.exitCode}`}
        action={
          <>
            <Button variant="primary" onClick={() => grat.restartDevServer()}>
              Start again
            </Button>
            <ShowLogs />
          </>
        }
      />
    )
  }

  if (!project.devCommand && !preview.url) {
    return (
      <Message
        title="Grat doesn't know how to start this app"
        detail="Add a “dev” script to package.json, or enter your app's address in the bar above."
        action={
          <Button variant="ghost" onClick={focusAddressBar}>
            Enter address
          </Button>
        }
      />
    )
  }

  if (devServer.status === 'idle' && !preview.visible) {
    return (
      <Message
        title="Your app isn't running"
        note={project.devCommand ?? ''}
        action={
          <Button variant="primary" onClick={() => grat.startDevServer()}>
            Start app
          </Button>
        }
      />
    )
  }

  return null
}

function ShowLogs() {
  return (
    <Button variant="ghost" onClick={() => grat.setLogsOpen(true)}>
      Show logs
    </Button>
  )
}

function focusAddressBar() {
  document.getElementById('preview-address')?.focus()
}

interface MessageProps {
  icon?: ReactNode
  title: string
  /** Plain explanation */
  detail?: string
  /** The specifics (command, last output line), in mono for people who want them */
  note?: string
  action?: ReactNode
}

function Message({ icon, title, detail, note, action }: MessageProps) {
  return (
    <div className="flex max-w-md flex-col items-center gap-2 text-center">
      {icon}
      <p className="font-medium text-[13px]">{title}</p>
      {detail && <p className="text-pretty text-muted">{detail}</p>}
      {note && <p className="line-clamp-3 select-text font-mono text-[11px] text-subtle">{note}</p>}
      {action && <div className="mt-2 flex items-center gap-1.5">{action}</div>}
    </div>
  )
}

const STEPS = [
  ['Open a project', 'Grat starts your app and shows it here.'],
  ['Point at something', 'Press ⇧⌘C and click any element in your app.'],
  ['Describe the change', 'Your agent edits the code, and you see the result right away.'],
] as const

function EmptyState({ state }: { state: WindowState }) {
  const firstRun = state.recent.length === 0
  return (
    <div className="flex w-full max-w-md flex-col gap-7">
      <div className="flex flex-col gap-1.5">
        <h1 className="font-semibold text-[15px]">
          {firstRun ? 'Design your app with your own agents' : 'Open a project'}
        </h1>
        <p className="text-pretty text-muted">
          Grat runs your app, shows it here, and lets your agent edit the real code while you point
          at things.
        </p>
      </div>

      {firstRun && (
        <ol className="flex flex-col gap-2.5">
          {STEPS.map(([title, detail], i) => (
            <li key={title} className="flex gap-3">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-hover text-[11px] font-medium tabular-nums text-muted">
                {i + 1}
              </span>
              <span>
                <span className="font-medium">{title}</span>
                <span className="text-muted"> — {detail}</span>
              </span>
            </li>
          ))}
        </ol>
      )}

      <Button variant="primary" className="h-8 self-start" onClick={() => void grat.openProject()}>
        <FolderOpen className="size-3.5" aria-hidden="true" />
        Open project…
      </Button>

      <div className="flex flex-col gap-1.5">
        <AgentCard
          agentId={state.agentId}
          health={state.agents.find((agent) => agent.id === state.agentId) ?? null}
          change={
            <Button variant="ghost" onClick={() => grat.showAgentMenu()}>
              Change
              <ChevronDown className="size-3 text-subtle" aria-hidden="true" />
            </Button>
          }
        />
        <button
          type="button"
          onClick={() => grat.openSettings('agents')}
          className="self-start text-[11.5px] text-subtle hover:text-fg"
        >
          All agents and settings
        </button>
      </div>

      {state.recent.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="font-medium text-[11px] text-subtle uppercase tracking-wide">Recent</p>
          <ul className="-mx-2 flex flex-col">
            {state.recent.slice(0, 6).map((project) => (
              <li key={project.root}>
                <button
                  type="button"
                  onClick={() => void grat.openRecent(project.root)}
                  className="flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-hover"
                >
                  <span className="font-medium">{project.name}</span>
                  <span className="w-full truncate font-mono text-[11px] text-subtle">
                    {project.root}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
