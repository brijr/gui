import { ChevronDown, ChevronRight, FolderOpen, KeyRound, TriangleAlert, X } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { ProjectSetup, WindowState, WorkspaceApp } from '../../../shared/types'
import { AgentCard } from '../agents/agent-card'
import { gui } from '../lib/api'
import { Button, IconButton, Spinner, TechnicalDetails } from '../lib/ui'

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
        gui.setCanvasRect({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
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

/**
 * Everything between opening a project and seeing its preview: picking the app,
 * installing, starting, and what went wrong. One card, one next step.
 */
function CanvasMessage({ state }: { state: WindowState }) {
  const { project, devServer, preview, setup, logsOpen } = state

  if (!project) return <EmptyState state={state} />

  if (setup?.apps) return <AppChooser apps={setup.apps} />

  // Offered alongside whatever else the card says; the app may run without it.
  const env = setup?.env && <EnvRow env={setup.env} />

  if (setup?.dependencies === 'installing') {
    return (
      <Message
        icon={<Spinner className="size-4 text-muted" />}
        title="Installing dependencies…"
        detail="Getting the project ready to run. The first time can take a few minutes."
        action={<LogsToggle open={logsOpen} noun="output" />}
        footer={env}
      />
    )
  }

  if (setup?.dependencies === 'failed') {
    return (
      <Message
        icon={<TriangleAlert className="size-5 text-danger" aria-hidden="true" />}
        title="Couldn't install dependencies"
        detail="The install stopped with an error."
        note={devServer.lastLine}
        action={
          <>
            <Button variant="primary" onClick={() => gui.installDependencies()}>
              Try again
            </Button>
            <LogsToggle open={logsOpen} noun="output" />
          </>
        }
        footer={env}
      />
    )
  }

  if (preview.error) {
    return (
      <Message
        icon={<TriangleAlert className="size-5 text-danger" aria-hidden="true" />}
        title="Your app couldn't load"
        detail={preview.error}
        action={
          <>
            <Button onClick={() => gui.reload()}>Try again</Button>
            <LogsToggle open={logsOpen} noun="logs" />
          </>
        }
        footer={env}
      />
    )
  }

  if (devServer.status === 'starting' && devServer.slow) {
    return (
      <Message
        icon={<Spinner className="size-4 text-muted" />}
        title="Your app is taking a while to start"
        detail="Gui is waiting for it to show an address. Check the logs, or enter your app's address if it's already running."
        note={devServer.lastLine}
        action={
          <>
            <LogsToggle open={logsOpen} noun="logs" />
            <Button variant="ghost" onClick={focusAddressBar}>
              Enter address
            </Button>
          </>
        }
        footer={env}
      />
    )
  }

  if (devServer.status === 'starting' || (devServer.status === 'running' && !preview.visible)) {
    return (
      <Message
        icon={<Spinner className="size-4 text-muted" />}
        title={devServer.status === 'starting' ? 'Starting your app…' : 'Loading your app…'}
        note={devServer.lastLine || devServer.command || ''}
        footer={env}
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
            <Button variant="primary" onClick={() => gui.restartDevServer()}>
              Start again
            </Button>
            <LogsToggle open={logsOpen} noun="logs" />
          </>
        }
        footer={env}
      />
    )
  }

  if (!project.devCommand && !preview.url) {
    return (
      <Message
        title="Gui doesn't know how to start this app"
        detail="Add a “dev” script to package.json, or enter your app's address in the bar above."
        action={
          <Button variant="ghost" onClick={focusAddressBar}>
            Enter address
          </Button>
        }
      />
    )
  }

  // Not installed yet, and the user hasn't agreed to run anything (or said "Not now").
  // The button asks first unless the project is already trusted.
  if (setup?.dependencies === 'missing' && devServer.status === 'idle') {
    return (
      <Message
        title="This project needs a quick setup"
        detail="Gui will install its packages and start it, which runs the project's own scripts."
        action={
          <Button variant="primary" onClick={() => gui.installDependencies()}>
            Install and start
          </Button>
        }
        footer={env}
      />
    )
  }

  if (devServer.status === 'idle' && !preview.visible) {
    return (
      <Message
        title="Your app isn't running"
        note={project.devCommand ?? ''}
        action={
          <Button variant="primary" onClick={() => gui.startDevServer()}>
            Start app
          </Button>
        }
        footer={env}
      />
    )
  }

  return null
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full max-w-sm flex-col gap-4 rounded-xl border border-line bg-surface p-5 text-center">
      {children}
    </div>
  )
}

interface MessageProps {
  icon?: ReactNode
  title: string
  /** Plain explanation */
  detail?: string
  /** The specifics (command, last output line), behind a Details toggle for people who want them */
  note?: string
  action?: ReactNode
  /** A quiet extra row under a divider */
  footer?: ReactNode
}

