import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
  nativeTheme,
  shell,
  type WebContents,
  WebContentsView,
} from 'electron'
import { Events } from '../shared/ipc'
import {
  AGENTS,
  type AgentId,
  type ChatSnapshot,
  type DevServerState,
  type PreviewState,
  type ProjectInfo,
  type Rect,
  type Viewport,
  type WindowState,
} from '../shared/types'
import { ChatController } from './chat'
import { Checkpoints } from './checkpoints'
import { DevServer } from './dev-server'
import { Inspector } from './inspector'
import { detectProject } from './project'
import { addRecent, loadRecent } from './recent'
import { getShellEnv } from './shell-env'
import { isTrusted, trust } from './trust'

const TOOLBAR_HEIGHT = 44
const PANEL = { width: 400, height: 640 }
const MINI = { width: 248, height: 52 }
/** Transparent margin around the floating panel so its shadow isn't clipped. */
const SHADOW = 18
const VIEWPORT_WIDTH: Record<Viewport, number> = { desktop: 0, tablet: 820, mobile: 390 }

const PRELOAD = join(import.meta.dirname, '../preload/index.cjs')

const windows = new Set<ProjectWindow>()

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

function rendererUrl(page: 'index' | 'chat') {
  // Never honor the dev-server override in packaged builds: it would load remote
  // content into renderers that have the privileged preload.
  if (app.isPackaged) return null
  const dev = process.env.ELECTRON_RENDERER_URL
  return dev ? `${dev}/${page}.html` : null
}

function loadRenderer(wc: WebContents, page: 'index' | 'chat') {
  const url = rendererUrl(page)
  if (url) return wc.loadURL(url)
  return wc.loadFile(join(import.meta.dirname, `../renderer/${page}.html`))
}

const idleDevServer = (): DevServerState => ({
  status: 'idle',
  command: null,
  url: null,
  exitCode: null,
  lastLine: '',
})

