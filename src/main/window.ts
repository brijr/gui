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
  type WebFrameMain,
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
import { agentHealth } from './agent-status'
import { ChatController } from './chat'
import { Checkpoints } from './checkpoints'
import { DevServer } from './dev-server'
import { historyFile, loadHistory } from './history'
import { Inspector } from './inspector'
import { isLoopback } from './loopback'
import { type RunningMcpServer, startMcpServer } from './mcp-server'
import { getPrefs, setPrefs } from './prefs'
import { PreviewTools } from './preview-tools'
import { Problems } from './problems'
import { detectProject } from './project'
import { addRecent, loadRecent } from './recent'
import { getShellEnv } from './shell-env'
import { isTrusted, trust } from './trust'

const TOOLBAR_HEIGHT = 44
const PANEL = { width: 400, height: 640 }
const MINI = { width: 248, height: 52 }
const DOCK_WIDTH = 400
/** Wait for hot reload to apply before re-finding the element a turn edited. */
const REHIGHLIGHT_DELAY_MS = 900
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
  private mcp: RunningMcpServer | null = null
  private readonly problems = new Problems()
  /** Selection shown in the chat last time meta changed, to clear the highlight only when it goes away. */
  private shownSelectionId: string | null = null
  private canvas: Rect = { x: 0, y: 0, width: 0, height: 0 }
  /** Panel position, anchored to the window's right edge so it tracks resizes. */
  private anchor = { fromRight: 12, top: TOOLBAR_HEIGHT + 4 }
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
      const [project, env, saved] = await Promise.all([
        detectProject(root),
        getShellEnv(),
        loadHistory(file),
      ])
      if (!current()) return

      const tools = new PreviewTools({
        wc: this.preview.webContents,
        inspector: this.inspector,
        problems: this.problems,
        projectRoot: () => this.state.project?.root ?? null,
        devOrigin: () => this.devOrigin(),
        currentUrl: () => this.state.preview.url,
        navigate: (url) => this.loadPreview(url),
        logs: () => this.getLogs(),
      })
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
            void this.highlightSelector(selector)
          }, REHIGHLIGHT_DELAY_MS)
        }
      })
      this.chat = chat
      this.patch({ agentId: chat.meta.agentId })
      this.sendChat(Events.chatReset, chat.snapshot())

      const devServer = new DevServer(root)
      devServer.on('data', (chunk) => this.send(Events.logs, chunk))
      devServer.on('line', (line) => this.problems.addServerLine(line))
      devServer.on('change', (state) => this.onDevServer(state))
      devServer.on('stalled', () => this.patch({ logsOpen: true }))
      this.devServer = devServer

      this.win.setTitle(project.name)
      this.win.setRepresentedFilename(root)
      this.patch({ project, devServer: devServer.state, logsOpen: !project.devCommand })
      this.layout()

      const recent = await addRecent({ root, name: project.name })
      if (!current()) return
      this.patch({ recent })
      if (project.devCommand && (await this.confirmDevScript(project)) && current()) {
        void devServer.start(project.devCommand)
      }
    } finally {
      if (generation === this.openGeneration) this.opening = null
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
    this.cancelRehighlight()
    this.devServer?.dispose()
    this.devServer = null
    this.chat?.dispose()
    this.chat = null
    this.mcp?.close()
    this.mcp = null
    this.problems.clear()
    void this.inspector.clearHighlight()
    this.preview.setVisible(false)
    this.preview.webContents.loadURL('about:blank').catch(() => undefined)
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
    const root = this.state.project?.root
    const chat = this.chat
    if (!root || !chat || !isLoopback(this.preview.webContents.getURL())) return
    try {
      const element = await this.inspector.inspect(nodeId, root, this.devOrigin())
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

  private devOrigin() {
    return this.state.devServer.url ? originOf(this.state.devServer.url) : null
  }

  // Chat

  sendChatMessage(text: string) {
    return this.chat?.send(text) ?? false
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
    const area = docked
      ? { ...this.canvas, width: Math.max(0, this.canvas.width - DOCK_WIDTH) }
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
        x: Math.round(this.canvas.x + this.canvas.width - DOCK_WIDTH),
        y: Math.round(this.canvas.y),
        width: DOCK_WIDTH,
        height: Math.max(0, Math.round(this.canvas.height)),
      })
      return
    }
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

  showAgentMenu() {
    const template: MenuItemConstructorOptions[] = [
      ...AGENTS.map((agent): MenuItemConstructorOptions => {
        const health = this.state.agents.find((h) => h.id === agent.id)
        const note =
          health?.status === 'signed-out'
            ? 'Not signed in'
            : health?.status === 'error'
              ? 'Unavailable'
              : undefined
        return {
          label: agent.name,
          sublabel: note,
          type: 'radio',
          checked: agent.id === this.state.agentId,
          click: () => this.setAgent(agent.id),
        }
      }),
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
function guardAppContents(wc: WebContents) {
  const openExternal = (url: string) => {
    if (/^https?:/.test(url)) shell.openExternal(url).catch(() => undefined)
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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max))
}
