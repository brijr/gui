import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { StartForm } from '../../../shared/ipc'
import { FRAME_LABEL_HEIGHT } from '../../../shared/layout'
import {
  frameLabel,
  PROJECT_TEMPLATES,
  type ProjectInfo,
  type ProjectSetup,
  type ProjectTemplate,
  type ViewportFrame,
  type WindowState,
  type WorkspaceApp,
} from '../../../shared/types'
import { InstallProgress } from '../agents/agent-card'
import { AgentList } from '../agents/agent-list'
import { ConnectAgent, checkingAgents } from '../agents/connect-agent'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { TechnicalDetails } from '../lib/disclosure'
import { Field, InlineError, Input } from '../lib/field'
import { GitHubMark } from '../lib/github-mark'
import { GuiMark } from '../lib/gui-mark'
import {
  AppWindow,
  Archive,
  ChevronRight,
  Ellipsis,
  FolderOpen,
  FolderPlus,
  type IconComponent,
  Info,
  KeyRound,
  Package,
  Play,
  Shapes,
  TriangleAlert,
  Wrench,
  X,
} from '../lib/icons'
import { PathText } from '../lib/path-text'
import { Banner, Card, GroupLabel, List, ListItem, ListRow, Message } from '../lib/surface'
import { timeAgo } from '../lib/time'
import { Button, Code, IconButton, SegmentedControl, TIGHT_HIT_AREA } from '../lib/ui'
import { needsSignIn, useAccount } from '../lib/use-account'
import { useAction } from '../settings/use-action'
import { Board } from './board'
import { FixStartupButton } from './fix-startup'
import { GitHubRepositories, matchRepository, useGitHub } from './github-repositories'
import { useMorphDrawsFrame } from './layout-morph'
import { Rulers } from './rulers'
import { crashed, stoppedOutside } from './server-status'
import { SignIn } from './sign-in'
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: switching sides moves the canvas without resizing it.
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
  }, [state.sidebarSide])

  // A canvas: its board, or with a frame open, the frame live in the preview over this.
  if (state.board)
    return (
      <main ref={ref} className="relative min-h-0 flex-1 bg-canvas">
        {preview.frame && preview.visible && !state.shortcutsOpen && !morphing && (
          <DeviceFrame frame={preview.frame} />
        )}
        {state.board.open ? (
          preview.error && (
            <div className="absolute inset-0 flex items-center justify-center p-8">
              <Message
                icon={TriangleAlert}
                tone="danger"
                heading="This frame didn’t load"
                className="max-w-sm"
              >
                <span className="select-text">{preview.error.message}</span>
              </Message>
            </div>
          )
        ) : (
          <Board
            key={state.board.id}
            board={state.board}
            working={turnRunning(state)}
            gl={state.devBoardWebgl}
          />
        )}
      </main>
    )

  return (
    <main ref={ref} className="relative min-h-0 flex-1 bg-canvas">
      {/* Main hides the preview under the shortcuts sheet, and so its frame goes too. */}
      {preview.frame && preview.visible && !state.shortcutsOpen && !morphing && (
        <DeviceFrame frame={preview.frame} />
      )}
      {/* The column sits in the middle while it fits (its text still starts at the left);
          scrolls from the top in a short window. */}
      <div
        className={cn(
          'absolute inset-0 flex flex-col overflow-y-auto [scrollbar-gutter:stable_both-edges] p-8',
          !state.project && 'pt-20',
        )}
      >
        <div className="m-auto flex w-full justify-center">
          <CanvasMessage state={state} />
        </div>
      </div>
      {/* Over the message's scroller, which fills the canvas. Main sends them only while the
          app's page is on screen and at rest. */}
      <Rulers />
    </main>
  )
}

/**
 * The active tab's agent is mid-turn: working, or waiting on a permission card (which only a
 * running turn shows, and which the tab's status puts first).
 */
function turnRunning(state: WindowState) {
  const status = state.tabs.find((tab) => tab.id === state.activeTab)?.status
  return status === 'working' || status === 'attention'
}

/**
 * A fixed viewport's edge and shadow around the preview, which is the device's screen, and
 * its name above: "Laptop · 1440 × 900" (a canvas frame's own size: "1080 × 1080"), with the
 * scale when it's drawn smaller.
 */
