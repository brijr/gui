import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { StartForm } from '../../../shared/ipc'
import { FRAME_LABEL_HEIGHT } from '../../../shared/layout'
import {
  frameLabel,
  type ProjectSetup,
  type ViewportFrame,
  type WindowState,
  type WorkspaceApp,
} from '../../../shared/types'
import { AgentList } from '../agents/agent-list'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { TechnicalDetails } from '../lib/disclosure'
import { Input } from '../lib/field'
import { GuiMark } from '../lib/gui-mark'
import {
  AppWindow,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  Info,
  KeyRound,
  Package,
  Play,
  TriangleAlert,
  X,
} from '../lib/icons'
import { PathText } from '../lib/path-text'
import { Card, GroupLabel, List, ListItem, ListRow, Message } from '../lib/surface'
import { Button, Code, IconButton, Spinner } from '../lib/ui'
import { useAction } from '../settings/use-action'
import { GitHubProjects } from './github-projects'
import { useMorphDrawsFrame } from './layout-morph'
import { focusAddressBar } from './toolbar'

/**
 * The preview is a native view layered over this element; we report our bounds so
 * main can position it. What we render here only shows around it, or while it's hidden.
 */
export function Canvas({ state }: { state: WindowState }) {
  const { preview } = state
  const ref = useRef<HTMLElement>(null)
  // Mid-morph the frame moves with the preview's snapshot, which draws it (layout-morph.ts).
  const morphing = useMorphDrawsFrame()

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
      {/* Main hides the preview under the shortcuts sheet, and so its frame goes too. */}
      {preview.frame && preview.visible && !state.shortcutsOpen && !morphing && (
        <DeviceFrame frame={preview.frame} />
      )}
      {/* Centered while it fits; scrolls from the top in a short window. */}
      <div
        className={cn(
          'absolute inset-0 flex flex-col overflow-y-auto scroll-stable p-8',
          !state.project && 'pt-20',
        )}
      >
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
function DeviceFrame({ frame }: { frame: ViewportFrame }) {
  const { name, detail } = frameLabel(frame.viewport, frame.scale)
  const { rect } = frame
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
          {detail}
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
        title="Nothing to start yet"
        detail="Ask your agent to build the app, or add a “dev” script to package.json. Gui starts it as soon as there's one. Or enter your app's address in the bar above."
        actions={
          <>
            <Button variant="primary" onClick={() => gui.expandChat()}>
              Open chat
            </Button>
            <Button variant="ghost" onClick={() => focusAddressBar()}>
              Enter address
            </Button>
          </>
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

/** GitHub's mark, which lucide doesn't draw; sized like a button's icon. */
function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="size-3.5 shrink-0" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

/** What each of the start screen's fields asks for, and what its button does. */
const FORMS: Record<
  StartForm,
  { label: string; placeholder: string; hint: string; submit: string; busy: string; mono: boolean }
> = {
  newProject: {
    label: 'Project name',
    placeholder: 'my-app',
    hint: 'Create a local folder, then ask your agent to build your app. You choose where to save it next.',
    submit: 'Create…',
    busy: 'Creating…',
    mono: false,
  },
  cloneRepo: {
    label: 'GitHub repo',
    placeholder: 'owner/repo or github.com/owner/repo',
    hint: 'Copy a GitHub repository to your Mac. You choose where to save it next.',
    submit: 'Clone…',
    busy: 'Cloning…',
    mono: true,
  },
}

/**
 * ⇧⌘N, ⇧⌘O and the menus' New Project and Clone from GitHub: main shows a start screen and
 * asks for a field, which may not be drawn yet (a new tab or window), so the ask waits here.
 */
let askedForm: StartForm | null = null
const formListeners = new Set<() => void>()
gui.onCommand((command) => {
  if (command !== 'newProject' && command !== 'cloneRepo') return
  askedForm = command
  for (const listener of formListeners) listener()
})

/**
 * Open project, and beside it New project and Clone from GitHub, which swap the buttons for
 * a name or repo field. Main asks where to put the folder, then opens it like any project.
 */
function OpenActions() {
  const [form, setForm] = useState<StartForm | null>(null)
  const [github, setGithub] = useState(false)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  // The field showing, for the listener below, which only sees its first render's state.
  const shown = useRef(form)
  shown.current = form

  useEffect(() => {
    const take = () => {
      if (!askedForm) return
      const asked = askedForm
      askedForm = null
      if (shown.current !== asked) {
        setValue('')
        setError(null)
      }
      setForm(asked)
      // Already open: focus it again, since autoFocus only applies when it's drawn.
      input.current?.focus()
    }
    formListeners.add(take)
    take()
    return () => {
      formListeners.delete(take)
    }
  }, [])

  if (github)
    return <GitHubProjects onClose={() => setGithub(false)} onOpened={() => setGithub(false)} />

  if (!form) {
    return (
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          size="lg"
          icon={FolderOpen}
          onClick={() => void gui.openProject()}
        >
          Open project…
        </Button>
        <Button size="lg" icon={FolderPlus} onClick={() => setForm('newProject')}>
          New project
        </Button>
        <Button size="lg" onClick={() => setGithub(true)}>
          <GitHubMark />
          Connect GitHub projects
        </Button>
        <Button size="lg" onClick={() => setForm('cloneRepo')}>
          Clone by URL
        </Button>
      </div>
    )
  }

  const spec = FORMS[form]
  const close = () => {
    setForm(null)
    setValue('')
    setError(null)
  }
  const submit = async () => {
    if (!value.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await (form === 'newProject' ? gui.newProject(value) : gui.cloneProject(value))
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <label htmlFor="start-project-value" className="text-small font-medium text-muted">
        {spec.label}
      </label>
      <div className="flex gap-2">
        <Input
          // Remounted per field, so autoFocus applies to each.
          key={form}
          id="start-project-value"
          ref={input}
          autoFocus
          mono={spec.mono}
          className="h-8"
          aria-label={spec.label}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? 'start-form-hint start-form-error' : 'start-form-hint'}
          placeholder={spec.placeholder}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          value={value}
          disabled={busy}
          onChange={(event) => {
            setValue(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !busy) close()
          }}
        />
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!value.trim()}>
          {busy ? spec.busy : spec.submit}
        </Button>
        <Button size="lg" disabled={busy} onClick={close}>
          Cancel
        </Button>
      </div>
      <p id="start-form-hint" className="text-pretty text-small text-muted">
        {spec.hint}
      </p>
      {error && (
        <p id="start-form-error" role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
    </form>
  )
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

/** "5 minutes ago", "yesterday": when a recent chat's last message was sent. */
function timeAgo(at: number) {
  const seconds = (Date.now() - at) / 1000
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return RELATIVE.format(-Math.floor(seconds / size), unit)
  }
  return 'just now'
}

/**
 * The start screen: what Gui does, opening a project (or a recent one), and the agent that
 * will do the work, and once there are any, recent chats and projects.
 */
function EmptyState({ state }: { state: WindowState }) {
  // Until the recent list is read: drawn without it, the screen would jump once it came.
  if (!state.recent) return null
  // A project with a chat shows under Recent chats, by its last message; the rest by name.
  const chats = state.recent
    .flatMap((project) => (project.chat ? [{ ...project, chat: project.chat }] : []))
    .sort((a, b) => b.chat.at - a.chat.at)
    .slice(0, 5)
  const projects = state.recent.filter((project) => !project.chat).slice(0, 5)
  const firstRun = state.recent.length === 0
  return (
    <div className="flex w-full max-w-md flex-col gap-8">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <GuiMark className="mb-4" />
          <h1 className="text-title font-semibold">
            {firstRun ? 'Design your app with your own agents' : 'Open a project'}
          </h1>
          <p className="text-pretty text-muted">
            Gui runs your app, shows it here, and lets your agent edit the real code while you point
            at things.
          </p>
        </div>
        <OpenActions />
      </div>

      {chats.length > 0 && (
        <section aria-labelledby="recent-chats" className="flex flex-col gap-2">
          <GroupLabel id="recent-chats" as="h2">
            Recent chats
          </GroupLabel>
          <List>
            {chats.map((project) => (
              <RecentRow
                key={project.root}
                root={project.root}
                kind="chat"
                title={project.chat.prompt}
                detail={
                  <span title={project.root}>
                    {project.name} · {timeAgo(project.chat.at)}
                  </span>
                }
              />
            ))}
          </List>
        </section>
      )}

      {projects.length > 0 && (
        <section aria-labelledby="recent-projects" className="flex flex-col gap-2">
          <GroupLabel id="recent-projects" as="h2">
            {chats.length > 0 ? 'Recent projects' : 'Recent'}
          </GroupLabel>
          <List>
            {projects.map((project) => (
              <RecentRow
                key={project.root}
                root={project.root}
                kind="project"
                title={project.name}
                detail={<PathText path={project.root} home={state.home} />}
              />
            ))}
          </List>
        </section>
      )}

      <AgentList agents={state.agents} agentId={state.agentId} />
    </div>
  )
}

function RecentRow({
  root,
  kind,
  title,
  detail,
}: {
  root: string
  kind: 'chat' | 'project'
  title: string
  detail: ReactNode
}) {
  const remove = useAction()
  return (
    <li>
      <div className="flex items-center pr-3">
        <ListRow
          flush
          onClick={() => void gui.openRecent(root)}
          disabled={remove.pending}
          title={title}
          detail={detail}
          trailing={CHEVRON}
        />
        <IconButton
          label={`Remove recent ${kind}: ${title}`}
          title="Remove from recents"
          icon={X}
          disabled={remove.pending}
          onClick={() => void remove.run(() => gui.removeRecent(root))}
        />
      </div>
      {remove.error && (
        <p role="alert" className="px-3 pb-2 text-small text-danger">
          {remove.error}
        </p>
      )}
    </li>
  )
}
