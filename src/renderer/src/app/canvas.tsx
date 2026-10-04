import {
  AppWindow,
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
import { FRAME_LABEL_HEIGHT } from '../../../shared/layout'
import { shortcutText } from '../../../shared/shortcuts'
import {
  type ProjectSetup,
  type Viewport,
  type ViewportFrame,
  viewportSpec,
  type WindowState,
  type WorkspaceApp,
} from '../../../shared/types'
import { AgentCard } from '../agents/agent-card'
import { gui } from '../lib/api'
import { TechnicalDetails } from '../lib/disclosure'
import { PathText } from '../lib/path-text'
import { Card, GroupLabel, List, ListItem, ListRow, Message } from '../lib/surface'
import { Button, Code, IconButton, Kbd, Spinner } from '../lib/ui'
import { focusAddressBar } from './toolbar'

/**
 * The preview is a native view layered over this element; we report our bounds so
 * main can position it. What we render here only shows around it, or while it's hidden.
 */
export function Canvas({ state }: { state: WindowState }) {
  const { preview } = state
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
      {preview.frame && preview.visible && (
        <DeviceFrame viewport={preview.viewport} frame={preview.frame} />
      )}
      {/* Centered while it fits; scrolls from the top in a short window. */}
      <div className="absolute inset-0 flex flex-col overflow-y-auto p-8">
        <div className="m-auto flex w-full justify-center">
          <CanvasMessage state={state} />
        </div>
      </div>
    </main>
  )
}

/**
 * A fixed viewport's edge and shadow around the preview, which is the device's screen, and
 * its name above: "Laptop · 1440 × 900", with the scale when it's drawn smaller.
 */
function DeviceFrame({ viewport, frame }: { viewport: Viewport; frame: ViewportFrame }) {
  const { name, size } = viewportSpec(viewport)
  const { rect } = frame
  // Floored, so a frame drawn even slightly smaller never reads 100%.
  const percent = Math.floor(frame.scale * 100)
  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute border border-line-strong shadow-popover"
        style={{
          left: rect.x - 1,
          top: rect.y - 1,
          width: rect.width + 2,
          height: rect.height + 2,
        }}
      />
      <p
        className="absolute flex items-center text-caption whitespace-nowrap text-subtle tabular-nums"
        style={{ left: rect.x, top: rect.y - FRAME_LABEL_HEIGHT, height: FRAME_LABEL_HEIGHT }}
      >
        <span>
          <span className="font-medium text-muted">{name}</span>
          {size && ` · ${size.width} × ${size.height}`}
          {percent < 100 && ` · ${percent}%`}
        </span>
      </p>
    </>
  )
}

const ALERT = <TriangleAlert className="size-4" aria-hidden="true" />
const INFO = <Info className="size-4" aria-hidden="true" />
const LOADING = <Spinner size="md" />
const CHEVRON = <ChevronRight className="size-3 shrink-0 text-subtle" aria-hidden="true" />

/**
 * Everything between opening a project and seeing its preview: picking the app,
 * installing, starting, and what went wrong. One card, one next step.
 */
