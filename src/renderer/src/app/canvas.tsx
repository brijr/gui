import { Check, FolderOpen, TriangleAlert } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import {
  AGENTS,
  type AgentBinarySource,
  type AgentHealth,
  type WindowState,
} from '../../../shared/types'
import { grat } from '../lib/api'
import { cn } from '../lib/cn'
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
        title="The preview couldn't load"
        detail={preview.error}
        action={<Button onClick={() => grat.reload()}>Retry</Button>}
      />
    )
  }

  if (devServer.status === 'starting' || (devServer.status === 'running' && !preview.visible)) {
    return (
      <Message
        icon={<Spinner className="size-4 text-muted" />}
        title={devServer.status === 'starting' ? 'Starting dev server' : 'Loading preview'}
        detail={devServer.lastLine || devServer.command || ''}
        mono
      />
    )
  }

  if (devServer.status === 'exited') {
    return (
      <Message
        icon={<TriangleAlert className="size-5 text-danger" aria-hidden="true" />}
        title="The dev server stopped"
        detail={devServer.lastLine || `Exit code ${devServer.exitCode}`}
        mono
        action={<Button onClick={() => grat.restartDevServer()}>Restart</Button>}
      />
    )
  }

  if (!project.devCommand && !preview.url) {
    return (
      <Message
        title="No dev script found"
        detail="Add a dev script to package.json, or enter your app's URL in the address bar."
      />
    )
  }

  if (devServer.status === 'idle' && !preview.visible) {
    return (
      <Message
        title="Dev server is stopped"
        detail={project.devCommand ?? ''}
        mono
        action={
          <Button variant="primary" onClick={() => grat.startDevServer()}>
            Start dev server
          </Button>
        }
      />
    )
  }

  return null
}

interface MessageProps {
  icon?: ReactNode
  title: string
  detail: string
  mono?: boolean
  action?: ReactNode
}

