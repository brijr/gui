import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import {
  app,
  BrowserWindow,
  ClipboardItem,
  clipboard,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
  type NativeImage,
  nativeImage,
  nativeTheme,
  shell,
  type WebContents,
  WebContentsView,
  type WebFrameMain,
} from 'electron'
import { Events } from '../shared/ipc'
import {
  type AgentId,
  agentName,
  type ChatSnapshot,
  type DevServerState,
  type ImageAttachment,
  type PreviewState,
  type ProjectInfo,
  type ProjectSetup,
  type RecentProject,
  type Rect,
  type ShipInfo,
  type ShipRequest,
  type ShipResult,
  type Viewport,
  type WindowState,
  type WorkspaceApp,
} from '../shared/types'
import { agentHealth } from './agent-status'
import { agentMenuItems } from './agents'
import { ChatController } from './chat'
import { Checkpoints } from './checkpoints'
import { DevServer } from './dev-server'
import { historyFile, loadHistory } from './history'
import { Inspector } from './inspector'
import { isLoopback } from './loopback'
import { type RunningMcpServer, startMcpServer } from './mcp-server'
import { type ChatSize, getPrefs, setPrefs } from './prefs'
import { PreviewTools } from './preview-tools'
import { Problems } from './problems'
import { detectProject, readPackageJson } from './project'
import { addRecent, loadRecent } from './recent'
import { guardAppContents, loadRenderer, PRELOAD } from './renderer'
import {
  createEnvFile,
  detectEnv,
  detectSetup,
  envFile,
  installCommand,
  missingPackageManager,
  settleSetup,
} from './setup'
import { getShellEnv } from './shell-env'
import { ship, shipInfo } from './ship'
import { PREVIEW_PARTITION } from './storage'
import { thumbnail } from './thumbnail'
import { askToTrust, isTrusted, promptName, promptText } from './trust'

const TOOLBAR_HEIGHT = 44
const PANEL_MIN = { width: 320, height: 360 }
/** Space the floating panel's size leaves around it in the window. */
const PANEL_MARGIN = 12
const MINI = { width: 248, height: 52 }
const DOCK_MIN_WIDTH = 320
/** The docked panel leaves the preview at least the rest of the canvas. */
const DOCK_MAX_SHARE = 0.6
/** A screenshot attached to the chat, sized like the composer's images (images.ts). */
const ATTACH_EDGE = 1568
const ATTACH_THUMBNAIL_EDGE = 160
const ATTACH_MAX_PNG_BYTES = 3 * 1024 * 1024
/** Wait for hot reload to apply before re-finding the element a turn edited. */
const REHIGHLIGHT_DELAY_MS = 900
/** Transparent margin around the floating panel so its shadow isn't clipped. */
const SHADOW = 18
const VIEWPORT_WIDTH: Record<Viewport, number> = { desktop: 0, tablet: 820, mobile: 390 }
/** Package scripts an install runs from the project's own package.json. */
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

const windows = new Set<ProjectWindow>()

type ScreenshotAction = 'copy' | 'copy-full-page' | 'save' | 'attach'
type ScreenshotResult = 'copied' | 'saved' | 'attached'

export function findWindow(sender: WebContents) {
  for (const win of windows) if (win.owns(sender)) return win
  return undefined
}

export function focusedWindow() {
  const focused = BrowserWindow.getFocusedWindow()
  for (const win of windows) if (win.win === focused) return win
  return undefined
}

export function allWindows() {
  return [...windows]
}

const idleDevServer = (): DevServerState => ({
  status: 'idle',
  command: null,
  url: null,
  exitCode: null,
  lastLine: '',
  slow: false,
})

export class ProjectWindow {
  readonly win: BrowserWindow
  private readonly preview: WebContentsView
  private readonly chatView: WebContentsView
  private readonly inspector: Inspector
  private state: WindowState
  private devServer: DevServer | null = null
  private chat: ChatController | null = null
  private mcp: RunningMcpServer | null = null
  /** The current project's preview tools; also used to show how a change turned out. */
  private previewTools: PreviewTools | null = null
  private readonly problems = new Problems()
  /** Selection shown in the chat last time meta changed, to clear the highlight only when it goes away. */
  private shownSelectionId: string | null = null
  private canvas: Rect = { x: 0, y: 0, width: 0, height: 0 }
  /** Panel position, anchored to the window's right edge so it tracks resizes. */
  private anchor = { fromRight: 12, top: TOOLBAR_HEIGHT + 4 }
  /** The floating panel's size as the user left it; drawn smaller when the window is. */
  private panelSize: ChatSize = getPrefs().chatSize
  private dockWidth = getPrefs().chatDockWidth
  /** Which size the resize in progress changes, to remember it when it ends. */
  private resizing: 'floating' | 'docked' | null = null
  /** The screenshot menu is open or its capture is running. */
  private screenshotting = false
  private disposed = false
  /** Bumped per openProject; async steps of a superseded open must not touch the window. */
  private openGeneration = 0
  private opening: string | null = null
  /** Bumped per element pick; a slow inspection must not overwrite a newer pick. */
  private pickGeneration = 0
  /** Pending re-highlight of the element a finished turn edited. */
  private rehighlightTimer: NodeJS.Timeout | null = null
  /** The current highlight is that post-turn re-highlight, not a pending selection. */
  private rehighlightShown = false
  /** Bumped when a turn starts or a pick lands; a re-highlight from before must not show. */
  private rehighlightGeneration = 0
  /** The monorepo's apps, for "Switch app…"; empty outside a monorepo. */
  private apps: WorkspaceApp[] = []
  /** The dev server whose setup (consent, install, start) is in flight, so it runs once. */
  private settingUp: DevServer | null = null
  /** The dev server switching to a picked app; further picks wait for it. */
  private switchingApp: DevServer | null = null