function CanvasMessage({ state }: { state: WindowState }) {
  const { project, devServer, preview, setup } = state
  // The drawer shows the dev server's output.
  const logsOpen = state.drawer.open && state.drawer.tab === 'server'

  if (!project) return <EmptyState state={state} />

  if (setup?.apps) return <AppChooser apps={setup.apps} />

  // Offered alongside whatever else the card says; the app may run without it.
  const env = setup?.env ?? null

  if (setup?.dependencies === 'installing') {
    return (
      <SetupCard
        icon={LOADING}
        title="Installing dependencies…"
        detail="Getting the project ready to run. The first time can take a few minutes."
        actions={<LogsToggle open={logsOpen} noun="output" />}
        env={env}
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
            <Button variant="primary" onClick={() => gui.installDependencies()}>
              Try again
            </Button>
            <LogsToggle open={logsOpen} noun="output" />
          </>
        }
        env={env}
      />
    )
  }

  // Ahead of a load error: with its server gone the page can't load, and starting it is the fix.
  if (devServer.status === 'exited') {
    const failed = devServer.exitCode !== 0
    return (
      <SetupCard
        icon={failed ? ALERT : INFO}
        tone={failed ? 'danger' : 'neutral'}
        title="Your app stopped"
        detail={failed ? 'It quit with an error. The logs show what happened.' : undefined}
        note={devServer.lastLine || `Exit code ${devServer.exitCode}`}
        actions={
          <>
            <Button variant="primary" onClick={() => gui.restartDevServer()}>
              Start again
            </Button>
            <LogsToggle open={logsOpen} noun="logs" />
          </>
        }
        env={env}
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
            <Button variant="primary" onClick={() => gui.reload()}>
              Try again
            </Button>
            <LogsToggle open={logsOpen} noun="logs" />
          </>
        }
        env={env}
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
            <Button variant="ghost" onClick={() => focusAddressBar()}>
              Enter address
            </Button>
          </>
        }
        env={env}
      />
    )
  }

  if (devServer.status === 'starting' || (devServer.status === 'running' && !preview.visible)) {
    return (
      <SetupCard
        icon={LOADING}
        title={devServer.status === 'starting' ? 'Starting your app…' : 'Loading your app…'}
        note={devServer.lastLine || devServer.command || ''}
        env={env}
      />
    )
  }

  if (!project.devCommand && !preview.url) {
    return (
      <SetupCard
        icon={INFO}
        title="Gui doesn't know how to start this app"
        detail="Add a “dev” script to package.json, or enter your app's address in the bar above."
        actions={
          <Button variant="ghost" onClick={() => focusAddressBar()}>
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
        env={env}
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
        env={env}
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
  /** What there is to choose from, as a List under the message */
  children?: ReactNode
  /** The env file to offer, as a row of its own */
  env?: EnvSetup | null
}

/**
 * A canvas state: the shared Message in a card, then what there is to choose or set up as
 * List rows (apps, the env file), then the technical details.
 */
function SetupCard({ icon, tone, title, detail, note, actions, children, env }: SetupCardProps) {
  return (
    <Card className="flex w-full max-w-sm flex-col gap-4 p-5">
      <Message icon={icon} tone={tone} title={title} actions={actions}>
        {detail}
      </Message>
      {children}
      {env && (
        <List>
          <EnvItem env={env} />
        </List>
      )}
      {note && <TechnicalDetails text={note} />}
    </Card>
  )
}

/** The drawer on the dev server's output: "output" while setting up, "logs" once the app runs. */
function LogsToggle({ open, noun }: { open: boolean; noun: 'output' | 'logs' }) {
  return (
    <Button
      variant="ghost"
      aria-expanded={open}
      onClick={() => (open ? gui.setDrawerOpen(false) : gui.showLogs())}
    >
      {open ? 'Hide' : 'Show'} {noun}
    </Button>
  )
}

function AppChooser({ apps }: { apps: WorkspaceApp[] }) {
  return (
    <SetupCard
      icon={<AppWindow className="size-4" aria-hidden="true" />}
      title="Which app should Gui preview?"
      detail={`This project has ${apps.length} apps. You can switch later from the project menu.`}
    >
      <List>
        {apps.map((app) => (
          <li key={app.dir}>
            <ListRow
              flush
              onClick={() => gui.chooseApp(app.dir)}
              title={app.name}
              detail={app.dir === '.' ? 'project root' : <PathText path={app.dir} />}
              trailing={CHEVRON}
            />
          </li>
        ))}
      </List>
    </SetupCard>
  )
}

type EnvSetup = NonNullable<ProjectSetup['env']>

const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** What to do about the env file: create it from the example, or fill it in. */
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
      Create <Code>{fileName(env.target)}</Code> from <Code>{fileName(env.example)}</Code>?
    </>
  )
}

function EnvButton({ env, size }: { env: EnvSetup; size?: 'sm' | 'md' }) {
  return env.created ? (
    <Button size={size} title={env.target} onClick={() => gui.openEnvFile()}>
      Open
    </Button>
  ) : (
    <Button size={size} title={env.target} onClick={() => gui.createEnvFile()}>
      Create
    </Button>
  )
}

/** The env file offer in a setup card. */
function EnvItem({ env }: { env: EnvSetup }) {
  return (
    <ListItem
      title="Environment variables"
      detail={<EnvText env={env} />}
      trailing={<EnvButton env={env} />}
    />
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
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-surface pr-1.5 pl-3">
      <KeyRound className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate text-small text-muted">
        This project uses environment variables. <EnvText env={env} />
      </p>
      <EnvButton env={env} size="sm" />
      <IconButton
        label="Dismiss"
        icon={X}
        size="sm"
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
      Press <Kbd>{shortcutText('selectElement')}</Kbd> and click any element in your app.
    </>,
  ],
  ['Describe the change', 'Your agent edits the code, and you see the result right away.'],
]

/**
 * The start screen: what Gui does, opening a project (or a recent one), and the agent that
 * will do the work. On the first run, the three steps instead of recent projects.
 */
function EmptyState({ state }: { state: WindowState }) {
  const recent = state.recent.slice(0, 6)
  const firstRun = recent.length === 0
  return (
    <div className="flex w-full max-w-md flex-col gap-8">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
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
      </div>

      {!firstRun && (
        <section aria-labelledby="recent-projects" className="flex flex-col gap-2">
          <GroupLabel id="recent-projects" as="h2">
            Recent
          </GroupLabel>
          <List>
            {recent.map((project) => (
              <li key={project.root}>
                <ListRow
                  flush
                  onClick={() => void gui.openRecent(project.root)}
                  title={project.name}
                  detail={<PathText path={project.root} home={state.home} />}
                  trailing={CHEVRON}
                />
              </li>
            ))}
          </List>
        </section>
      )}

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
    </div>
  )
}