function DeviceFrame({ frame }: { frame: ViewportFrame }) {
  const { name, detail } = frameLabel(frame.viewport, frame.scale)
  const { rect } = frame
  return (
    <>
      {/* The device sits on the canvas like a card rather than floating over it, so it takes
          the raised shadow; its strong edge is what sets the screen apart. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute border border-line-strong shadow-raised"
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

  if (setup?.node) return <NodeCard node={setup.node} />

  // Offered alongside whatever else the card says; the app may run without it.
  const env = setup?.env ?? null

  if (setup?.dependencies === 'installing') {
    return (
      <SetupCard
        icon="loading"
        heading="Installing dependencies…"
        detail="The first install can take a few minutes."
        actions={<LogsToggle open={logsOpen} />}
        env={env}
      />
    )
  }

  if (setup?.dependencies === 'failed') {
    return (
      <SetupCard
        icon={TriangleAlert}
        tone="danger"
        heading="Couldn’t install dependencies"
        note={devServer.lastLine}
        actions={
          <>
            <FixStartupButton agentId={state.agentId} />
            <Button onClick={() => gui.installDependencies()}>Try again</Button>
            <LogsToggle open={logsOpen} />
          </>
        }
        env={env}
      />
    )
  }

  // Ahead of a load error: with its server gone the page can't load, and starting it is the fix.
  if (devServer.status === 'exited') {
    const failed = crashed(state)
    return (
      <SetupCard
        icon={failed ? TriangleAlert : Info}
        tone={failed ? 'danger' : 'neutral'}
        heading="Your app stopped"
        detail={
          failed
            ? 'It quit with an error.'
            : stoppedOutside(state)
              ? 'Something outside Gui stopped it.'
              : 'It quit on its own, without an error. Restart it to see your changes.'
        }
        note={
          devServer.lastLine ||
          (devServer.exitCode === null ? undefined : `Exit code ${devServer.exitCode}`)
        }
        actions={
          failed ? (
            <>
              <FixStartupButton agentId={state.agentId} />
              <Button onClick={() => gui.restartDevServer()}>Restart</Button>
              <LogsToggle open={logsOpen} />
            </>
          ) : (
            <>
              <Button variant="primary" onClick={() => gui.restartDevServer()}>
                Restart
              </Button>
              <LogsToggle open={logsOpen} />
            </>
          )
        }
        env={env}
        start={project}
      />
    )
  }

  if (preview.error) {
    return (
      <SetupCard
        icon={TriangleAlert}
        tone="danger"
        heading="Your app couldn’t load"
        detail={preview.error.message}
        note={preview.error.detail}
        actions={
          <>
            <Button variant="primary" onClick={() => gui.reload()}>
              Try again
            </Button>
            <FixStartupButton agentId={state.agentId} variant="secondary" />
            <LogsToggle open={logsOpen} />
          </>
        }
        env={env}
        start={project}
      />
    )
  }

  if (devServer.status === 'starting' && devServer.slow) {
    return (
      <SetupCard
        icon="loading"
        heading="Your app is taking a while to start"
        detail="No address yet. If your app is running, enter its address."
        note={devServer.lastLine}
        actions={
          <>
            <FixStartupButton agentId={state.agentId} variant="secondary" />
            <LogsToggle open={logsOpen} />
            <Button variant="ghost" onClick={() => focusAddressBar()}>
              Enter address
            </Button>
          </>
        }
        env={env}
        start={project}
      />
    )
  }

  if (devServer.status === 'starting' || (devServer.status === 'running' && !preview.visible)) {
    return (
      <SetupCard
        icon="loading"
        heading={devServer.status === 'starting' ? 'Starting your app…' : 'Loading your app…'}
        note={devServer.lastLine || devServer.command || ''}
        env={env}
      />
    )
  }

  if (!project.devCommand && !preview.url) {
    // A `start` that serves a production build (`next start`) needs a build, and doesn't
    // update as the agent edits: Gui passed it over, and says so.
    const production = project.productionScript
    return (
      <SetupCard
        icon={Info}
        heading={production ? 'Your app has no dev script' : 'Start building your app'}
        detail={
          production
            ? `Its “${production}” script runs a production build, which doesn’t update as you edit. Ask your agent to add a “dev” script, or set a dev server command.`
            : 'Describe your app in chat. Gui will preview it when it’s ready.'
        }
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
        start={project}
      />
    )
  }

  // Not installed yet, and the user hasn't agreed to run anything (or said "Not now").
  // The button asks first unless the project is already trusted.
  if (setup?.dependencies === 'missing' && devServer.status === 'idle') {
    return (
      <SetupCard
        icon={Package}
        heading="Install this project’s dependencies"
        detail="Gui will install its dependencies and start it, which runs the project’s own scripts."
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
        icon={Play}
        heading="Your app isn’t running"
        note={project.devCommand ?? ''}
        actions={
          <Button variant="primary" onClick={() => gui.startDevServer()}>
            Start dev server
          </Button>
        }
        env={env}
        start={project}
      />
    )
  }

  return null
}

/**
 * The project needs Node.js and the Mac has none: Gui downloads its own, then installs and
 * starts the project as usual. Nothing outside Gui changes.
 */
function NodeCard({ node }: { node: NonNullable<ProjectSetup['node']> }) {
  if (node.status === 'installing' || node.status === 'ready') {
    return (
      <SetupCard
        icon="loading"
        heading="Setting up Node.js…"
        detail="Your app starts as soon as it’s ready."
      >
        <InstallProgress name="Node.js" progress={node.progress} />
      </SetupCard>
    )
  }
  if (node.status === 'failed') {
    return (
      <SetupCard
        icon={TriangleAlert}
        tone="danger"
        heading="Couldn’t set up Node.js"
        detail={node.error ?? 'The download stopped with an error.'}
        note="You can also install Node.js yourself from nodejs.org. Gui uses yours when it finds it."
        actions={
          <Button variant="primary" onClick={() => gui.installNode()}>
            Try again
          </Button>
        }
      />
    )
  }
  return (
    <SetupCard
      icon={Package}
      heading="Your app needs Node.js"
      detail="Gui runs your app with Node.js, and your agent uses it to build. Gui can set it up for you: a one-time download of about 30 MB that stays inside Gui."
      actions={
        <Button variant="primary" onClick={() => gui.installNode()}>
          Set up Node.js
        </Button>
      }
    />
  )
}

interface SetupCardProps {
  icon: IconComponent | 'loading'
  tone?: 'neutral' | 'danger'
  heading: string
  /** Plain explanation */
  detail?: string
  /** The specifics (command, last output line), behind a Details toggle for people who want them */
  note?: string
  actions?: ReactNode
  /** What there is to choose from, as a List under the message */
  children?: ReactNode
  /** The env file to offer, as a row of its own */
  env?: EnvSetup | null
  /** The project whose start command to show, with a way to change it, as a row of its own */
  start?: ProjectInfo
}

/**
 * A canvas state: the shared Message in a card, then what there is to choose or set up as
 * List rows (apps, the env file), then the technical details.
 */
function SetupCard({
  icon,
  tone,
  heading,
  detail,
  note,
  actions,
  children,
  env,
  start,
}: SetupCardProps) {
  return (
    <Card padding="canvas" className="flex w-full max-w-sm flex-col gap-4">
      <Message icon={icon} tone={tone} heading={heading} actions={actions}>
        {detail}
      </Message>
      {children}
      <SetupRows env={env ?? null} start={start ?? null} />
      {note && <TechnicalDetails text={note} />}
    </Card>
  )
}

/** The env file and the start command, as List rows; changing the command takes their place. */
function SetupRows({ env, start }: { env: EnvSetup | null; start: ProjectInfo | null }) {
  const [editing, setEditing] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const finish = () => {
    setEditing(false)
    requestAnimationFrame(() => trigger.current?.focus())
  }
  if (editing && start) return <StartCommandForm project={start} onDone={finish} />
  if (!env && !start) return null
  return (
    <List>
      {env && <EnvItem env={env} />}
      {start && (
        <ListItem
          heading={start.custom ? 'Dev server command (set in Gui)' : 'Dev server command'}
          detail={
            start.devCommand ? (
              <span className="block truncate font-mono text-caption" title={start.devCommand}>
                {start.devCommand}
              </span>
            ) : (
              'None found'
            )
          }
          trailing={
            <Button ref={trigger} onClick={() => setEditing(true)}>
              {start.devCommand ? 'Change' : 'Set'}
            </Button>
          }
        />
      )}
    </List>
  )
}

const START_FIELDS = { command: 'start-command', dir: 'start-dir', url: 'start-url' }

/**
 * How Gui starts the app, when what it found isn't right: a command (any, not only a
 * package.json script), the folder it runs in, and the address for a server that doesn't
 * print one. Saving starts the app with it, and Gui uses it whenever the project opens.
 */
function StartCommandForm({ project, onDone }: { project: ProjectInfo; onDone: () => void }) {
  const [command, setCommand] = useState(project.devCommand ?? '')
  const [dir, setDir] = useState(project.appDir ?? '')
  const [url, setUrl] = useState(project.custom?.url ?? '')
  const save = useAction()
  const apply = (start: Parameters<typeof gui.setStartCommand>[0]) =>
    save.run(async () => {
      await gui.setStartCommand(start)
      onDone()
    })
  const field = {
    mono: true,
    spellCheck: false,
    autoCapitalize: 'off',
    autoCorrect: 'off',
    readOnly: save.pending,
  } as const
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (command.trim() && !save.pending) void apply({ command, dir, url })
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !save.pending) onDone()
      }}
    >
      <Field
        label="Dev server command"
        htmlFor={START_FIELDS.command}
        hint="Runs in your shell, like a script in package.json."
      >
        <Input
          {...field}
          id={START_FIELDS.command}
          autoFocus
          placeholder="npm run dev"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
        />
      </Field>
      <Field
        label="Folder"
        htmlFor={START_FIELDS.dir}
        hint="In the project. Empty for its root."
        error={save.error?.includes("isn't a folder") ? save.error : undefined}
      >
        <Input
          {...field}
          id={START_FIELDS.dir}
          placeholder="apps/web"
          value={dir}
          onChange={(event) => setDir(event.target.value)}
        />
      </Field>
      <Field
        label="Address"
        htmlFor={START_FIELDS.url}
        hint="Only if your app doesn’t print its address."
        error={save.error?.includes('address must') ? save.error : undefined}
      >
        <Input
          {...field}
          id={START_FIELDS.url}
          placeholder="http://localhost:3000"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </Field>
      {save.error && !/isn't a folder|address must/.test(save.error) && (
        <InlineError>{save.error}</InlineError>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" loading={save.pending} disabled={!command.trim()}>
          Save and start
        </Button>
        <Button variant="ghost" disabled={save.pending} onClick={onDone}>
          Cancel
        </Button>
        {project.custom && (
          <Button variant="ghost" disabled={save.pending} onClick={() => void apply(null)}>
            Use detected
          </Button>
        )}
      </div>
    </form>
  )
}

