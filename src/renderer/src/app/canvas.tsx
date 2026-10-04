import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Info,
  KeyRound,
  Package,
  Play,
  TriangleAlert,
  X,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { ProjectSetup, WindowState, WorkspaceApp } from '../../../shared/types'
import { AgentCard } from '../agents/agent-card'
import { gui } from '../lib/api'
import { TechnicalDetails } from '../lib/disclosure'
import { PathText } from '../lib/path-text'
import { Card, GroupLabel, List, ListRow, Message } from '../lib/surface'
import { Button, Code, IconButton, Kbd, Spinner } from '../lib/ui'

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

const ALERT = <TriangleAlert className="size-4" aria-hidden="true" />
const LOADING = <Spinner size="md" />

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
      <SetupCard
        icon={LOADING}
        title="Installing dependencies…"
        detail="Getting the project ready to run. The first time can take a few minutes."
        actions={<LogsToggle open={logsOpen} noun="output" />}
        footer={env}
      />
    )
  }

  if (setup?.dependencies === 'failed') {
    return (
      <SetupCard
        icon={ALERT}
        tone="danger"
        title="Couldn't install dependencies"
        detail="The install stopped with an error."
        note={devServer.lastLine}
        actions={
          <>
            <Button onClick={() => gui.installDependencies()}>Try again</Button>
            <LogsToggle open={logsOpen} noun="output" />
          </>
        }
        footer={env}
      />
    )
  }

  if (preview.error) {
    return (
      <SetupCard
        icon={ALERT}
        tone="danger"
        title="Your app couldn't load"
        detail={preview.error}
        actions={
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
      <SetupCard
        icon={LOADING}
        title="Your app is taking a while to start"
        detail="Gui is waiting for it to show an address. Check the logs, or enter your app's address if it's already running."
        note={devServer.lastLine}
        actions={
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
      <SetupCard
        icon={LOADING}
        title={devServer.status === 'starting' ? 'Starting your app…' : 'Loading your app…'}
        note={devServer.lastLine || devServer.command || ''}
        footer={env}
      />
    )
  }

  if (devServer.status === 'exited') {
    const crashed = devServer.exitCode !== 0
    return (
      <SetupCard
        icon={crashed ? ALERT : <Info className="size-4" aria-hidden="true" />}
        tone={crashed ? 'danger' : 'neutral'}
        title="Your app stopped"
        detail={crashed ? 'It quit with an error. The logs show what happened.' : ''}
        note={devServer.lastLine || `Exit code ${devServer.exitCode}`}
        actions={
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
      <SetupCard
        icon={<Info className="size-4" aria-hidden="true" />}
        title="Gui doesn't know how to start this app"
        detail="Add a “dev” script to package.json, or enter your app's address in the bar above."
        actions={
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
      <SetupCard
        icon={<Package className="size-4" aria-hidden="true" />}
        title="This project needs a quick setup"
        detail="Gui will install its packages and start it, which runs the project's own scripts."
        actions={
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
      <SetupCard
        icon={<Play className="size-4" aria-hidden="true" />}
        title="Your app isn't running"
        note={project.devCommand ?? ''}
        actions={
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

interface SetupCardProps {
  icon: ReactNode
  tone?: 'neutral' | 'danger'
  title: string
  /** Plain explanation */
  detail?: string
  /** The specifics (command, last output line), behind a Details toggle for people who want them */
  note?: string
  actions?: ReactNode
  /** A quiet extra row under a divider */
  footer?: ReactNode
}

/** A canvas state: the shared Message in a card, with optional details and a footer row. */
function SetupCard({ icon, tone, title, detail, note, actions, footer }: SetupCardProps) {
  return (
    <Card className="flex w-full max-w-sm flex-col gap-4 p-5">
      <Message icon={icon} tone={tone} title={title} actions={actions}>
        {detail}
      </Message>
      {note && <TechnicalDetails text={note} />}
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
    <Card className="flex w-full max-w-sm flex-col gap-4 p-5">
      <div className="flex flex-col gap-1 text-center">
        <p className="font-semibold">Which app should Gui preview?</p>
        <p className="text-pretty text-muted">
          This project has {apps.length} apps. You can switch later from the project menu.
        </p>
      </div>
      <List>
        {apps.map((app) => (
          <li key={app.dir}>
            <ListRow
              flush
              onClick={() => gui.chooseApp(app.dir)}
              title={app.name}
              detail={app.dir === '.' ? 'project root' : <PathText path={app.dir} />}
              trailing={<ChevronRight className="size-3 shrink-0 text-subtle" aria-hidden="true" />}
            />
          </li>
        ))}
      </List>
    </Card>
  )
}

type EnvSetup = NonNullable<ProjectSetup['env']>

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

function EnvText({ env }: { env: EnvSetup }) {
  if (env.created) {
    return (
      <>
        Add your values to <Code>{fileName(env.target)}</Code> and save it.
      </>
    )
  }
  return (
    <>
      This project uses environment variables. Create <Code>{fileName(env.target)}</Code> from{' '}
      <Code>{fileName(env.example)}</Code>?
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
      <p className="min-w-0 flex-1 text-pretty text-small text-muted">
        <EnvText env={env} />
      </p>
      <EnvButton env={env} />
    </div>
  )
}

/** Projects whose env banner was dismissed; it stays that way across tab switches. */
const dismissedEnv = new Set<string>()

/**
 * The same offer as a slim bar above the preview once it's up, since many apps start
 * without their env and only break later. Dismissed for the rest of the session.
 */
export function EnvBanner({ state }: { state: WindowState }) {
  const root = state.project?.root ?? ''
  const [dismissed, setDismissed] = useState(() => dismissedEnv.has(root))
  const env = state.setup?.env
  if (!env || dismissed || !state.preview.visible) return null
  return (
    <div className="flex h-9 shrink-0 items-center gap-2.5 border-b border-line bg-surface pr-1.5 pl-3">
      <KeyRound className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate text-small text-muted">
        <EnvText env={env} />
      </p>
      <EnvButton env={env} />
      <IconButton
        label="Dismiss"
        icon={X}
        onClick={() => {
          dismissedEnv.add(root)
          setDismissed(true)
        }}
      />
    </div>
  )
}

const STEPS: readonly [string, ReactNode][] = [
  ['Open a project', 'Gui starts your app and shows it here.'],
  [
    'Point at something',
    <>
      Press <Kbd>⇧⌘C</Kbd> and click any element in your app.
    </>,
  ],
  ['Describe the change', 'Your agent edits the code, and you see the result right away.'],
]

function EmptyState({ state }: { state: WindowState }) {
  const firstRun = state.recent.length === 0
  return (
    <div className="flex w-full max-w-md flex-col gap-7">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-title font-semibold">
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
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-fill text-caption font-medium tabular-nums text-muted">
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

      <Button
        variant="primary"
        size="lg"
        icon={FolderOpen}
        className="self-start"
        onClick={() => void gui.openProject()}
      >
        Open project…
      </Button>

      <div className="flex flex-col gap-1">
        <AgentCard
          agentId={state.agentId}
          health={state.agents.find((agent) => agent.id === state.agentId) ?? null}
          change={
            <Button variant="ghost" trailingIcon={ChevronDown} onClick={() => gui.showAgentMenu()}>
              Change
            </Button>
          }
        />
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 self-start"
          onClick={() => gui.openSettings('agents')}
        >
          All agents and settings
        </Button>
      </div>

      {state.recent.length > 0 && (
        <div className="flex flex-col gap-1">
          <GroupLabel>Recent</GroupLabel>
          <ul className="-mx-2 flex flex-col">
            {state.recent.slice(0, 6).map((project) => (
              <li key={project.root}>
                <ListRow
                  onClick={() => void gui.openRecent(project.root)}
                  title={project.name}
                  detail={<PathText path={project.root} home={state.home} />}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