function Message({ icon, title, detail, mono, action }: MessageProps) {
  return (
    <div className="flex max-w-md flex-col items-center gap-2 text-center">
      {icon}
      <p className="font-medium text-[13px]">{title}</p>
      {detail && (
        <p className={mono ? 'line-clamp-3 font-mono text-[11px] text-subtle' : 'text-muted'}>
          {detail}
        </p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

const STEPS = [
  ['Open a project', 'Grat starts its dev server and shows your app.'],
  ['Point at something', 'Press ⇧⌘C and click any element in the preview.'],
  ['Describe the change', 'Your agent edits the code; the preview updates live.'],
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
          Grat runs your dev server, shows your app, and lets your agent edit the real code while
          you point at things.
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

      <Agents state={state} />

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

function Agents({ state }: { state: WindowState }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <p className="font-medium text-[11px] text-subtle uppercase tracking-wide">Agents</p>
        <button
          type="button"
          onClick={() => grat.checkAgents()}
          className="text-[11px] text-subtle hover:text-fg"
        >
          Check again
        </button>
      </div>
      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
        {state.agents.map((health) => (
          <AgentRow key={health.id} health={health} selected={health.id === state.agentId} />
        ))}
      </ul>
    </div>
  )
}

function AgentRow({ health, selected }: { health: AgentHealth; selected: boolean }) {
  const [error, setError] = useState<string | null>(null)
  const nameId = useId()
  const name = AGENTS.find((agent) => agent.id === health.id)?.name ?? health.id
  const busy = health.status === 'checking' || health.status === 'signing-in'
  const action = agentAction(health)

  // Install and sign-in report failures through health; this catches IPC failures.
  const perform = async (run: () => Promise<void>) => {
    setError(null)
    try {
      await run()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`Use ${name} by default`}
        onClick={() => grat.setAgent(health.id)}
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
          selected ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong',
        )}
      >
        {selected && <Check className="size-2.5" strokeWidth={3} aria-hidden="true" />}
      </button>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2">
          <span id={nameId} className="font-medium">
            {name}
          </span>
          <AgentStatusLabel health={health} />
        </p>
        <AgentDetail health={health} name={name} error={error} />
      </div>
      {action && (
        <Button
          className="shrink-0"
          aria-describedby={nameId}
          disabled={busy}
          onClick={() => void perform(action.run)}
        >
          {action.label}
        </Button>
      )}
    </li>
  )
}

/** The row's one next step: installing the CLI comes before signing in. */
function agentAction(health: AgentHealth): { label: string; run: () => Promise<void> } | null {
  if (health.install) {
    if (health.status === 'installing') return null
    return { label: installLabel(health), run: () => grat.installAgent(health.id) }
  }
  if (health.signIn && health.status !== 'ready') {
    return {
      label: health.status === 'signing-in' ? 'Waiting…' : health.signIn.label,
      run: () => grat.signIn(health.id),
    }
  }
  return null
}

/** `install` stays set after a failed download, so the same button retries it. */
function installLabel(health: AgentHealth) {
  if (health.status === 'error') return 'Try again'
  return health.install === 'update' ? "Install Grat's copy" : 'Install'
}

const BINARY_SOURCES: Record<AgentBinarySource, string> = {
  yours: 'Your install',
  grat: 'Installed by Grat',
  bundled: 'Bundled (dev)',
}

function AgentDetail({
  health,
  name,
  error,
}: {
  health: AgentHealth
  name: string
  error: string | null
}) {
  if (health.status === 'installing') {
    return <InstallProgress name={name} progress={health.progress} />
  }

  if (health.status === 'ready') {
    if (!health.binary) return null
    const { source, version } = health.binary
    return (
      <p className="mt-0.5 select-text truncate text-[11.5px] text-subtle tabular-nums">
        {BINARY_SOURCES[source]}
        {version && ` · ${version}`}
      </p>
    )
  }

  const text = error ?? health.message
  if (!text) return null
  return <p className="mt-0.5 select-text text-pretty text-[12px] text-muted">{text}</p>
}

const megabytes = (bytes: number) => Math.round(bytes / 1e6)

function progressText(received: number, total: number | null) {
  if (received === 0) return 'Starting download…'
  if (total === null) return `Downloading ${megabytes(received)} MB`
  // The download is done; Grat is unpacking and checking it.
  if (received >= total) return 'Finishing up…'
  return `Downloading ${megabytes(received)} of ${megabytes(total)} MB`
}

function InstallProgress({ name, progress }: { name: string; progress: AgentHealth['progress'] }) {
  const received = progress?.received ?? 0
  const total = progress?.total ?? null
  // Indeterminate until bytes arrive, and throughout when the server didn't send a size.
  const fraction = received > 0 && total ? Math.min(received / total, 1) : null
  const text = progressText(received, total)

  return (
    <div className="mt-1.5 flex flex-col gap-1">
      <div
        role="progressbar"
        aria-label={`Installing ${name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
        aria-valuetext={text}
        className="h-1 overflow-hidden rounded-full bg-hover"
      >
        {fraction === null ? (
          <div className="size-full animate-pulse bg-accent/40" />
        ) : (
          <div
            className="size-full origin-left bg-accent transition-transform duration-150"
            style={{ transform: `scaleX(${fraction})` }}
          />
        )}
      </div>
      {/* Read through the progress bar's value text */}
      <p aria-hidden="true" className="text-[11.5px] text-subtle tabular-nums">
        {text}
      </p>
    </div>
  )
}

const PENDING_LABELS = {
  checking: 'Checking',
  'signing-in': 'Signing in',
  installing: 'Installing',
} as const

function AgentStatusLabel({ health }: { health: AgentHealth }) {
  switch (health.status) {
    case 'ready':
      return <span className="text-[11.5px] text-success">Ready</span>
    case 'checking':
    case 'signing-in':
    case 'installing':
      return (
        <span className="flex items-center gap-1.5 text-[11.5px] text-subtle">
          <Spinner className="size-2.5" />
          {PENDING_LABELS[health.status]}
        </span>
      )
    case 'not-installed':
      return health.install === 'update' ? (
        <span className="text-[11.5px] text-warning">Needs update</span>
      ) : (
        <span className="text-[11.5px] text-subtle">Not installed</span>
      )
    case 'signed-out':
      return <span className="text-[11.5px] text-warning">Not signed in</span>
    case 'error':
      return <span className="text-[11.5px] text-danger">Unavailable</span>
    default:
      return null
  }
}