function Message({ icon, title, detail, note, action, footer }: MessageProps) {
  return (
    <Card>
      <div className="flex flex-col items-center gap-2">
        {icon}
        <p className="font-medium text-[13px]">{title}</p>
        {detail && <p className="text-pretty text-muted">{detail}</p>}
        {action && <div className="mt-2 flex items-center gap-2">{action}</div>}
      </div>
      {note && <TechnicalDetails text={note} className="text-left" />}
      {footer}
    </Card>
  )
}

/** Opens the logs panel: "output" while setting up, "logs" once the app runs. */
function LogsToggle({ open, noun }: { open: boolean; noun: 'output' | 'logs' }) {
  return (
    <Button variant="ghost" aria-expanded={open} onClick={() => gui.setLogsOpen(!open)}>
      {open ? 'Hide' : 'Show'} {noun}
    </Button>
  )
}

function focusAddressBar() {
  document.getElementById('preview-address')?.focus()
}

function AppChooser({ apps }: { apps: WorkspaceApp[] }) {
  return (
    <Card>
      <div className="flex flex-col gap-1">
        <p className="font-medium text-[13px]">Which app should Gui preview?</p>
        <p className="text-pretty text-muted">
          This project has {apps.length} apps. You can switch later from the project menu.
        </p>
      </div>
      <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-line bg-raised text-left">
        {apps.map((app) => (
          <li key={app.dir}>
            <button
              type="button"
              onClick={() => gui.chooseApp(app.dir)}
              className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-hover focus-visible:-outline-offset-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{app.name}</span>
                <span className="block truncate font-mono text-[11px] text-subtle">{app.dir}</span>
              </span>
              <ChevronRight className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  )
}

type EnvSetup = NonNullable<ProjectSetup['env']>

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

function EnvText({ env }: { env: EnvSetup }) {
  const code = 'font-mono text-[11px] text-fg'
  if (env.created) {
    return (
      <>
        Add your values to <span className={code}>{fileName(env.target)}</span> and save it.
      </>
    )
  }
  return (
    <>
      This project uses environment variables. Create{' '}
      <span className={code}>{fileName(env.target)}</span> from{' '}
      <span className={code}>{fileName(env.example)}</span>?
    </>
  )
}

function EnvButton({ env }: { env: EnvSetup }) {
  return env.created ? (
    <Button className="shrink-0" title={env.target} onClick={() => gui.openEnvFile()}>
      Open
    </Button>
  ) : (
    <Button className="shrink-0" title={env.target} onClick={() => gui.createEnvFile()}>
      Create
    </Button>
  )
}

/** The env file offer inside the setup card. */
function EnvRow({ env }: { env: EnvSetup }) {
  return (
    <div className="flex items-center gap-3 border-t border-line pt-4 text-left">
      <KeyRound className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
      <p className="min-w-0 flex-1 text-pretty text-[12px] text-muted">
        <EnvText env={env} />
      </p>
      <EnvButton env={env} />
    </div>
  )
}

/**
 * The same offer as a slim bar above the preview once it's up, since many apps start
 * without their env and only break later. Dismissed for the rest of the session.
 */
export function EnvBanner({ state }: { state: WindowState }) {
  const [dismissed, setDismissed] = useState(false)
  const env = state.setup?.env
  if (!env || dismissed || !state.preview.visible) return null
  return (
    <div className="flex h-9 shrink-0 items-center gap-2.5 border-b border-line bg-surface pr-1.5 pl-3">
      <KeyRound className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate text-[12px] text-muted">
        <EnvText env={env} />
      </p>
      <EnvButton env={env} />
      <IconButton label="Dismiss" onClick={() => setDismissed(true)}>
        <X className="size-3.5" />
      </IconButton>
    </div>
  )
}

const STEPS = [
  ['Open a project', 'Gui starts your app and shows it here.'],
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
          Gui runs your app, shows it here, and lets your agent edit the real code while you point
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

      <Button variant="primary" className="h-8 self-start" onClick={() => void gui.openProject()}>
        <FolderOpen className="size-3.5" aria-hidden="true" />
        Open project…
      </Button>

      <div className="flex flex-col gap-1.5">
        <AgentCard
          agentId={state.agentId}
          health={state.agents.find((agent) => agent.id === state.agentId) ?? null}
          change={
            <Button variant="ghost" onClick={() => gui.showAgentMenu()}>
              Change
              <ChevronDown className="size-3 text-subtle" aria-hidden="true" />
            </Button>
          }
        />
        <button
          type="button"
          onClick={() => gui.openSettings('agents')}
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
                  onClick={() => void gui.openRecent(project.root)}
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
