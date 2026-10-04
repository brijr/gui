import { Check, ChevronRight, FolderOpen, KeyRound, TriangleAlert, X } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import {
  AGENTS,
  type AgentBinarySource,
  type AgentHealth,
  type ProjectSetup,
  type WindowState,
  type WorkspaceApp,
} from '../../../shared/types'
import { grat } from '../lib/api'
import { cn } from '../lib/cn'
import { readableError } from '../lib/errors'
import { Button, IconButton, Spinner } from '../lib/ui'

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

/**
 * Everything between opening a project and seeing its preview: picking the app,
 * installing, starting, and what went wrong. One card, one next step.
 */
function CanvasMessage({ state }: { state: WindowState }) {
  const { project, devServer, preview, setup } = state

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
        action={<OutputToggle open={state.logsOpen} />}
        footer={env}
      />
    )
  }

  if (setup?.dependencies === 'failed') {
    return (
      <Message
        icon={<TriangleAlert className="size-5 text-danger" aria-hidden="true" />}
        title="Couldn't install dependencies"
        detail={devServer.lastLine || 'The install stopped with an error.'}
        mono
        action={
          <>
            <Button variant="primary" onClick={() => grat.installDependencies()}>
              Try again
            </Button>
            <OutputToggle open={state.logsOpen} />
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
        title="The preview couldn't load"
        detail={preview.error}
        action={<Button onClick={() => grat.reload()}>Retry</Button>}
        footer={env}
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
        footer={env}
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
        footer={env}
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

  // Not installed yet, and the user hasn't agreed to run anything (or said "Not now").
  // The button asks first unless the project is already trusted.
  if (setup?.dependencies === 'missing' && devServer.status === 'idle') {
    return (
      <Message
        title="This project needs a quick setup"
        detail="Grat will install its packages and start it, which runs the project's own scripts."
        action={
          <Button variant="primary" onClick={() => grat.installDependencies()}>
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
        title="Dev server is stopped"
        detail={project.devCommand ?? ''}
        mono
        action={
          <Button variant="primary" onClick={() => grat.startDevServer()}>
            Start dev server
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
  detail: string
  mono?: boolean
  action?: ReactNode
  /** A quiet extra row under a divider */
  footer?: ReactNode
}

function Message({ icon, title, detail, mono, action, footer }: MessageProps) {
  return (
    <Card>
      <div className="flex flex-col items-center gap-2">
        {icon}
        <p className="font-medium text-[13px]">{title}</p>
        {detail && (
          <p
            className={
              mono
                ? 'line-clamp-3 select-text break-words font-mono text-[11px] text-subtle'
                : 'text-pretty text-muted'
            }
          >
            {detail}
          </p>
        )}
        {action && <div className="mt-2 flex items-center gap-2">{action}</div>}
      </div>
      {footer}
    </Card>
  )
}

function OutputToggle({ open }: { open: boolean }) {
  return (
    <Button variant="ghost" aria-expanded={open} onClick={() => grat.setLogsOpen(!open)}>
      {open ? 'Hide output' : 'Show output'}
    </Button>
  )
}

function AppChooser({ apps }: { apps: WorkspaceApp[] }) {
  return (
    <Card>
      <div className="flex flex-col gap-1">
        <p className="font-medium text-[13px]">Which app should Grat preview?</p>
        <p className="text-pretty text-muted">
          This project has {apps.length} apps. You can switch later from the project menu.
        </p>
      </div>
      <ul className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-line bg-raised text-left">
        {apps.map((app) => (
          <li key={app.dir}>
            <button
              type="button"
              onClick={() => grat.chooseApp(app.dir)}
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
    <Button className="shrink-0" title={env.target} onClick={() => grat.openEnvFile()}>
      Open
    </Button>
  ) : (
    <Button className="shrink-0" title={env.target} onClick={() => grat.createEnvFile()}>
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
      setError(readableError(err))
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