/** The drawer on the dev server's logs. */
function LogsToggle({ open }: { open: boolean }) {
  return (
    <Button
      variant="ghost"
      aria-expanded={open}
      onClick={() => (open ? gui.setDrawerOpen(false) : gui.showLogs())}
    >
      {open ? 'Hide logs' : 'Show logs'}
    </Button>
  )
}

function AppChooser({ apps }: { apps: WorkspaceApp[] }) {
  return (
    <SetupCard
      icon={AppWindow}
      heading="Which app should Gui preview?"
      detail={`This project has ${apps.length} apps. You can switch later from the project menu.`}
    >
      <List>
        {apps.map((app) => (
          <li key={app.dir}>
            <ListRow
              flush
              onClick={() => gui.chooseApp(app.dir)}
              heading={app.name}
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
      heading="Environment variables"
      detail={<EnvText env={env} />}
      trailing={<EnvButton env={env} />}
    />
  )
}

/**
 * Git can't run here until Apple's developer tools are installed, and undo and sharing need
 * it. Gui offers macOS's own installer and picks the tools up when the user comes back.
 */
export function DeveloperToolsBanner({ state }: { state: WindowState }) {
  if (!state.project || !state.developerTools) return null
  if (state.developerTools === 'installing') {
    return (
      <Banner
        icon={Wrench}
        actions={
          <Button size="sm" variant="ghost" onClick={() => gui.installDeveloperTools()}>
            Open installer
          </Button>
        }
      >
        <span className="text-pretty">
          Finish installing Apple’s developer tools in the macOS window.
        </span>
      </Banner>
    )
  }
  return (
    <Banner
      icon={Wrench}
      tone="warning"
      actions={
        <Button size="sm" onClick={() => gui.installDeveloperTools()}>
          Install
        </Button>
      }
    >
      <span className="text-pretty">Undo needs Apple’s free developer tools.</span>
    </Banner>
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
    <Banner
      icon={KeyRound}
      actions={
        <>
          <EnvButton env={env} size="sm" />
          <IconButton
            className={TIGHT_HIT_AREA}
            label="Dismiss"
            icon={X}
            size="sm"
            onClick={() => {
              dismissedEnv.add(root)
              setDismissed(true)
            }}
          />
        </>
      }
    >
      <span className="text-pretty">
        This project uses environment variables. <EnvText env={env} />
      </span>
    </Banner>
  )
}

/** The start screen's one field, whichever it's asking for. */
const FORM_FIELD = 'start-project-value'

/** What each of the start screen's fields asks for, and what its button does. */
const FORMS: Record<
  StartForm,
  { label: string; placeholder: string; hint: string; submit: string; busy: string; mono: boolean }
> = {
  newProject: {
    label: 'Project name',
    placeholder: 'my-app',
    // Said per template instead (TEMPLATE_HINTS)
    hint: '',
    submit: 'Create…',
    busy: 'Creating…',
    mono: false,
  },
  cloneRepo: {
    label: 'GitHub repository',
    placeholder: 'owner/repo or github.com/owner/repo',
    hint: 'Copy a GitHub repository to your Mac by its name or address. You choose where to save it next.',
    submit: 'Clone…',
    busy: 'Cloning…',
    mono: true,
  },
}

/** What a new project starts as, under its name field. */
const TEMPLATE_HINTS: Record<ProjectTemplate, string> = {
  website:
    'Starts as a simple landing page, ready to make your own. You choose where to save it next.',
  dashboard: 'Starts as an app dashboard with sample data. You choose where to save it next.',
  blank:
    'An empty folder: ask your agent to build your app from scratch. You choose where to save it next.',
}

const TEMPLATE_SEGMENTS = PROJECT_TEMPLATES.map(({ id, name }) => ({ value: id, label: name }))

/**
 * ⇧⌘N, ⇧⌘O and the menus' New Project… and Clone…: main shows a start screen and
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
 * The ways in: Open project, the one primary, then an even row of New project, New canvas and
 * Clone. New project and Clone swap the buttons for a name or repository field (Clone lists
 * the user's GitHub repositories above it, or offers to connect GitHub); main asks where to
 * put the folder, then opens it like any project.
 */
function OpenActions({ firstRun, connect }: { firstRun: boolean; connect: boolean }) {
  const [form, setForm] = useState<StartForm | null>(null)
  const github = useGitHub(form === 'cloneRepo')
  const [template, setTemplate] = useState<ProjectTemplate>('website')
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

  if (!form) {
    // One primary across the top, then the other ways in as equal cells, labels at the start,
    // so the buttons line up with the list under them.
    const cell = 'w-full justify-start'
    return (
      <div className="flex flex-col gap-2">
        <Button
          variant={connect ? 'secondary' : 'primary'}
          size="lg"
          icon={firstRun ? FolderPlus : FolderOpen}
          className={cell}
          onClick={() => (firstRun ? setForm('newProject') : void gui.openProject())}
        >
          {firstRun ? 'New project…' : 'Open project…'}
        </Button>
        <div className="grid grid-cols-3 gap-2">
          <Button
            icon={firstRun ? FolderOpen : FolderPlus}
            className={cell}
            title={
              firstRun
                ? 'Choose a project folder already on your Mac'
                : 'Start a new website or app'
            }
            onClick={() => (firstRun ? void gui.openProject() : setForm('newProject'))}
          >
            {firstRun ? 'Open project…' : 'New project…'}
          </Button>
          {/* No folder, install or server: a canvas to design on with the agent, open at once. */}
          <Button
            icon={Shapes}
            className={cell}
            title="Design on a canvas without a project folder"
            shortcut="newBoard"
            onClick={() => gui.newBoard()}
          >
            New canvas
          </Button>
          <Button
            icon={GitHubMark}
            className={cell}
            title="Copy a GitHub repository to your Mac"
            onClick={() => setForm('cloneRepo')}
          >
            Clone…
          </Button>
        </div>
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
      const repository = form === 'cloneRepo' ? matchRepository(value, github.state) : null
      // One of the user's own repositories goes through GitHub's access, private ones included.
      await (form === 'newProject'
        ? gui.newProject(value, template)
        : repository
          ? gui.cloneGitHub(repository.id)
          : gui.cloneProject(value))
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) {
          event.preventDefault()
          close()
        }
      }}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {form === 'newProject' && (
        <div className="flex flex-col gap-1">
          <p id="start-template-label" className="text-small font-medium text-muted">
            Start from
          </p>
          <SegmentedControl
            segments={TEMPLATE_SEGMENTS}
            value={template}
            onChange={setTemplate}
            aria-labelledby="start-template-label"
            stretch
          />
        </div>
      )}
      <Field
        label={spec.label}
        htmlFor={FORM_FIELD}
        hint={form === 'newProject' ? TEMPLATE_HINTS[template] : spec.hint}
        error={error}
      >
        <div className="flex gap-2">
          <Input
            // Remounted per field, so autoFocus applies to each.
            key={form}
            id={FORM_FIELD}
            ref={input}
            autoFocus
            mono={spec.mono}
            placeholder={spec.placeholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={value}
            readOnly={busy}
            onChange={(event) => {
              setValue(event.target.value)
              setError(null)
            }}
          />
          <Button type="submit" variant="primary" loading={busy} disabled={!value.trim()}>
            {spec.submit}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={close}>
            Cancel
          </Button>
        </div>
      </Field>
      {/* Under the field that filters it, so typing (or the list arriving) never moves the field. */}
      {form === 'cloneRepo' && (
        <GitHubRepositories
          github={github}
          filter={value}
          disabled={busy}
          onClone={async (id) => {
            if (busy) return
            setBusy(true)
            setError(null)
            try {
              await gui.cloneGitHub(id)
            } finally {
              setBusy(false)
            }
          }}
        />
      )}
    </form>
  )
}

/**
 * The start screen: what Gui does, opening a project (or a recent one), and the agent that
 * will do the work, and once there are any, recent chats and projects.
 */
function EmptyState({ state }: { state: WindowState }) {
  const account = useAccount()
  // Gui needs an account before anything else; projects asked for meanwhile open after.
  if (!account) return null
  if (needsSignIn(account)) return <SignIn />
  return <StartScreen state={state} />
}

function StartScreen({ state }: { state: WindowState }) {
  const [otherAgents, setOtherAgents] = useState(false)
  // Once offered, connecting stays up through its own checks until an agent works.
  const [connecting, setConnecting] = useState(false)
  const anyReady = state.agents.some((agent) => agent.enabled && agent.status === 'ready')
  const connect =
    !anyReady && (connecting || !checkingAgents(state.agents, state.agentId)) && !otherAgents
  useEffect(() => {
    if (connect) setConnecting(true)
  }, [connect])
  // Until the recent list is read: drawn without it, the screen would jump once it came.
  if (!state.recent) return null
  // A project with a chat shows under Recent chats, by its last message; the rest by name.
  const chats = state.recent
    .flatMap((project) => (project.chat ? [{ ...project, chat: project.chat }] : []))
    .sort((a, b) => b.chat.at - a.chat.at)
    .slice(0, 5)
  const projects = state.recent.filter((project) => !project.chat).slice(0, 5)
  const boards = (state.recentBoards ?? []).slice(0, 5)
  const firstRun = state.recent.length === 0 && boards.length === 0
  return (
    <div className="flex w-full max-w-md flex-col gap-8">
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <GuiMark className="mb-4" />
          {firstRun && (
            <h1 className="text-title font-semibold">Design your app with your own agents</h1>
          )}
        </div>
        {/* Nothing works without an agent, so setting one up comes before opening a project */}
        {connect && (
          <ConnectAgent
            agents={state.agents}
            agentId={state.agentId}
            onOtherAgents={() => setOtherAgents(true)}
          />
        )}
        <OpenActions firstRun={firstRun} connect={connect} />
      </div>

      {chats.length > 0 && (
        <section aria-labelledby="recent-chats" className="flex flex-col gap-2">
          <GroupLabel id="recent-chats" as="h2" tabIndex={-1}>
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

      {boards.length > 0 && (
        <section aria-labelledby="recent-canvases" className="flex flex-col gap-2">
          <GroupLabel id="recent-canvases" as="h2">
            Recent canvases
          </GroupLabel>
          <List>
            {boards.map((board) => (
              <li key={board.id}>
                <div className="group relative">
                  <ListRow
                    flush
                    onClick={() => gui.openBoard(board.id)}
                    heading={board.name}
                    detail={`${board.frames === 1 ? '1 frame' : `${board.frames} frames`} · ${timeAgo(board.editedAt)}`}
                    trailing={
                      <span className="transition-opacity duration-(--motion-pop) motion-reduce:duration-(--motion-fade) group-focus-within:opacity-0 group-hover:opacity-0">
                        {CHEVRON}
                      </span>
                    }
                  />
                  <IconButton
                    label={`More for ${board.name}`}
                    icon={Ellipsis}
                    size="sm"
                    aria-haspopup="menu"
                    onClick={() => gui.showRecentBoardMenu(board.id)}
                    className="absolute top-1/2 right-1.5 -translate-y-1/2 opacity-0 before:absolute before:-inset-2 before:no-drag duration-(--motion-pop) motion-reduce:duration-(--motion-fade) group-focus-within:opacity-100 group-hover:opacity-100"
                  />
                </div>
              </li>
            ))}
          </List>
        </section>
      )}

      {projects.length > 0 && (
        <section aria-labelledby="recent-projects" className="flex flex-col gap-2">
          <GroupLabel id="recent-projects" as="h2" tabIndex={-1}>
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

      {/* While connecting is offered, it's the one way to set an agent up */}
      {!connect && <AgentList agents={state.agents} agentId={state.agentId} />}
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
  const row = useRef<HTMLLIElement>(null)
  const removeRow = (action: () => Promise<unknown>) =>
    remove.run(async () => {
      const element = row.current
      const neighbor = element?.nextElementSibling ?? element?.previousElementSibling
      const target =
        neighbor?.querySelector<HTMLElement>('button') ??
        element?.closest('section')?.querySelector<HTMLElement>('h2')
      await action()
      requestAnimationFrame(() => {
        const fallback =
          document.querySelector<HTMLElement>('#recent-projects, #recent-chats') ??
          document.querySelector<HTMLElement>('button:not(:disabled)')
        ;(target?.isConnected ? target : fallback)?.focus({ preventScroll: true })
      })
    })
  return (
    <li ref={row}>
      {/* One action per row, opening it: removing it shows only under the pointer or the
          keyboard, in place of the chevron, so the row's fill runs under both. */}
      <div className="group relative">
        <ListRow
          flush
          onClick={() => void gui.openRecent(root)}
          disabled={remove.pending}
          heading={title}
          detail={detail}
          trailing={
            <span className="transition-opacity duration-(--motion-pop) motion-reduce:duration-(--motion-fade) group-focus-within:opacity-0 group-hover:opacity-0">
              {CHEVRON}
            </span>
          }
        />
        {/* A chat goes to its project's archive, and the project shows under recent ones. */}
        <IconButton
          {...(kind === 'chat'
            ? {
                label: `Archive chat: ${title}`,
                title: 'Archive chat',
                icon: Archive,
                onClick: () => void removeRow(() => gui.archiveRecentChat(root)),
              }
            : {
                label: `Remove recent project: ${title}`,
                title: 'Remove from recents',
                icon: X,
                onClick: () => void removeRow(() => gui.removeRecent(root)),
              })}
          size="sm"
          aria-disabled={remove.pending}
          className="absolute top-1/2 right-1.5 -translate-y-1/2 opacity-0 before:absolute before:-inset-2 before:no-drag duration-(--motion-pop) motion-reduce:duration-(--motion-fade) group-focus-within:opacity-100 group-hover:opacity-100"
        />
      </div>
      {remove.error && <InlineError className="px-3 pb-2">{remove.error}</InlineError>}
    </li>
  )
}