export class ProjectWindow {
  readonly win: BrowserWindow
  private readonly preview: WebContentsView
  private readonly chatView: WebContentsView
  private readonly inspector: Inspector
  private state: WindowState
  private devServer: DevServer | null = null
  private chat: ChatController | null = null
  private canvas: Rect = { x: 0, y: 0, width: 0, height: 0 }
  /** Panel position, anchored to the window's right edge so it tracks resizes. */
  private anchor = { fromRight: 12, top: TOOLBAR_HEIGHT + 4 }
  private disposed = false

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
        visible: false,
      },
      agentId: 'claude',
      chatVisible: true,
      logsOpen: false,
      recent: [],
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
        partition: 'persist:grat-preview',
      },
    })
    this.preview.setVisible(false)

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

    this.bindPreview()
    guardAppContents(this.win.webContents)
    guardAppContents(this.chatView.webContents)
    this.win.on('resize', () => this.layout())
    this.win.once('ready-to-show', () => this.win.show())
    this.win.on('closed', () => this.dispose())

    windows.add(this)
    void loadRenderer(this.win.webContents, 'index')
    void loadRenderer(this.chatView.webContents, 'chat')
    void loadRecent().then((recent) => this.patch({ recent }))
  }

  owns(wc: WebContents) {
    return wc === this.win.webContents || wc === this.chatView.webContents
  }

  getState() {
    return this.state
  }

  getLogs() {
    return this.devServer?.logs() ?? ''
  }

  getChat(): ChatSnapshot {
    if (this.chat) return this.chat.snapshot()
    const agent = AGENTS.find((a) => a.id === this.state.agentId) ?? AGENTS[0]
    return {
      meta: {
        agentId: agent.id,
        agentName: agent.name,
        status: 'idle',
        error: null,
        modeName: null,
        selection: null,
        minimized: false,
        canRedo: false,
      },
      turns: [],
    }
  }

  get hasProject() {
    return this.state.project !== null
  }

  async openProject(root: string) {
    this.closeProject()
    const project = await detectProject(root)
    if (this.disposed) return

    const env = await getShellEnv()
    const checkpoints = new Checkpoints(root, join(app.getPath('userData'), 'checkpoints'), env)
    const chat = new ChatController(root, checkpoints, this.state.agentId)
    chat.on('meta', (meta) => {
      this.sendChat(Events.chatMeta, meta)
      if (!meta.selection) void this.inspector.clearHighlight()
      this.layout()
    })
    chat.on('turn', (turn) => this.sendChat(Events.chatTurn, turn))
    chat.on('reset', (snapshot) => this.sendChat(Events.chatReset, snapshot))
    this.chat = chat
    this.sendChat(Events.chatReset, chat.snapshot())

    const devServer = new DevServer(root)
    devServer.on('data', (chunk) => this.send(Events.logs, chunk))
    devServer.on('change', (state) => this.onDevServer(state))
    this.devServer = devServer

    this.win.setTitle(project.name)
    this.win.setRepresentedFilename(root)
    this.patch({ project, devServer: devServer.state, logsOpen: !project.devCommand })
    this.layout()

    const recent = await addRecent({ root, name: project.name })
    this.patch({ recent })
    if (project.devCommand && (await this.confirmDevScript(project))) {
      if (this.devServer === devServer) void devServer.start(project.devCommand)
    }
  }

  /** Opening a folder must not run its scripts until the user has seen them once. */
  private async confirmDevScript(project: ProjectInfo) {
    if (await isTrusted(project.root)) return true
    if (this.disposed) return false
    const { response } = await dialog.showMessageBox(this.win, {
      type: 'question',
      message: `Run ${project.devCommand}?`,
      detail: `Grat starts the project's dev server to preview it. This runs:\n\n${project.devScript ?? project.devCommand}\n\nOnly run scripts from projects you trust.`,
      buttons: ['Run dev server', 'Not now'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response !== 0) return false
    await trust(project.root)
    return true
  }

  closeProject() {
    this.devServer?.dispose()
    this.devServer = null
    this.chat?.dispose()
    this.chat = null
    void this.inspector.clearHighlight()
    this.preview.setVisible(false)
    void this.preview.webContents.loadURL('about:blank')
    this.patch({
      project: null,
      devServer: idleDevServer(),
      preview: { ...this.state.preview, url: null, error: null, visible: false, selecting: false },
    })
  }

  // Dev server

  /** Starting from the UI is an explicit choice, so it also trusts the project. */
  startDevServer() {
    const project = this.state.project
    if (!project?.devCommand) return
    void trust(project.root)
    void this.devServer?.start(project.devCommand)
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
    let url: string
    try {
      url = new URL(input.trim(), base ?? undefined).toString()
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
    wc.on('did-navigate', (_event, url) => this.onNavigated(url))
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) this.onNavigated(url)
    })
    wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3 is ERR_ABORTED, which fires for superseded navigations.
      if (!isMainFrame || code === -3) return
      this.patchPreview({ error: `${description} — ${url}`, visible: false, loading: false })
    })
    wc.on('render-process-gone', (_event, details) => {
      this.patchPreview({ error: `The preview crashed (${details.reason}).`, visible: false })
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
      else if (/^https?:/.test(url)) void shell.openExternal(url)
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

  private onNavigated(url: string) {
    if (url === 'about:blank') return
    const history = this.preview.webContents.navigationHistory
    this.patchPreview({ url, canGoBack: history.canGoBack(), canGoForward: history.canGoForward() })
  }

  // Selection

  async toggleSelect() {
    await this.setSelecting(!this.state.preview.selecting)
  }

  async setSelecting(on: boolean) {
    // Only pick from the local app: element data is sent to the agent.
    const local = isLoopback(this.preview.webContents.getURL())
    if (on && (!this.state.preview.visible || !this.chat || !local)) return
    this.patchPreview({ selecting: on })
    try {
      await this.inspector.setInspecting(on)
      if (on) this.preview.webContents.focus()
    } catch (error) {
      console.error('[grat] inspect mode failed', error)
      this.patchPreview({ selecting: false })
    }
  }

  private async onPick(nodeId: number) {
    this.patchPreview({ selecting: false })
    const root = this.state.project?.root
    const chat = this.chat
    if (!root || !chat) return
    try {
      if (!isLoopback(this.preview.webContents.getURL())) return
      const element = await this.inspector.inspect(nodeId, root, this.devOrigin())
      chat.setSelection(element)
      await this.inspector.highlight(nodeId)
      this.focusChat()
    } catch (error) {
      console.error('[grat] element inspection failed', error)
    }
  }

  private devOrigin() {
    return this.state.devServer.url ? originOf(this.state.devServer.url) : null
  }

  // Chat

  sendChatMessage(text: string) {
    return this.chat?.send(text)
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
    this.chat?.reset()
  }

  clearSelection() {
    this.chat?.setSelection(null)
  }

  setAgent(agentId: AgentId) {
    this.patch({ agentId })
    this.chat?.setAgent(agentId)
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

    const preview = this.state.preview
    const maxWidth = VIEWPORT_WIDTH[preview.viewport]
    const width =
      maxWidth > 0 ? Math.min(maxWidth, this.canvas.width - 24) : Math.max(0, this.canvas.width)
    const x = this.canvas.x + Math.round((this.canvas.width - width) / 2)
    const inset = maxWidth > 0 ? 12 : 0
    this.preview.setBounds({
      x: Math.round(x),
      y: Math.round(this.canvas.y + inset),
      width: Math.max(0, Math.round(width)),
      height: Math.max(0, Math.round(this.canvas.height - inset * 2)),
    })
    this.preview.setVisible(preview.visible && this.canvas.width > 0)

    const showChat = this.state.chatVisible && this.hasProject
    this.chatView.setVisible(showChat)
    if (!showChat) return
    const minimized = this.chat?.meta.minimized ?? false
    const panel = minimized
      ? MINI
      : {
          width: PANEL.width,
          height: Math.min(PANEL.height, contentHeight - TOOLBAR_HEIGHT - 24),
        }
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
        click: () => url && void shell.openExternal(this.state.preview.url ?? url),
      },
    ]
    Menu.buildFromTemplate(template).popup({ window: this.win })
  }

  showAgentMenu() {
    const template: MenuItemConstructorOptions[] = [
      ...AGENTS.map(
        (agent): MenuItemConstructorOptions => ({
          label: agent.name,
          type: 'radio',
          checked: agent.id === this.state.agentId,
          click: () => this.setAgent(agent.id),
        }),
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

  private dispose() {
    if (this.disposed) return
    this.disposed = true
    windows.delete(this)
    this.devServer?.dispose()
    this.chat?.dispose()
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
function guardAppContents(wc: WebContents) {
  const openExternal = (url: string) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
  }
  wc.on('will-navigate', (event, url) => {
    if (url === wc.getURL()) return
    event.preventDefault()
    openExternal(url)
  })
  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
}

function originOf(url: string) {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

function isLoopback(url: string) {
  try {
    const { protocol, hostname } = new URL(url)
    return /^https?:$/.test(protocol) && (LOOPBACK.has(hostname) || hostname.endsWith('.localhost'))
  } catch {
    return false
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max))
}