  constructor() {
    this.state = {
      project: null,
      devServer: idleDevServer(),
      preview: {
        url: null,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        error: null,
        viewport: 'desktop',
        selecting: false,
        selectable: false,
        visible: false,
      },
      agentId: getPrefs().agentId,
      chatVisible: true,
      logsOpen: false,
      recent: [],
      agents: agentHealth.list(),
      setup: null,
    }

    this.win = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 960,
      minHeight: 640,
      show: false,
      title: 'Grat',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 15 },
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#141414' : '#f5f5f4',
      webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true },
    })

    this.preview = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: PREVIEW_PARTITION,
      },
    })
    this.preview.setVisible(false)
    // Start from a committed blank page; tooling (and CDP clients) expect one.
    this.preview.webContents.loadURL('about:blank').catch(() => undefined)

    this.chatView = new WebContentsView({
      webPreferences: { preload: PRELOAD, sandbox: true, contextIsolation: true },
    })
    this.chatView.setBackgroundColor('#00000000')
    this.chatView.setVisible(false)

    this.win.contentView.addChildView(this.preview)
    this.win.contentView.addChildView(this.chatView)

    this.inspector = new Inspector(this.preview.webContents)
    this.inspector.on('pick', (nodeId) => void this.onPick(nodeId))
    this.inspector.on('cancel', () => this.patchPreview({ selecting: false }))
    this.problems.on('change', (problems) => this.chat?.setProblems(problems))
    agentHealth.on('change', this.onAgentHealth)

    this.bindPreview()
    guardAppContents(this.win.webContents)
    guardAppContents(this.chatView.webContents)
    this.win.on('resize', () => this.layout())
    this.win.once('ready-to-show', () => this.win.show())
    this.win.on('closed', () => this.dispose())

    windows.add(this)
    for (const [wc, page] of [
      [this.win.webContents, 'index'],
      [this.chatView.webContents, 'chat'],
    ] as const) {
      loadRenderer(wc, page).catch((error) => console.error(`[grat] failed to load ${page}`, error))
    }
    void loadRecent().then((recent) => this.patch({ recent }))
  }

  owns(wc: WebContents) {
    return wc === this.win.webContents || wc === this.chatView.webContents
  }

  getState() {
    return this.state
  }

  setRecent(recent: RecentProject[]) {
    this.patch({ recent })
  }

  getLogs() {
    return this.devServer?.logs() ?? ''
  }

  getChat(): ChatSnapshot {
    if (this.chat) return this.chat.snapshot()
    return {
      meta: {
        agentId: this.state.agentId,
        agentName: agentName(this.state.agentId),
        status: 'idle',
        error: null,
        errorDetail: null,
        modeName: null,
        selection: null,
        selectionError: null,
        minimized: false,
        docked: getPrefs().chatDocked,
        redoTurnIds: [],
        problems: [],
      },
      turns: [],
    }
  }

  /** True as soon as a project starts opening, so a second open goes to a new window. */
  get hasProject() {
    return this.state.project !== null || this.opening !== null
  }

  /** Root of the project open in (or opening in) this window. */
  get projectRoot() {
    return this.state.project?.root ?? this.opening
  }

  async openProject(root: string) {
    const generation = ++this.openGeneration
    this.opening = root
    this.closeProject()
    const current = () => !this.disposed && generation === this.openGeneration
    try {
      const file = await historyFile(root)
      const [{ project, apps }, env, saved] = await Promise.all([
        detectProject(root, getPrefs().apps[root] ?? null),
        getShellEnv(),
        loadHistory(file),
      ])
      // Several apps and none picked yet: nothing runs until the user chooses one.
      const choosing = !project.appDir && apps.length > 1
      const setup = await detectSetup(project, choosing ? apps : null)
      if (!current()) return

      const tools = new PreviewTools({
        wc: this.preview.webContents,
        inspector: this.inspector,
        problems: this.problems,
        inspectNode: (backendNodeId) => {
          const project = this.state.project
          if (!project) return Promise.reject(new Error('No project is open'))
          return this.inspectElement(backendNodeId, project, { screenshot: false })
        },
        devOrigin: () => this.devOrigin(),
        currentUrl: () => this.state.preview.url,
        navigate: (url) => this.loadPreview(url),
        logs: () => this.getLogs(),
      })
      this.previewTools = tools
      const mcp = await startMcpServer(tools).catch((error: unknown) => {
        console.error('[grat] preview tools unavailable', error)
        return null
      })
      if (!current()) {
        mcp?.close()
        return
      }
      this.mcp = mcp

      const checkpoints = new Checkpoints(root, join(app.getPath('userData'), 'checkpoints'), env)
      const chat = new ChatController(root, checkpoints, {
        agentId: this.state.agentId,
        docked: getPrefs().chatDocked,
        saved,
        historyFile: file,
        mcpServers: () => (this.mcp ? [this.mcp.config] : []),
      })
      chat.on('meta', (meta) => {
        this.sendChat(Events.chatMeta, meta)
        // Clear the pick highlight only when the selection goes away (sent or removed).
        const selectionId = meta.selection?.id ?? null
        if (this.shownSelectionId && !selectionId) void this.inspector.clearHighlight()
        this.shownSelectionId = selectionId
        if (meta.agentId !== this.state.agentId) this.patch({ agentId: meta.agentId })
        this.layout()
      })
      chat.on('turn', (turn) => {
        this.sendChat(Events.chatTurn, turn)
        // The edited element's highlight would otherwise sit in the next turn's screenshots.
        if (turn.status === 'running') this.cancelRehighlight()
      })
      chat.on('reset', (snapshot) => this.sendChat(Events.chatReset, snapshot))
      chat.on('attention', () => this.focusChat())
      chat.on('turnEnd', (turn) => {
        if (turn.status === 'done' && turn.context && turn.changes?.length) {
          const selector = turn.context.selector
          if (this.rehighlightTimer) clearTimeout(this.rehighlightTimer)
          this.rehighlightTimer = setTimeout(() => {
            this.rehighlightTimer = null
            // After hot reload: show how it looks now, then point at it again.
            void this.captureAfter(chat, turn.id, selector).then(() =>
              this.highlightSelector(selector),
            )
          }, REHIGHLIGHT_DELAY_MS)
        }
      })
      this.chat = chat
      this.patch({ agentId: chat.meta.agentId })
      this.sendChat(Events.chatReset, chat.snapshot())

      // The agent, checkpoints and history stay at the root; only the dev server moves into the app.
      const devServer = new DevServer(appRoot(project))
      devServer.on('data', (chunk) => this.send(Events.logs, chunk))
      devServer.on('line', (line) => this.problems.addServerLine(line))
      devServer.on('change', (state) => this.onDevServer(state))
      devServer.on('stalled', () => this.patch({ logsOpen: true }))
      this.devServer = devServer
      this.apps = apps

      this.win.setTitle(project.name)
      this.win.setRepresentedFilename(root)
      this.patch({
        project,
        setup,
        devServer: devServer.state,
        logsOpen: !project.devCommand && !choosing,
      })
      this.layout()

      const recent = await addRecent({ root, name: project.name })
      if (!current()) return
      this.patch({ recent })
      void this.setUpAndStart()
    } finally {
      if (generation === this.openGeneration) this.opening = null
    }
  }

  /**
   * Opening a folder must not run its scripts until the user has seen them once.
   * Installing runs package scripts too, so it's agreed to in the same dialog.
   */
  private async confirmScripts(project: ProjectInfo, install: boolean) {
    if (await isTrusted(project.root)) return true
    // Scripts and folder names come from the project: shown cleaned up and cut short.
    const devCommand = project.appDir
      ? `${project.devCommand} in ${promptName(project.appDir)}`
      : project.devCommand
    const script = promptText(project.devScript ?? project.devCommand ?? '')
    if (!install) {
      return this.askToTrust(project.root, {
        message: `Start ${promptName(project.name)}?`,
        detail: `To show your app, Grat runs its start command, ${devCommand}:\n\n${script}\n\nOnly start projects you trust. Grat won't ask again for this project.`,
        buttons: ['Start App', 'Not Now'],
      })
    }
    const scripts = (await readPackageJson(project.root))?.scripts
    const installs = INSTALL_SCRIPTS.flatMap((name) => {
      const body = scripts?.[name]
      return typeof body === 'string' && body.trim() ? [`${name}: ${promptText(body)}`] : []
    })
    const installing = installs.length ? `Installing runs:\n\n${installs.join('\n\n')}\n\n` : ''
    return this.askToTrust(project.root, {
      message: `Start ${promptName(project.name)}?`,
      detail: `Grat will install dependencies (${installCommand(project.packageManager)}) and start the dev server (${devCommand}) to preview the project. ${installing}The dev server runs:\n\n${script}\n\nBoth run code from this project. Only continue with projects you trust.`,
      buttons: ['Install and Start', 'Not Now'],
    })
  }

  /**
   * Git runs the repository's own hooks, and even `git status` can run a command set in
   * its config (`core.fsmonitor`), so it waits for trust like the project's scripts do.
   */
  private async confirmGit(root: string) {
    if (await isTrusted(root)) return true
    return this.askToTrust(root, {
      message: 'Create a pull request?',
      detail:
        "Grat runs Git in this project, which also runs the project's own Git hooks. Only continue for projects you trust.",
      buttons: ['Continue', 'Cancel'],
    })
  }

  /** The trust prompt; agreeing trusts the project from then on. */
  private askToTrust(root: string, options: MessageBoxOptions) {
    if (this.disposed) return Promise.resolve(false)
    return askToTrust(root, options, this.win)
  }

  closeProject() {
    this.cancelRehighlight()
    this.devServer?.dispose()
    this.devServer = null
    this.apps = []
    this.chat?.dispose()
    this.chat = null
    this.mcp?.close()
    this.mcp = null
    this.previewTools = null
    this.problems.clear()
    void this.inspector.clearHighlight()
    this.preview.setVisible(false)
    this.preview.webContents.loadURL('about:blank').catch(() => undefined)
    this.patch({
      project: null,
      setup: null,
      devServer: idleDevServer(),
      preview: { ...this.state.preview, url: null, error: null, visible: false, selecting: false },
    })
  }

  // Dev server

  /** From the UI; an untrusted project still shows its scripts and asks first. */
  startDevServer() {
    void this.setUpAndStart()
  }

  stopDevServer() {
    this.devServer?.stop()
  }

  restartDevServer() {
    if (this.devServer?.state.command) void this.devServer.restart()
    else this.startDevServer()
  }

  resizeLogs(cols: number, rows: number) {
    this.devServer?.resize(cols, rows)
  }

  setLogsOpen(open: boolean) {
    this.patch({ logsOpen: open })
  }

  private onDevServer(state: DevServerState) {
    const wasRunning = this.state.devServer.status === 'running'
    this.patch({ devServer: state })
    if (state.status === 'running' && state.url && !wasRunning) {
      void this.loadPreview(state.url)
    } else if (state.status === 'exited') {
      this.patch({ logsOpen: true })
      this.patchPreview({ visible: false, selecting: false, loading: false })
    }
  }

  // Preview

  navigate(input: string) {
    const base = this.state.devServer.url ?? this.state.preview.url
    const trimmed = input.trim()
    // `localhost:5173/x` would otherwise parse as the scheme "localhost:".
    const withScheme = /^[\w.-]+:\d+(\/|$)/.test(trimmed) ? `http://${trimmed}` : trimmed
    let url: string
    try {
      url = new URL(withScheme, base ?? undefined).toString()
    } catch {
      return
    }
    if (!/^https?:/.test(url)) return
    void this.loadPreview(url)
  }

  back() {
    const history = this.preview.webContents.navigationHistory
    if (history.canGoBack()) history.goBack()
  }

  forward() {
    const history = this.preview.webContents.navigationHistory
    if (history.canGoForward()) history.goForward()
  }

  reload() {
    if (this.state.preview.url) this.preview.webContents.reload()
  }

  setViewport(viewport: Viewport) {
    this.patchPreview({ viewport })
    this.layout()
  }

  toggleDevTools() {
    this.preview.webContents.toggleDevTools()
  }

  private async loadPreview(url: string) {
    this.patchPreview({ url, error: null })
    try {
      await this.preview.webContents.loadURL(url)
    } catch {
      // did-fail-load reports the error state
    }
  }

  private bindPreview() {
    const wc = this.preview.webContents
    wc.on('did-start-loading', () => this.patchPreview({ loading: true }))
    wc.on('did-stop-loading', () => this.patchPreview({ loading: false }))
    wc.on('dom-ready', () => {
      if (wc.getURL() !== 'about:blank') this.patchPreview({ visible: true, error: null })
    })
    wc.on('did-navigate', (_event, url) => {
      this.problems.clearConsole()
      this.onNavigated(url)
    })
    wc.on('console-message', (event) => {
      if (!this.isAppFrame(event.frame)) return
      const where = event.sourceId ? `${event.sourceId}:${event.lineNumber}` : ''
      this.problems.addConsole(event.level, event.message, where)
    })
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) this.onNavigated(url)
    })
    wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 is ERR_ABORTED, which fires for superseded navigations.
      if (!isMainFrame || code === -3) return
      this.patchPreview({ error: `${description} — ${url}`, visible: false, loading: false })
    })
    wc.on('render-process-gone', (_event, details) => {
      this.patchPreview({
        error: `The preview crashed (${details.reason}).`,
        visible: false,
        selecting: false,
      })
    })
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && this.state.preview.selecting) {
        event.preventDefault()
        void this.setSelecting(false)
      }
    })
    wc.setWindowOpenHandler(({ url }) => {
      const origin = this.devOrigin()
      if (origin && originOf(url) === origin) void this.loadPreview(url)
      else if (/^https?:/.test(url)) shell.openExternal(url).catch(() => undefined)
      return { action: 'deny' }
    })
    // Navigating off-site is allowed (OAuth round-trips), but never to app protocols.
    wc.on('will-navigate', (event, url) => {
      if (!/^(https?|about):/i.test(url)) event.preventDefault()
    })
    wc.on('select-bluetooth-device', (event, _devices, callback) => {
      event.preventDefault()
      callback('')
    })
  }

  /** Problems come from the local app's own document, not third-party iframes inside it. */
  private isAppFrame(frame: WebFrameMain | null | undefined) {
    try {
      const main = this.preview.webContents.mainFrame
      if (!frame || frame.frameTreeNodeId !== main.frameTreeNodeId) return false
      return frame.origin === this.devOrigin() || isLoopback(frame.origin)
    } catch {
      // The frame was disposed before the message was handled.
      return false
    }
  }

  private onNavigated(url: string) {
    if (url === 'about:blank') return
    const history = this.preview.webContents.navigationHistory
    this.patchPreview({
      url,
      selectable: isLoopback(url),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
    })
  }

  // Selection

  async toggleSelect() {
    await this.setSelecting(!this.state.preview.selecting)
  }

  async setSelecting(on: boolean) {
    // Only pick from the local app: element data is sent to the agent.
    const local = isLoopback(this.preview.webContents.getURL())
    if (on && (!this.state.preview.visible || !this.chat || !local)) return
    try {
      // Report "selecting" only once inspect mode is live; a click before that would
      // land on the page instead of picking.
      await this.inspector.setInspecting(on)
      this.patchPreview({ selecting: on })
      if (on) this.preview.webContents.focus()
    } catch (error) {
      console.error('[grat] inspect mode failed', error)
      this.patchPreview({ selecting: false })
    }
  }

  private async onPick(nodeId: number) {
    this.patchPreview({ selecting: false })
    const generation = ++this.pickGeneration
    const project = this.state.project
    const chat = this.chat
    if (!project || !chat || !isLoopback(this.preview.webContents.getURL())) return
    try {
      const element = await this.inspectElement(nodeId, project)
      if (generation !== this.pickGeneration || chat !== this.chat) return
      chat.setSelection(element)
      this.focusChat()
      this.dodge(element.rect)
      // The pick's highlight replaces any post-turn one and belongs to the selection. It can
      // wait behind an agent screenshot, and a node gone after hot reload doesn't undo the pick.
      this.cancelRehighlight()
      void this.inspector.highlight(nodeId).catch(() => undefined)
    } catch (error) {
      if (generation !== this.pickGeneration || chat !== this.chat) return
      const message = error instanceof Error ? error.message : String(error)
      chat.setSelectionError(`Couldn't read that element: ${message}`)
      this.focusChat()
    }
  }

  /**
   * Inspects a picked element, with its source path relative to the repo root (where the
   * agent works). A monorepo app's dev server reports paths relative to the app's folder
   * (Vite's `/src/App.tsx`), so resolve there first; files in shared packages outside the
   * app only resolve from the root.
   */
  private async inspectElement(
    nodeId: number,
    project: ProjectInfo,
    options: { screenshot?: boolean } = {},
  ) {
    const { root, appDir } = project
    const origin = this.devOrigin()
    if (!appDir) return this.inspector.inspect(nodeId, root, origin, options)
    const element = await this.inspector.inspect(nodeId, appRoot(project), origin, options)
    if (element.source) {
      return {
        ...element,
        source: { ...element.source, file: posix.join(appDir, element.source.file) },
      }
    }
    const { source } = await this.inspector.inspect(nodeId, root, origin, { screenshot: false })
    return { ...element, source }
  }

  private devOrigin() {
    return this.state.devServer.url ? originOf(this.state.devServer.url) : null
  }

  // Chat

  sendChatMessage(text: string, images: ImageAttachment[]) {
    return this.chat?.send(text, images) ?? false
  }

  // Shipping (src/main/ship.ts)

  async getShipInfo(): Promise<ShipInfo | null> {
    const root = this.state.project?.root
    const chat = this.chat
    if (!root || !chat) return null
    if (!(await this.confirmGit(root))) return cancelledShipInfo()
    if (chat !== this.chat) return null
    const prompts = chat
      .snapshot()
      .turns.filter((turn) => turn.status === 'done' && !turn.reverted)
      .map((turn) => turn.prompt)
    const info = await shipInfo(root, prompts)
    if (chat.busy && !info.blocked)
      return { ...info, blocked: 'Wait for the agent to finish first.' }
    return info
  }

  async ship(request: ShipRequest): Promise<ShipResult> {
    const root = this.state.project?.root
    if (!root) throw new Error('No project is open.')
    if (this.chat?.busy) throw new Error('Wait for the agent to finish first.')
    if (!(await this.confirmGit(root))) throw new Error('Cancelled.')
    if (this.state.project?.root !== root) throw new Error('No project is open.')
    return ship(root, request)
  }

  // Project setup (WindowState.setup)

  /** Runs the picked monorepo app from now on, and remembers it for this project. */
  chooseApp(dir: string) {
    const project = this.state.project
    if (!project || !this.apps.some((app) => app.dir === dir)) return
    if (this.devServer && this.switchingApp === this.devServer) return
    setPrefs({ apps: { ...getPrefs().apps, [project.root]: dir } })
    void this.runApp(dir)
  }

  /** The canvas's button for a project that isn't set up yet, and "Try again" after a failure. */
  installDependencies() {
    void this.setUpAndStart()
  }

  async createEnvFile() {
    const root = this.state.project?.root
    const env = this.state.setup?.env
    if (!root || !env) return
    if (!env.created) {
      try {
        await createEnvFile(root, env)
      } catch (error) {
        console.error('[grat] failed to create the env file', error)
        return
      }
      if (this.state.project?.root !== root) return
      this.patchSetup({ env: { ...env, created: true } })
    }
    this.openEnvFile()
  }

  openEnvFile() {
    const root = this.state.project?.root
    const env = this.state.setup?.env
    if (!root || !env?.created) return
    void envFile(root, env.target).then(
      // Always as text in the default text editor: `shell.openPath` would hand the file to
      // whatever app its type maps to.
      (path) => execFile('/usr/bin/open', ['-t', path], () => undefined),
      (error: unknown) => console.error('[grat] not opening the env file', error),
    )
  }

  /**
   * Gets the project running: installs dependencies if they're missing, then starts the
   * dev server. An untrusted project asks first, whether it's opening or the user clicked.
   */
  private async setUpAndStart() {
    const { project, setup } = this.state
    const devServer = this.devServer
    if (!project?.devCommand || !devServer || setup?.apps) return
    if (this.settingUp === devServer || setup?.dependencies === 'installing') return
    this.settingUp = devServer
    try {
      const install = setup?.dependencies === 'missing' || setup?.dependencies === 'failed'
      if (!(await this.confirmScripts(project, install))) return
      if (devServer !== this.devServer) return
      if (install && !(await this.install(devServer, project))) return
      await devServer.start(project.devCommand)
    } finally {
      if (this.settingUp === devServer) this.settingUp = null
    }
  }

  /** Installs at the (workspace) root, streaming into the logs. True when it succeeded. */
  private async install(devServer: DevServer, project: ProjectInfo) {
    this.patchSetup({ dependencies: 'installing' })
    const missing = await missingPackageManager(project.packageManager, await getShellEnv())
    if (devServer !== this.devServer) return false
    const code = missing
      ? null
      : await devServer.runTask(installCommand(project.packageManager), project.root)
    if (devServer !== this.devServer) return false
    if (missing) devServer.print(missing)
    if (code === 0) {
      this.patchSetup({ dependencies: 'ok' })
      return true
    }
    this.patchSetup({ dependencies: 'failed' })
    this.patch({ logsOpen: true })
    return false
  }

  /** Switches the dev server to another monorepo app, then sets it up and starts it. */
  private async runApp(dir: string) {
    const devServer = this.devServer
    const root = this.state.project?.root
    if (!devServer || !root) return
    this.switchingApp = devServer
    try {
      await devServer.stopAndWait()
      const { project } = await detectProject(root, dir)
      const env = await detectEnv(root, project.appDir)
      if (devServer !== this.devServer) return
      devServer.setCwd(appRoot(project))
      this.patch({ project, setup: this.nextSetup({ apps: null, env }) })
    } finally {
      if (this.switchingApp === devServer) this.switchingApp = null
    }
    await this.setUpAndStart()
  }

  /** "Switch app…": stops the current app and asks again. */
  private showAppChooser() {
    this.devServer?.stop()
    void this.inspector.clearHighlight()
    this.preview.setVisible(false)
    this.preview.webContents.loadURL('about:blank').catch(() => undefined)
    this.patchPreview({ url: null, error: null, visible: false, selecting: false })
    this.patchSetup({ apps: this.apps })
  }

  private patchSetup(patch: Partial<ProjectSetup>) {
    this.patch({ setup: this.nextSetup(patch) })
  }

  private nextSetup(patch: Partial<ProjectSetup>) {
    const setup = this.state.setup ?? { apps: null, dependencies: 'ok', env: null }
    return settleSetup({ ...setup, ...patch })
  }

  cancelChat() {
    void this.chat?.cancel()
  }

  respondPermission(turnId: string, itemId: string, optionId: string | null) {
    this.chat?.respondPermission(turnId, itemId, optionId)
  }

  restoreTurn(turnId: string) {
    return this.chat?.restoreTurn(turnId)
  }

  redo() {
    return this.chat?.redo()
  }

  newChat() {
    void this.chat?.reset()
  }

  clearSelection() {
    this.chat?.setSelection(null)
  }

  setAgent(agentId: AgentId) {
    if (!agentHealth.has(agentId)) return
    agentHealth.ensureChecked(agentId)
    setPrefs({ agentId })
    this.patch({ agentId })
    void this.chat?.setAgent(agentId)
  }

  toggleDock() {
    if (!this.chat) return
    const docked = !this.chat.meta.docked
    setPrefs({ chatDocked: docked })
    this.chat.setDocked(docked)
    if (!this.state.chatVisible) this.patch({ chatVisible: true })
    this.layout()
  }

  fixProblems() {
    const sent = this.chat?.fixProblems() ?? false
    if (sent) this.focusChat()
    return sent
  }

  /** Shows the changed element in the turn, next to how it looked when it was picked. */
  private async captureAfter(chat: ChatController, turnId: string, selector: string) {
    const tools = this.previewTools
    if (!tools || chat !== this.chat || !this.state.preview.visible) return
    const shot = await tools.screenshot({ selector }).catch(() => null)
    if (chat === this.chat) chat.setPreviewAfter(turnId, thumbnail(shot))
  }

  /** Undoes the newest turn that changed files and hasn't been undone. */
  async undoLastChange() {
    const turnId = this.chat?.lastUndoableTurnId()
    if (!turnId) return shell.beep()
    await this.chat?.restoreTurn(turnId).catch(() => shell.beep())
  }

  async redoLastChange() {
    if (!this.chat?.meta.redoTurnIds.length) return shell.beep()
    await this.chat.redo().catch(() => shell.beep())
  }

  /** Re-finds an element after hot reload (its old node is gone) and highlights it. */
  private async highlightSelector(selector: string | undefined) {
    if (!selector || !this.state.preview.visible || this.chat?.meta.selection) return
    const generation = this.rehighlightGeneration
    // A turn or pick can start while this waits on the inspector; checked again under its lock.
    const current = () => generation === this.rehighlightGeneration && !this.chat?.meta.selection
    try {
      const backendNodeId = await this.inspector.querySelector(selector)
      if (!current()) return
      // Set first so a turn starting mid-highlight clears it; a stray clear is harmless.
      this.rehighlightShown = true
      await this.inspector.highlight(backendNodeId, current)
    } catch {
      // The element may legitimately be gone after the edit.
    }
  }

  /** Drops the post-turn re-highlight, shown or still pending. */
  private cancelRehighlight() {
    this.rehighlightGeneration++
    if (this.rehighlightTimer) clearTimeout(this.rehighlightTimer)
    this.rehighlightTimer = null
    if (!this.rehighlightShown) return
    this.rehighlightShown = false
    void this.inspector.clearHighlight()
  }

  toggleChat() {
    this.patch({ chatVisible: !this.state.chatVisible })
    this.layout()
    if (this.state.chatVisible) this.focusChat()
  }

  setMinimized(minimized: boolean) {
    this.chat?.setMinimized(minimized)
    this.layout()
  }

  dragChat(dx: number, dy: number) {
    this.anchor = { fromRight: this.anchor.fromRight - dx, top: this.anchor.top + dy }
    this.layout()
  }

  /**
   * Chat panel resizing: `dx` moves the left edge (floating or docked), `dy` the floating
   * panel's bottom edge. The floating panel keeps its right and top edges where they are.
   */
  resizeChat(dx: number, dy: number) {
    if (!this.state.chatVisible || !this.hasProject) return
    if (this.chat?.meta.docked ?? getPrefs().chatDocked) {
      const width = this.dockedWidth() - dx
      this.dockWidth = Math.round(clamp(width, DOCK_MIN_WIDTH, this.canvas.width * DOCK_MAX_SHARE))
      this.resizing = 'docked'
    } else {
      if (this.chat?.meta.minimized) return
      const [contentWidth, contentHeight] = this.win.getContentSize()
      // From the size on screen, which may be less than the remembered one.
      const { width, height } = this.floatingSize(contentWidth, contentHeight)
      const max = maxFloatingSize(contentWidth, contentHeight)
      // The panel grows toward the window's left and bottom edges and stops there.
      const right = contentWidth - this.anchor.fromRight - SHADOW
      const top = this.anchor.top + SHADOW
      this.panelSize = {
        width: Math.round(clamp(width - dx, PANEL_MIN.width, Math.min(max.width, right))),
        height: Math.round(
          clamp(height + dy, PANEL_MIN.height, Math.min(max.height, contentHeight - top)),
        ),
      }
      this.resizing = 'floating'
    }
    this.layout()
  }

  /** Remembers the new size for this and later windows. */
  endResizeChat() {
    if (this.resizing === 'docked') setPrefs({ chatDockWidth: this.dockWidth })
    else if (this.resizing === 'floating') setPrefs({ chatSize: this.panelSize })
    this.resizing = null
  }

  /**
   * Screenshot menu for the preview: copy, copy full page, save, attach to chat. Resolves
   * with what was done; null when dismissed, cancelled or the capture failed.
   */
  async screenshotMenu(): Promise<ScreenshotResult | null> {
    const tools = this.previewTools
    const project = this.state.project
    if (this.screenshotting) return null
    if (!tools || !project || !this.canCapture()) {
      shell.beep()
      return null
    }
    this.screenshotting = true
    try {
      const action = await this.chooseScreenshot()
      if (!action || tools !== this.previewTools || !this.canCapture()) return null
      // Inspect mode's hover highlight is drawn into the page, so leave it first.
      if (this.state.preview.selecting) await this.setSelecting(false)
      // At the display's own resolution, and without the selection highlight.
      const shot = await tools.screenshot({
        fullPage: action === 'copy-full-page',
        fullResolution: true,
      })
      const name = screenshotName(project.name)
      const png = Buffer.from(shot.data, 'base64')
      switch (action) {
        case 'copy':
        case 'copy-full-page':
          await clipboard.write([
            new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) }),
          ])
          return 'copied'
        case 'save':
          return (await this.saveScreenshot(png, name)) ? 'saved' : null
        case 'attach':
          return this.attachScreenshot(png, name) ? 'attached' : null
      }
    } catch (error) {
      console.error('[grat] screenshot failed', error)
      shell.beep()
      return null
    } finally {
      this.screenshotting = false
    }
  }

  /** Like the agent's tools: only the local app, never a page it linked to. */
  private canCapture() {
    return this.state.preview.visible && isLoopback(this.preview.webContents.getURL())
  }

  /** Resolves with the chosen item, or null when the menu closes without a choice. */
  private chooseScreenshot() {
    return new Promise<ScreenshotAction | null>((resolve) => {
      const item = (
        label: string,
        action: ScreenshotAction,
        enabled = true,
      ): MenuItemConstructorOptions => ({ label, enabled, click: () => resolve(action) })
      Menu.buildFromTemplate([
        item('Copy Screenshot', 'copy'),
        item('Copy Full Page', 'copy-full-page'),
        item('Save Screenshot…', 'save'),
        { type: 'separator' },
        item('Attach to Chat', 'attach', this.chat !== null),
      ]).popup({
        window: this.win,
        // Electron runs a chosen item's click before this, so this only settles a dismissal.
        callback: () => resolve(null),
      })
    })
  }

  /** False when the user cancelled the save panel. */
  private async saveScreenshot(png: Buffer, name: string) {
    const { canceled, filePath } = await dialog.showSaveDialog(this.win, {
      defaultPath: join(app.getPath('desktop'), `${name}.png`),
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    })
    if (canceled || !filePath) return false
    await writeFile(filePath, png)
    return true
  }

  /** Adds the screenshot to the composer as a reference image, then shows the chat. */
  private attachScreenshot(png: Buffer, name: string) {
    if (!this.chat) return false
    const image = nativeImage.createFromBuffer(png)
    if (image.isEmpty()) throw new Error("Couldn't read the captured image")
    this.focusChat()
    this.sendChat(Events.chatAttach, chatImage(image, name))
    return true
  }

  endDragChat() {
    this.layout()
  }

  private focusChat() {
    if (!this.state.chatVisible) {
      this.patch({ chatVisible: true })
    }
    if (this.chat?.meta.minimized) this.chat.setMinimized(false)
    this.layout()
    this.chatView.webContents.focus()
    this.sendChat(Events.chatFocus, null)
  }

  // Layout

  setCanvasRect(rect: Rect) {
    this.canvas = rect
    this.layout()
  }

  private layout() {
    if (this.disposed) return
    const [contentWidth, contentHeight] = this.win.getContentSize()
    const showChat = this.state.chatVisible && this.hasProject
    // While a project opens there's no chat yet; the panel renders from prefs meanwhile.
    const docked = showChat && (this.chat?.meta.docked ?? getPrefs().chatDocked)

    // A docked panel takes a column on the right; the preview gets what's left.
    const dockWidth = this.dockedWidth()
    const area = docked
      ? { ...this.canvas, width: Math.max(0, this.canvas.width - dockWidth) }
      : this.canvas
    const preview = this.state.preview
    const maxWidth = VIEWPORT_WIDTH[preview.viewport]
    const width = maxWidth > 0 ? Math.min(maxWidth, area.width - 24) : Math.max(0, area.width)
    const x = area.x + Math.round((area.width - width) / 2)
    const inset = maxWidth > 0 ? 12 : 0
    this.preview.setBounds({
      x: Math.round(x),
      y: Math.round(area.y + inset),
      width: Math.max(0, Math.round(width)),
      height: Math.max(0, Math.round(area.height - inset * 2)),
    })
    this.preview.setVisible(preview.visible && area.width > 0)

    this.chatView.setVisible(showChat)
    if (!showChat) return
    if (docked) {
      this.chatView.setBounds({
        x: Math.round(this.canvas.x + this.canvas.width - dockWidth),
        y: Math.round(this.canvas.y),
        width: dockWidth,
        height: Math.max(0, Math.round(this.canvas.height)),
      })
      return
    }
    const minimized = this.chat?.meta.minimized ?? false
    const panel = minimized ? MINI : this.floatingSize(contentWidth, contentHeight)
    const viewWidth = panel.width + SHADOW * 2
    const viewHeight = panel.height + SHADOW * 2
    const fromRight = clamp(this.anchor.fromRight, -SHADOW, contentWidth - viewWidth + SHADOW)
    const top = clamp(this.anchor.top, TOOLBAR_HEIGHT - SHADOW, contentHeight - viewHeight + SHADOW)
    this.anchor = { fromRight, top }
    this.chatView.setBounds({
      x: Math.round(contentWidth - viewWidth - fromRight),
      y: Math.round(top),
      width: viewWidth,
      height: viewHeight,
    })
  }

  /** The docked panel's width: the remembered one, within what the canvas leaves room for. */
  private dockedWidth() {
    return Math.round(clamp(this.dockWidth, DOCK_MIN_WIDTH, this.canvas.width * DOCK_MAX_SHARE))
  }

  /** The floating panel's size: the remembered one, within the window. */
  private floatingSize(contentWidth: number, contentHeight: number): ChatSize {
    const max = maxFloatingSize(contentWidth, contentHeight)
    return {
      width: Math.round(clamp(this.panelSize.width, PANEL_MIN.width, max.width)),
      height: Math.round(clamp(this.panelSize.height, PANEL_MIN.height, max.height)),
    }
  }

  /** Moves the floating panel to the other side if it covers the element just picked. */
  private dodge(rect: Rect) {
    if (!this.chat || this.chat.meta.docked || !this.state.chatVisible) return
    const previewBounds = this.preview.getBounds()
    const element = {
      x: previewBounds.x + rect.x,
      y: previewBounds.y + rect.y,
      width: rect.width,
      height: rect.height,
    }
    const view = this.chatView.getBounds()
    const panel = {
      x: view.x + SHADOW,
      y: view.y + SHADOW,
      width: view.width - SHADOW * 2,
      height: view.height - SHADOW * 2,
    }
    const overlaps =
      element.x < panel.x + panel.width &&
      element.x + element.width > panel.x &&
      element.y < panel.y + panel.height &&
      element.y + element.height > panel.y
    if (!overlaps) return
    const [contentWidth] = this.win.getContentSize()
    const elementCenter = element.x + element.width / 2
    const margin = 12 - SHADOW
    // Put the panel against whichever edge is farther from the element.
    this.anchor.fromRight =
      elementCenter > contentWidth / 2
        ? contentWidth - view.width - (this.canvas.x + margin)
        : margin
    this.layout()
  }

  // Native menus

  showDevServerMenu() {
    const { status, url } = this.state.devServer
    const running = status === 'running' || status === 'starting'
    const template: MenuItemConstructorOptions[] = [
      running
        ? { label: 'Restart dev server', click: () => this.restartDevServer() }
        : {
            label: 'Start dev server',
            enabled: !!this.state.project?.devCommand,
            click: () => this.startDevServer(),
          },
      { label: 'Stop dev server', enabled: running, click: () => this.stopDevServer() },
      { type: 'separator' },
      {
        label: this.state.logsOpen ? 'Hide logs' : 'Show logs',
        click: () => this.setLogsOpen(!this.state.logsOpen),
      },
      {
        label: 'Open in browser',
        enabled: !!url,
        click: () => {
          if (url) shell.openExternal(this.state.preview.url ?? url).catch(() => undefined)
        },
      },
    ]
    Menu.buildFromTemplate(template).popup({ window: this.win })
  }

  showAgentMenu(openSettings: () => void) {
    const template: MenuItemConstructorOptions[] = [
      ...agentMenuItems(
        agentHealth.list(),
        agentHealth.customError,
        this.state.agentId,
        (id) => this.setAgent(id),
        openSettings,
      ),
      { type: 'separator' },
      { label: 'New chat', enabled: this.hasProject, click: () => this.newChat() },
    ]
    Menu.buildFromTemplate(template).popup({ window: this.win })
  }

  showProjectMenu(openPicker: () => void, openRecent: (root: string) => void) {
    const recent = this.state.recent.filter((p) => p.root !== this.state.project?.root)
    const template: MenuItemConstructorOptions[] = [
      { label: 'Open project…', click: openPicker },
      ...(recent.length
        ? [
            { type: 'separator' } as const,
            ...recent.map(
              (p): MenuItemConstructorOptions => ({
                label: p.name,
                sublabel: p.root,
                click: () => openRecent(p.root),
              }),
            ),
          ]
        : []),
      { type: 'separator' },
      ...(this.apps.length > 1
        ? [
            {
              label: 'Switch app…',
              enabled: !this.state.setup?.apps && this.state.setup?.dependencies !== 'installing',
              click: () => this.showAppChooser(),
            },
          ]
        : []),
      {
        label: 'Reveal in Finder',
        enabled: this.hasProject,
        click: () => this.state.project && shell.showItemInFolder(this.state.project.root),
      },
    ]
    Menu.buildFromTemplate(template).popup({ window: this.win })
  }

  // Plumbing

  private patch(patch: Partial<WindowState>) {
    this.state = { ...this.state, ...patch }
    this.send(Events.state, this.state)
  }

  private patchPreview(patch: Partial<PreviewState>) {
    const prevVisible = this.state.preview.visible
    this.patch({ preview: { ...this.state.preview, ...patch } })
    if (this.state.preview.visible !== prevVisible) this.layout()
  }

  private send(channel: string, payload: unknown) {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload)
  }

  private sendChat(channel: string, payload: unknown) {
    if (!this.chatView.webContents.isDestroyed()) this.chatView.webContents.send(channel, payload)
  }

  private onAgentHealth = (agents: WindowState['agents']) => this.patch({ agents })

  private dispose() {
    if (this.disposed) return
    this.disposed = true
    windows.delete(this)
    agentHealth.off('change', this.onAgentHealth)
    if (this.rehighlightTimer) clearTimeout(this.rehighlightTimer)
    this.problems.dispose()
    this.devServer?.dispose()
    this.chat?.dispose()
    this.mcp?.close()
    this.inspector.dispose()
    if (!this.preview.webContents.isDestroyed()) this.preview.webContents.close()
    if (!this.chatView.webContents.isDestroyed()) this.chatView.webContents.close()
  }

  /** Synchronous teardown for app quit. */
  destroy() {
    this.dispose()
  }
}

/** App UI never navigates; links open in the user's browser instead. */

/** What the ship sheet shows when the user didn't let Grat run Git. */
function cancelledShipInfo(): ShipInfo {
  return {
    blocked: 'Cancelled.',
    branch: null,
    onDefaultBranch: false,
    files: [],
    skipped: [],
    remote: null,
    suggestion: { branch: '', title: '', body: '' },
  }
}

/** Where the dev server runs: a monorepo app's folder, or the project root. */
function appRoot(project: ProjectInfo) {
  return project.appDir ? join(project.root, project.appDir) : project.root
}

function originOf(url: string) {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/** The largest the floating panel can be in a window this size. */
function maxFloatingSize(contentWidth: number, contentHeight: number): ChatSize {
  return {
    width: contentWidth - PANEL_MARGIN * 2,
    height: contentHeight - TOOLBAR_HEIGHT - PANEL_MARGIN * 2,
  }
}

/** "<project> 2026-10-03 at 14.05.09", the way macOS names screenshots. */
function screenshotName(project: string, date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0')
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`
  // Project names come from package.json, which can hold path separators ("@scope/app").
  const base =
    project
      .replace(/[\p{Cc}/\\:]/gu, '-')
      .trim()
      .slice(0, 100) || 'Screenshot'
  return `${base} ${day} at ${time}`
}

/**
 * A screenshot as the composer attaches images: downscaled for the agent, a PNG unless
 * that's photo-sized, plus a small thumbnail for the transcript.
 */
function chatImage(source: NativeImage, name: string): ImageAttachment {
  const image = fitImage(source, ATTACH_EDGE)
  const png = image.toPNG()
  const jpeg = png.length > ATTACH_MAX_PNG_BYTES
  const thumbnail = fitImage(source, ATTACH_THUMBNAIL_EDGE).toPNG()
  return {
    name: `${name}.${jpeg ? 'jpg' : 'png'}`,
    mimeType: jpeg ? 'image/jpeg' : 'image/png',
    data: (jpeg ? image.toJPEG(85) : png).toString('base64'),
    thumbnail: `data:image/png;base64,${thumbnail.toString('base64')}`,
  }
}

/** Scales an image down so its long side is at most `edge`. */
function fitImage(image: NativeImage, edge: number) {
  const { width, height } = image.getSize()
  const scale = Math.min(1, edge / Math.max(width, height))
  if (scale === 1) return image
  return image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'best',
  })
}
