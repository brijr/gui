import { randomUUID } from 'node:crypto'
import { type FSWatcher, watch } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, posix } from 'node:path'
import {
  app,
  ClipboardItem,
  clipboard,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
  nativeImage,
  screen,
  shell,
  type WebContents,
  WebContentsView,
  type WebFrameMain,
} from 'electron'
import {
  type BoardCamera,
  exportPaths,
  FRAME_PRESETS,
  type FramePreset,
  frameId,
} from '../shared/board'
import { type ChatMenuChoice, Events } from '../shared/ipc'
import { reviewTitle } from '../shared/review'
import { SHORTCUTS } from '../shared/shortcuts'
import type { SourceControlRequest } from '../shared/source-control'
import {
  type AgentId,
  agentName,
  type ChatForm,
  type ChatGrab,
  type ChatSnapshot,
  type DevServerState,
  type DrawerState,
  type DrawerTab,
  drawerNeighbor,
  type ImageAttachment,
  isRegion,
  isTerminalId,
  type MorphKind,
  type NodeSetup,
  type PanelEdge,
  type Picked,
  type Point,
  type PreviewState,
  type ProjectInfo,
  type ProjectSetup,
  type Proposal,
  primaryPick,
  type RecentBoard,
  type RecentProject,
  type Rect,
  type RegionContext,
  type ShipDraft,
  type ShipInfo,
  type ShipRequest,
  type ShipResult,
  type StartCommandInput,
  type TabStatus,
  type TerminalId,
  VIEWPORTS,
  type Viewport,
  type ViewportFrame,
  viewportSpec,
  type WorkspaceApp,
} from '../shared/types'
import { agentHealth } from './agent-status'
import { agentMenuItems } from './agents'
import { isAutoApprove, setAutoApprove as saveAutoApprove } from './auto-approve'
import { boardIdOf, listBoards } from './board'
import { BoardSession } from './board-session'
import { createBoardTools } from './board-tool-workflow'
import { availableModels, ChatController } from './chat'
import { Checkpoints } from './checkpoints'
import { DevServer } from './dev-server'
import { type DeveloperToolsStatus, developerTools } from './developer-tools'
import { withGitMutation } from './git'
import {
  chatReferences,
  claimHistoryFile,
  listArchived,
  loadHistory,
  releaseHistoryFile,
  removeArchived,
  renameArchived,
  retireHistoryFile,
} from './history'
import { Inspector } from './inspector'
import { isLoopback } from './loopback'
import { describeSourceControl, describeTurns, describeVersions } from './mcp-app-tools'
import { startMcpServer } from './mcp-server'
import { nodeRuntime } from './node-runtime'
import { type Outlined, Picker } from './picker'
import { getPrefs, setPrefs } from './prefs'
import { PreviewMorph } from './preview-morph'
import { PreviewTools } from './preview-tools'
import { Problems } from './problems'
import { execFile } from './process'
import { detectProject, readPackageJson } from './project'
import { retireProject, waitForRetiredProject } from './project-handoff'
import { ProjectResources } from './project-resources'
import type { PromptBoard, PromptViewport } from './prompt'
import {
  bringInLatest,
  CONFLICT_PROMPT_START,
  cancelMerge,
  conflictPrompt,
  finishMerge,
  readProposal,
  startFresh,
} from './proposal'
import { addRecent, loadRecent, recentSoFar, withChats } from './recent'
import { RecordingTrace } from './recording-trace'
import { Recordings } from './recordings'
import { guardAppContents, loadRenderer, PRELOAD, PREVIEW_PRELOAD } from './renderer'
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
import {
  inRepository,
  type ShipActions,
  ship,
  shipInfo,
  startWorkBranch,
  workBranchChoice,
} from './ship'
import { sourceControl } from './source-control'
import { resolveProject, saveStartCommand, validateStartCommand } from './start-commands'
import { describeServer, logTail, startupFailure, startupReport } from './startup'
import { PREVIEW_PARTITION } from './storage'
import { ChatPanel, type ChatPanelOwner } from './tab-chat-panel'
import {
  appRoot,
  cancelledShipInfo,
  chatImage,
  frameError,
  inCanvas,
  originOf,
  previewFrame,
  screenshotName,
  shownTools,
  sourceInProject,
} from './tab-helpers'
import type { TabHost, TabState } from './tab-host'
import { Terminals } from './terminals'
import { collapseText, rewriteText } from './text-edit'
import { thumbnail } from './thumbnail'
import { askToTrust, isTrusted, promptName, promptText, trust } from './trust'
import { placePreview, ViewportEmulation, type Zoom, zoomed } from './viewport'
import { focusWindow } from './window-presentation'

export type { TabHost, TabState } from './tab-host'

/** Wait for hot reload to apply before re-finding the element a turn edited. */
const REHIGHLIGHT_DELAY_MS = 900
/** The id a pick goes by in the overlay while it's read, before it has its own */
const PENDING_PICK = 'pending'
/** How long dev_server_restart waits for the app; agents give up on a tool call after about a minute. */
const AGENT_START_WAIT_MS = 45_000
/** How long the walkthrough's pointer takes to glide to an input's target (the overlay's too) */
const GUIDE_GLIDE_MS = 650
/** The walkthrough's last step stays this long after the agent's turn ends */
const GUIDE_LINGER_MS = 5000
/** How much of the dev server's output the agent's dev server tools return */
const AGENT_LOG_LINES = 60
/** A package.json being written fires several changes; look once they've settled. */
const APP_CHECK_DELAY_MS = 500
/** What the dev server tools tell the agent in a canvas, which has none. */
const BOARD_SERVER_STATUS =
  'This is a canvas: Gui serves its frames itself and there is no dev server to start, restart or configure. Use the canvas tools.'
/** Frames export at this device scale factor: as sharp as on a Retina display. */
const FRAME_EXPORT_SCALE = 2
/** Package scripts an install runs from the project's own package.json. */
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

type ScreenshotAction = 'copy' | 'copy-full-page' | 'save' | 'attach'
type ScreenshotResult = 'copied' | 'saved' | 'attached'

let lastTabId = 0

const idleDevServer = (): DevServerState => ({
  status: 'idle',
  command: null,
  url: null,
  exitCode: null,
  lastLine: '',
  slow: false,
})

const closedDrawer = (): DrawerState => ({ open: false, tab: null, terminals: [] })

/** A canvas as the tab's project: its folder and name, and nothing to run. */
const boardProject = (root: string, name: string): ProjectInfo => ({
  root,
  name,
  packageManager: 'npm',
  devCommand: null,
  devScript: null,
  appDir: null,
  custom: null,
})

/**
 * One project in a window's tab: its preview and chat views, dev server, terminals, agent,
 * inspector, preview tools and problems, plus where its chat panel sits. Only the window's
 * active tab has its views in the window; the others keep running out of sight.
 */
export class ProjectTab implements ChatPanelOwner {
  readonly id = `tab-${++lastTabId}`
  host: TabHost
  private readonly preview: WebContentsView
  readonly chatView: WebContentsView
  private readonly inspector: Inspector
  /** The page at its viewport's size: a device frame's or zoomed Desktop's; none at 100%. */
  private readonly emulation: ViewportEmulation
  /** Each viewport's zoom, Desktop's at 100% and the frames fitting until the user zooms. */
  private zooms: Record<Viewport, Zoom> = { desktop: 1, laptop: null, tablet: null, mobile: null }
  /** Resizes the live preview into a new layout, like a window being resized (preview-morph.ts). */
  readonly morph: PreviewMorph
  private readonly panel: ChatPanel
  /**
   * Where the preview is laid out, in the window: the view's bounds, except mid-morph, when
   * the view is out of sight. What picks, the chat's dodge and prompts measure against.
   */
  private placement: Rect = { x: 0, y: 0, width: 0, height: 0 }
  state: TabState
  resources = this.createProjectResources()

  private createProjectResources() {
    return new ProjectResources({
      release: releaseHistoryFile,
      retire: retireHistoryFile,
    })
  }

  get recordings() {
    return this.resources.recordings
  }

  get recordingSource() {
    return this.preview.webContents.mainFrame
  }

  /** Traces what happens in the preview while it's recorded (recording-trace.ts). */
  traceRecording() {
    const contents = this.preview.webContents
    const trace = new RecordingTrace(contents)
    const onStart = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) void trace.navigating()
    }
    const onLoad = () => trace.navigated(contents.getURL())
    contents.on('did-start-navigation', onStart)
    contents.on('dom-ready', onLoad)
    const detach = () => {
      if (contents.isDestroyed()) return
      contents.off('did-start-navigation', onStart)
      contents.off('dom-ready', onLoad)
    }
    return {
      finish: async (startedAt: number, durationMs: number) => {
        detach()
        return trace.finish(startedAt, durationMs)
      },
      dispose: () => {
        detach()
        trace.dispose()
      },
    }
  }

  attachRecording(recording: import('../shared/types').RecordingAttachment) {
    if (!this.resources.chat) return
    this.sendChat(Events.recordingAttach, recording)
    focusWindow(this.panel.popoutWindow ?? this.host.win)
    this.panel.focusChat()
  }
  private readonly problems = new Problems()
  /** Picking over the preview: the overlay Gui draws it in, over the page. */
  private readonly picker: Picker
  /** Each picked element's node (by pick id), to outline it; an area has none. */
  private readonly pickedNodes = new Map<string, number>()
  /** What's being read for a pick in progress, outlined meanwhile */
  private pendingPick: Outlined | null = null
  /** Picks are read one at a time, in the order the user made them. */
  private pickTail: Promise<void> = Promise.resolve()
  /** The pick the page highlights while the user isn't picking (`syncHighlight`) */
  private highlightedPick: string | null = null
  /** The pick whose chip the pointer is over in the composer */
  private hoveredPick: string | null = null
  /** Text double-clicked in the page and being edited there (`startTextEdit`) */
  private textEdit: { id: string; before: string; node: Promise<number | null> } | null = null
  /** The screenshot menu is open or its capture is running. */
  private screenshotting = false
  /** "Create pull request" has the chat, and ⌘↩ with it (`permissionAnswer`). */
  private shipSheetOpen = false
  /** source_control_propose's draft, held until the agent's turn ends */
  private shipProposal: ShipDraft | null = null
  /** The project whose Git the user said Not Now to when sending; not asked again this tab. */
  private gitDeclined: string | null = null
  disposed = false
  private opening: string | null = null
  /** Pending "after" capture and re-highlight of the element a finished turn edited. */
  private rehighlightTimer: NodeJS.Timeout | null = null
  /** Ends the agent's walkthrough a little after its turn did */
  private guideEndTimer: NodeJS.Timeout | null = null
  /**
   * The preview's current page is Chromium's error page for a load that failed. It fires
   * dom-ready like any page, which must not take the failure back.
   */
  private loadFailed = false
  /** The view that had the keyboard when the preview's page started loading (`keepKeyboard`). */
  private keyboardBeforeLoad: WebContents | null = null
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
  /** On a project with nothing to start yet (a new one): watches for its package.json. */
  private appWatcher: FSWatcher | null = null
  private appCheckTimer: NodeJS.Timeout | null = null
  /** When the agent last got the app going again itself (dev_server_restart, set_start_command) */
  private agentRestartedAt = 0
  /** Getting the app going again from the top (`retryStartup`), so it runs once at a time */
  private retrying: Promise<void> | null = null

  constructor(host: TabHost) {
    this.host = host
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
        frame: null,
        zoom: 1,
        selecting: false,
        selectable: false,
        visible: false,
      },
      agentId: getPrefs().agentId,
      chatVisible: true,
      sidebarWidth: 0,
      sidebarSide: getPrefs().chatSidebarSide,
      drawer: closedDrawer(),
      recent: recentSoFar(),
      home: app.getPath('home'),
      agents: agentHealth.list(),
      setup: null,
      developerTools: shownTools(developerTools.state),
      board: null,
      recentBoards: null,
    }

    this.preview = new WebContentsView({
      webPreferences: {
        preload: PREVIEW_PRELOAD,
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

    this.inspector = new Inspector(this.preview.webContents, () => this.emulation.scale)
    this.emulation = new ViewportEmulation(this.inspector)
    this.morph = new PreviewMorph({
      window: () => this.host.win,
      send: (event) => this.send(Events.morph, event),
      layout: () => this.layout(),
      apply: ({ rect, emulation }) => {
        this.preview.setBounds(rect)
        this.emulation.set(emulation)
      },
      moving: (reduced) => this.panel.slideDock(reduced),
      ended: () => this.panel.landDock(),
    })
    this.panel = new ChatPanel(this)
    this.picker = new Picker(this.preview.webContents, this.inspector, () => this.emulation.scale)
    this.problems.on('change', (problems) => this.resources.chat?.setProblems(problems))
    agentHealth.on('change', this.onAgentHealth)
    nodeRuntime.on('change', this.onNodeRuntime)
    developerTools.on('change', this.onDeveloperTools)

    this.bindPreview()
    guardAppContents(this.chatView.webContents)
    // A reloaded chat page starts from what main tells it next.
    this.chatView.webContents.on('did-start-loading', () => {
      this.panel.clearFloatShown()
    })
    // The keyboard leaving the floating panel tucks it away; coming back (a click on the
    // bubble, ⌘L) brings it out.
    this.chatView.webContents.on('blur', () => this.panel.scheduleTuck())
    this.chatView.webContents.on('focus', () => this.panel.untuck())
    loadRenderer(this.chatView.webContents, 'chat').catch((error) =>
      console.error('[gui] failed to load chat', error),
    )
    void loadRecent()
      .then(withChats)
      .then((recent) => this.patch({ recent }))
    void listBoards().then((recentBoards) => this.patch({ recentBoards }))
  }

  /** The page in this tab's preview, which only its own preload speaks for. */
  ownsPreview(wc: WebContents) {
    return wc === this.preview.webContents
  }

  /** The chat panel is the tab's own page; the chrome belongs to the window. */
  owns(wc: WebContents) {
    return wc === this.chatView.webContents || this.picker.owns(wc)
  }

  /** The tab strip's name for it: the project's, or the folder opening; null on the start screen. */
  get title() {
    return this.state.project?.name ?? (this.opening ? basename(this.opening) : null)
  }

  /** What the tab strip shows next to the name; a waiting permission card comes first. */
  get status(): TabStatus {
    if (this.resources.chat?.awaitingPermission) return 'attention'
    if (this.resources.chat?.turnRunning) return 'working'
    const { devServer, setup } = this.state
    const crashed = devServer.status === 'exited' && devServer.exitCode !== 0
    const failed = this.resources.chat?.meta.status === 'error' || setup?.dependencies === 'failed'
    return crashed || failed ? 'error' : 'idle'
  }

  /** Puts the tab's views in its window, over the chrome, and lays them out. */
  activate() {
    const { contentView } = this.host.win
    contentView.addChildView(this.preview)
    contentView.addChildView(this.picker.view)
    // Popped out, the chat is in its own window, which shows again with its tab.
    if (this.panel.popoutWindow) this.panel.popoutWindow.showInactive()
    else contentView.addChildView(this.chatView)
    this.layout()
    // A permission card that came up in the background is what the user switched here for
    // (in a focused window: focusing the chat would raise it).
    if (this.resources.chat?.awaitingPermission && this.host.win.isFocused()) this.panel.focusChat()
  }

  /**
   * Takes the tab's views out of the window. The page, the agent and the dev server keep
   * running; only picking an element, which needs the page on screen, ends.
   */
  deactivate() {
    if (this.state.preview.selecting) void this.setSelecting(false)
    // A morph of the preview ends too, in its new layout, with the docked chat in its place
    // (the view is placed again when the tab is back).
    this.morph.finish(false)
    this.panel.deactivate()
    const { contentView } = this.host.win
    contentView.removeChildView(this.preview)
    contentView.removeChildView(this.picker.view)
    // A background tab's popped-out chat hides, so the one in sight is the tab in sight's.
    if (this.panel.popoutWindow) this.panel.popoutWindow.hide()
    else contentView.removeChildView(this.chatView)
    this.syncDrawerOutput()
  }

  /** Hands the tab to another window; its views are already out of the old one. */
  moveTo(host: TabHost) {
    this.host = host
  }

  getState() {
    return this.state
  }

  setRecent(recent: RecentProject[]) {
    this.patch({ recent })
  }

  setRecentBoards(recentBoards: RecentBoard[]) {
    this.patch({ recentBoards })
  }

  getLogs() {
    return this.resources.devServer?.logs() ?? ''
  }

  /** The dev server's output, for the drawer to draw it from. */
  /** Where the floating chat covers the canvas, for the board to fit its frames around it. */
  chatCover() {
    return this.panel.coverRect()
  }

  logsOutput() {
    return this.resources.devServer?.output.snapshot()
  }

  getChat(): ChatSnapshot {
    if (this.resources.chat) return { ...this.resources.chat.snapshot(), float: this.panel.float() }
    return {
      meta: {
        agentId: this.state.agentId,
        agentName: agentName(this.state.agentId),
        models: availableModels(this.state.agentId),
        status: 'idle',
        error: null,
        errorDetail: null,
        agent: agentHealth.list().find((agent) => agent.id === this.state.agentId) ?? null,
        modeName: null,
        modeFollowsPolicy: false,
        commands: [],
        selection: [],
        selectionError: null,
        selecting: this.state.preview.selecting,
        canSelect: this.canSelect,
        canvas: !!this.resources.board,
        minimized: false,
        docked: getPrefs().chatSidebar,
        sidebarSide: getPrefs().chatSidebarSide,
        trafficLights: false,
        tabRow: false,
        popped: false,
        redoTurnIds: [],
        archived: null,
        problems: [],
        queue: [],
        queuePaused: false,
        queuePauseReason: null,
        autoApprove: this.projectRoot === null || isAutoApprove(this.projectRoot),
      },
      turns: [],
      float: this.panel.float(),
    }
  }

  /** True as soon as a project starts opening, so a second open goes to a new tab. */
  get hasProject() {
    return this.state.project !== null || this.opening !== null
  }

  /** Root of the project open in (or opening in) this tab. */
  get projectRoot() {
    return this.state.project?.root ?? this.opening
  }

  async openProject(root: string) {
    const closed = this.closeProject()
    if (this.disposed) return
    this.opening = root
    const resources = this.createProjectResources()
    this.resources = resources
    const generation = resources.generation
    const current = () => !this.disposed && resources.stillCurrent(generation)
    let file: string | null = null
    try {
      await Promise.all([closed, waitForRetiredProject(root)])
      if (!current()) return
      file = await claimHistoryFile(root)
      if (!resources.claim(file) || !current()) return
      const [{ project, apps, choosing }, env, saved] = await Promise.all([
        resolveProject(root, getPrefs().apps[root] ?? null),
        getShellEnv(),
        loadHistory(file),
      ])
      // Several apps and none picked yet: nothing runs until the user chooses one.
      const setup = await detectSetup(project, choosing ? apps : null)
      if (!current()) return

      if (!(await this.attachChat(root, file, saved, env, resources, current, null))) return

      // The agent, checkpoints and history stay at the root; only the dev server moves into the app.
      const devServer = new DevServer(appRoot(project))
      devServer.on('data', (chunk) => this.send(Events.logs, chunk))
      devServer.on('line', (line) => this.problems.addServerLine(line))
      devServer.on('change', (state) => this.onDevServer(state))
      this.resources.devServer = devServer
      this.apps = apps

      // At the root, like the agent: a monorepo's app is a `cd` away.
      const terminals = new Terminals(project.root)
      terminals.on('data', (output) => this.send(Events.terminalData, output))
      terminals.on('change', () => this.patchDrawer({ terminals: terminals.list() }))
      this.resources.terminals = terminals

      this.patch({
        project,
        setup,
        devServer: devServer.state,
        drawer: closedDrawer(),
      })
      this.layout()

      if (!project.devCommand && !choosing) this.watchForApp(project.root)

      const recent = await withChats(await addRecent({ root, name: project.name }))
      if (!current()) return
      this.host.shareRecent(recent)
      void this.setUpAndStart()
    } catch (error) {
      // A failed setup must not leave a hidden chat or server running. A superseded
      // opening disposes only its own lifetime, never the replacement project's UI.
      if (current()) this.closeProject()
      else void resources.dispose()
      throw error
    } finally {
      if (this.resources === resources) this.opening = null
      // Failed or superseded openings share the same disposal path as normal close.
      if (!resources.historyFile) resources.dispose()
    }
  }

  /**
   * A canvas (main/board.ts) in this tab: its board, its chat, and its frames in the preview
   * one at a time. Nothing runs but the agent: no dev server, terminals or install.
   */
  async openBoard(root: string) {
    const id = boardIdOf(root)
    if (!id) throw new Error('That folder is not one of Gui’s canvases.')
    const closed = this.closeProject()
    if (this.disposed) return
    this.opening = root
    const resources = this.createProjectResources()
    this.resources = resources
    const generation = resources.generation
    const current = () => !this.disposed && resources.stillCurrent(generation)
    try {
      await Promise.all([closed, waitForRetiredProject(root)])
      if (!current()) return
      const file = await claimHistoryFile(root)
      if (!resources.claim(file) || !current()) return
      const board = new BoardSession(root, id)
      resources.board = board
      const [env, saved] = await Promise.all([getShellEnv(), loadHistory(file), board.open()])
      if (!current()) return
      board.on('change', () => {
        if (this.resources.board === board) this.syncBoard()
      })
      board.on('frameChanged', (frame) => {
        // A page has no hot reload: the one in sight loads again as it's rewritten.
        if (this.resources.board === board && board.openId === frame && this.state.preview.url)
          this.preview.webContents.reload()
      })
      if (!(await this.attachChat(root, file, saved, env, resources, current, board))) return
      this.patch({
        project: boardProject(root, board.name),
        setup: null,
        devServer: idleDevServer(),
        drawer: closedDrawer(),
        board: board.state(),
      })
      this.layout()
      void listBoards().then((boards) => this.host.shareBoards(boards))
    } catch (error) {
      if (current()) this.closeProject()
      else void resources.dispose()
      throw error
    } finally {
      if (this.resources === resources) this.opening = null
      if (!resources.historyFile) resources.dispose()
    }
  }

  /** The canvas open in this tab, if it's a canvas. */
  get boardSession() {
    return this.resources.board
  }

  /** The board as the chrome shows it, and the title, after the canvas changed. */
  private syncBoard() {
    const board = this.resources.board
    if (!board || !this.state.project) return
    const name = board.name
    const project =
      this.state.project.name === name ? this.state.project : { ...this.state.project, name }
    // The frame open in the preview left the board (deleted, or its turn undone).
    if (this.state.board?.open && !board.openId) this.closeFrame()
    this.patch({ board: board.state(), project })
  }

  // The canvas's board (from the chrome)

  boardSelect(ids: string[]) {
    this.resources.board?.select(ids)
  }

  boardArrange(updates: { id: string; x: number; y: number; width?: number; height?: number }[]) {
    return this.resources.board?.arrange(updates, true)
  }

  /** A frame the user adds, of a preset size, where they asked or beside what's selected. */
  async boardAddFrame(preset: FramePreset, at: { x: number; y: number } | null) {
    const board = this.resources.board
    if (!board) return
    const { name, width, height } =
      FRAME_PRESETS.find((option) => option.id === preset) ?? FRAME_PRESETS[0]
    const count = board.frames.filter((frame) => frame.name.startsWith(name)).length
    const frame = await board.create({
      name: count ? `${name} ${count + 1}` : name,
      width,
      height,
      at: at ?? undefined,
      after: [...board.selected],
    })
    board.select([frame.id])
  }

  async boardDuplicate(ids: string[]) {
    await this.resources.board?.duplicate(ids)
  }

  async boardDelete(ids: string[]) {
    await this.resources.board?.remove(ids)
  }

  async boardRenameFrame(id: string, name: string) {
    await this.resources.board?.rename(id, name)
  }

  async renameBoard(name: string) {
    const board = this.resources.board
    if (!board) return
    await board.renameBoard(name)
    this.host.shareBoards(await listBoards())
  }

  boardSetCamera(camera: BoardCamera) {
    this.resources.board?.setCamera(camera)
  }

  /** ⌘Z on the board: the user's own last board change, before any of the agent's. */
  async undoBoard() {
    const board = this.resources.board
    if (!board || board.openId) return false
    return board.undo()
  }

  /**
   * Shows a frame's page live in the preview (double-click, or the agent), sized like its
   * frame when a device viewport matches it; null goes back to the board.
   */
  async openFrame(id: string | null) {
    const board = this.resources.board
    if (!board) return
    if (id === null || !board.has(id)) {
      board.setOpen(null)
      this.closeFrame()
      return
    }
    const frame = board.frame(id)
    board.setOpen(id)
    const match = VIEWPORTS.find(
      (viewport) =>
        viewport.size?.width === frame?.width && viewport.size?.height === frame?.height,
    )
    const fits = VIEWPORTS.find((viewport) => viewport.size?.width === frame?.width)
    const viewport = (match ?? fits)?.id ?? 'desktop'
    if (viewport !== this.state.preview.viewport) this.patchPreview({ viewport })
    await this.loadPreview(board.frameUrl(id))
  }

  /** Back to the board: the preview hides and unloads, and its picking ends. */
  private closeFrame() {
    if (this.state.preview.selecting) void this.setSelecting(false)
    this.preview.setVisible(false)
    if (this.state.preview.url !== null)
      this.preview.webContents.loadURL('about:blank').catch(() => undefined)
    this.patchPreview({ url: null, error: null, visible: false, loading: false })
    void this.inspector.clearHighlight()
  }

  /** The canvas as each prompt describes it. */
  private promptBoard(): PromptBoard | null {
    const board = this.resources.board
    if (!board) return null
    return {
      name: board.name,
      frames: [...board.frames],
      sections: [...board.sections],
      selection: [...board.selected],
      open: board.openId,
    }
  }

  /**
   * The agent's side of an opening project or canvas: preview tools, recordings, Gui's MCP
   * server, checkpoints and the chat. False when the opening was superseded meanwhile.
   */
  private async attachChat(
    root: string,
    file: string,
    saved: Awaited<ReturnType<typeof loadHistory>>,
    env: Awaited<ReturnType<typeof getShellEnv>>,
    resources: ProjectResources,
    current: () => boolean,
    board: BoardSession | null,
  ) {
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
      viewScale: () => this.emulation.scale,
      restoreViewport: () => this.emulation.restore(),
      serverStatus: () => (board ? BOARD_SERVER_STATUS : describeServer(this.state)),
      restartServer: () => (board ? Promise.resolve(BOARD_SERVER_STATUS) : this.restartForAgent()),
      setStartCommand: (input) =>
        board ? Promise.resolve(BOARD_SERVER_STATUS) : this.setStartCommandForAgent(input),
      guide: (node, caption) => this.guideStep(node, caption),
      guideInput: async (at, click) => {
        if (!this.picker.guiding) return
        this.picker.guideCursor(at, click)
        await new Promise((resolve) => setTimeout(resolve, GUIDE_GLIDE_MS))
      },
    })
    this.resources.previewTools = tools
    const recordings = new Recordings(root)
    resources.recordings = recordings
    recordings.retain(
      saved?.turns.flatMap((turn) => turn.recordings?.map((clip) => clip.id) ?? []) ?? [],
    )
    void recordings
      .sweep(() => chatReferences(root).then((found) => found?.recordings ?? null))
      .catch((error: unknown) => console.error('[gui] failed to clean up recordings', error))
    const mcp = await startMcpServer(
      tools,
      recordings,
      {
        sourceControlStatus: () => this.sourceControlForAgent(),
        proposeShip: (draft) => this.proposeShipForAgent(draft),
        versions: (limit) => this.versionsForAgent(limit),
        turns: (limit) => describeTurns(this.resources.chat?.snapshot().turns ?? [], limit),
      },
      board
        ? createBoardTools(board, {
            prompt: () => this.promptBoard(),
            open: (id) => this.openFrame(id),
            live: current,
          })
        : null,
    ).catch((error: unknown) => {
      console.error('[gui] preview tools unavailable', error)
      return null
    })
    if (!resources.attachMcp(mcp) || !current()) return false

    const checkpoints = new Checkpoints(root, join(app.getPath('userData'), 'checkpoints'), env, {
      referenced: () => chatReferences(root).then((found) => found?.checkpoints ?? null),
    })
    const chat = new ChatController(root, checkpoints, {
      agentId: this.state.agentId,
      docked: getPrefs().chatSidebar,
      saved,
      historyFile: file,
      recordings,
      mcpServers: () => (resources.mcp ? [resources.mcp.config] : []),
      viewport: () => this.promptViewport(),
      board: board ? () => this.promptBoard() : undefined,
      startupReport: (tools) => startupReport(this.state, this.getLogs(), tools),
    })
    this.bindChat(chat)
    this.resources.chat = chat
    resources.attachHistory(root, file)
    chat.setCanSelect(this.canSelect)
    this.patch({ agentId: chat.meta.agentId })
    this.sendChat(Events.chatReset, chat.snapshot())
    return true
  }

  /** What the tab does as its chat changes, turns run and permission cards come up. */
  private bindChat(chat: ChatController) {
    chat.on('meta', (meta) => {
      this.sendChat(Events.chatMeta, meta)
      this.onSelection(meta.selection)
      if (meta.agentId !== this.state.agentId) this.patch({ agentId: meta.agentId })
      this.layout()
      this.host.tabChanged(this, false)
    })
    chat.on('turnUpdate', (update) => this.sendChat(Events.chatTurn, update))
    chat.on('turn', (turn) => {
      // The edited element's highlight would otherwise sit in the next turn's screenshots.
      if (turn.status === 'running') this.cancelRehighlight()
      // Working, or a permission card answered: the tab strip shows it.
      this.host.tabChanged(this, false)
    })
    chat.on('reset', (snapshot) => this.sendChat(Events.chatReset, snapshot))
    chat.on('startupFixEnd', (turn) => {
      // The agent fixed things without getting the app going again itself: Gui does.
      if (turn.status !== 'done' || this.agentRestartedAt >= turn.startedAt) return
      if (startupFailure(this.state) || this.state.devServer.status === 'idle') {
        void this.retryStartup()
      }
    })
    chat.on('attention', () => {
      this.panel.onAttention()
      this.host.tabChanged(this, false)
    })
    chat.on('turnEnd', (turn) => {
      // What the agent proposed to ship opens once it's done, for the user to review.
      const proposed = this.shipProposal
      this.shipProposal = null
      if (proposed && turn.status === 'done') this.sendChat(Events.chatShipDraft, proposed)
      // The walkthrough's last step stays a moment to be read, then gets out of the way.
      if (this.picker.guiding) {
        this.clearGuideEnd()
        this.guideEndTimer = setTimeout(() => this.endGuide(), GUIDE_LINGER_MS)
      }
      // The agent may have just set the project up; it's left alone while it works.
      if (this.appWatcher) void this.checkForApp()
      const shown = primaryPick(turn.context)
      if (turn.status === 'done' && shown && turn.changes?.length) {
        const selector = isRegion(shown) ? undefined : shown.selector
        if (this.rehighlightTimer) clearTimeout(this.rehighlightTimer)
        const generation = this.rehighlightGeneration
        this.rehighlightTimer = setTimeout(() => {
          this.rehighlightTimer = null
          // After hot reload: show how it looks now, then point at it again. A queued turn or
          // a pick that started meanwhile still gets this turn's "after", just no highlight,
          // unless that turn has already started on tools: the preview may show its changes.
          if (chat.activeTurnUsedTools()) return
          void this.captureAfter(chat, turn.id, shown).then(() => {
            if (generation === this.rehighlightGeneration) void this.highlightSelector(selector)
          })
        }, REHIGHLIGHT_DELAY_MS)
      }
    })
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
        detail: `To show your app, Gui runs its start command, ${devCommand}:\n\n${script}\n\nOnly start projects you trust. Gui won't ask again for this project.`,
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
      detail: `Gui will install dependencies (${installCommand(project.packageManager)}) and start the dev server (${devCommand}) to preview the project. ${installing}The dev server runs:\n\n${script}\n\nBoth run code from this project. Only continue with projects you trust.`,
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
      message: 'Use source control?',
      detail:
        "Gui runs Git in this project, which also runs the project's own Git hooks. Only continue for projects you trust.",
      buttons: ['Continue', 'Cancel'],
    })
  }

  /** The trust prompt; agreeing trusts the project from then on. */
  private askToTrust(root: string, options: MessageBoxOptions) {
    if (this.disposed) return Promise.resolve(false)
    return askToTrust(root, options, this.host.win)
  }

  /**
   * A project with no dev script yet, like a new empty one, gets one once the agent (or the
   * user) writes its package.json. Gui starts it then, instead of waiting for a reopen.
   */
  private watchForApp(root: string) {
    try {
      this.appWatcher = watch(root, (_event, name) => {
        if (name && name !== 'package.json') return
        if (this.appCheckTimer) clearTimeout(this.appCheckTimer)
        this.appCheckTimer = setTimeout(() => {
          this.appCheckTimer = null
          void this.checkForApp()
        }, APP_CHECK_DELAY_MS)
      })
      this.appWatcher.on('error', () => this.stopWatchingForApp())
    } catch (error) {
      console.error('[gui] could not watch the project for a dev script', error)
    }
  }

  private stopWatchingForApp() {
    this.appWatcher?.close()
    this.appWatcher = null
    if (this.appCheckTimer) clearTimeout(this.appCheckTimer)
    this.appCheckTimer = null
  }

  /**
   * Looks again for something to start. Not mid-turn: the agent is likely still writing the
   * project and installing it, and the turn's end looks again.
   */
  private async checkForApp() {
    const devServer = this.resources.devServer
    const root = this.state.project?.root
    if (!devServer || !root || this.resources.chat?.turnRunning) return
    const { project, apps, choosing } = await resolveProject(root, getPrefs().apps[root] ?? null)
    if (!project.devCommand && !choosing) return
    const setup = await detectSetup(project, choosing ? apps : null)
    if (devServer !== this.resources.devServer || !this.appWatcher) return
    this.stopWatchingForApp()
    this.apps = apps
    devServer.setCwd(appRoot(project))
    this.patch({ project, setup })
    void this.setUpAndStart()
  }

  private disposeProjectResources() {
    const root = this.projectRoot
    this.opening = null
    this.stopWatchingForApp()
    this.cancelRehighlight()
    if (this.rehighlightTimer) clearTimeout(this.rehighlightTimer)
    this.rehighlightTimer = null
    const closed = retireProject(root, this.resources.dispose())
    this.apps = []
    return closed
  }

  closeProject() {
    const closed = this.disposeProjectResources()
    this.problems.clear()
    void this.inspector.clearHighlight()
    this.preview.setVisible(false)
    // Unload the previous app, if one was ever loaded. A project opened at launch gets here
    // while the constructor's blank page is still committing; a second blank load then swaps
    // the renderer's frame, and Chromium crashes the renderer in that swap when a DevTools
    // client (Playwright at launch) is still attaching to the new page.
    if (this.state.preview.url !== null) {
      this.preview.webContents.loadURL('about:blank').catch(() => undefined)
    }
    this.patch({
      project: null,
      setup: null,
      devServer: idleDevServer(),
      drawer: closedDrawer(),
      board: null,
      preview: { ...this.state.preview, url: null, error: null, visible: false, selecting: false },
    })
    return closed
  }

  // Dev server

  /** From the UI; an untrusted project still shows its scripts and asks first. */
  startDevServer() {
    void this.setUpAndStart()
  }

  stopDevServer() {
    void this.resources.devServer?.stop()
  }

  restartDevServer() {
    if (this.resources.devServer?.state.command) void this.resources.devServer.restart()
    else this.startDevServer()
  }

  resizeLogs(cols: number, rows: number) {
    this.resources.devServer?.resize(cols, rows)
  }

  // Drawer: the dev server's output and the terminals

  /**
   * ⌘J: opens the drawer on the tab it showed last (the first time, a terminal, started now if
   * there's none yet) and puts the keyboard in it; open, closes it.
   */
  toggleDrawer() {
    const terminals = this.resources.terminals
    // A canvas has no dev server or terminals.
    if (this.resources.board) return shell.beep()
    if (!terminals) return
    // In focus mode it's hidden whatever its setting: ⌘J brings it back, with the rest.
    if (this.state.drawer.open && !this.host.focusMode) return this.setDrawerOpen(false)
    this.showDrawer(this.state.drawer.tab ?? terminals.list()[0]?.id ?? terminals.create(), true)
  }

  /** Opened, it shows the tab it showed last; the dev server's output the first time. */
  setDrawerOpen(open: boolean) {
    if (open && this.resources.board) return
    if (open) this.showDrawer(this.state.drawer.tab ?? 'server')
    else this.patchDrawer({ open: false })
  }

  /** "Show logs" (the status menu, the crash bar, the canvas's cards): the dev server's output. */
  showLogs() {
    this.showDrawer('server')
  }

  selectDrawerTab(tab: DrawerTab) {
    this.showDrawer(tab)
  }

  newTerminal() {
    const id = this.resources.terminals?.create()
    if (id) this.showDrawer(id, true)
  }

  /** Ends the terminal's shell; if it was showing, the drawer shows its neighbor instead. */
  closeTerminal(id: TerminalId) {
    const terminals = this.resources.terminals
    if (!terminals?.has(id)) return
    if (this.state.drawer.tab === id) {
      this.patchDrawer({ tab: drawerNeighbor(terminals.list(), id) })
    }
    terminals.close(id)
  }

  restartTerminal(id: TerminalId) {
    this.resources.terminals?.restart(id)
  }

  terminalOutput(id: TerminalId) {
    return this.resources.terminals?.output(id) ?? { id, data: '', end: 0 }
  }

  writeTerminal(id: TerminalId, data: string) {
    this.resources.terminals?.write(id, data)
  }

  resizeTerminal(id: TerminalId, cols: number, rows: number) {
    this.resources.terminals?.resize(id, cols, rows)
  }

  clearTerminal(id: TerminalId) {
    this.resources.terminals?.clear(id)
  }

  /** The drawer has drawn a view's output up to `end`: the dev server's, or a terminal's. */
  ackOutput(id: string, end: number) {
    if (id === this.resources.devServer?.output.id) this.resources.devServer.output.ack(end)
    else if (isTerminalId(id)) this.resources.terminals?.ack(id, end)
  }

  /**
   * Only the drawer tab on screen streams its output to the chrome: in the window's active
   * tab, with the drawer open and not hidden by focus mode. Everything else keeps running, and
   * main keeps what it prints for the drawer to catch up on when it shows it (output.ts).
   */
  private syncDrawerOutput() {
    const { open, tab } = this.state.drawer
    const onScreen = open && !this.host.focusMode && this.host.isActive(this) && !this.disposed
    const shown = onScreen ? (tab ?? 'server') : null
    this.resources.devServer?.output.setShown(shown === 'server')
    this.resources.terminals?.show(shown === 'server' ? null : shown)
  }

  /** Only a tab the drawer has: the dev server's output, or one of this project's terminals. */
  private showDrawer(tab: DrawerTab, focus = false) {
    if (!this.resources.terminals || (tab !== 'server' && !this.resources.terminals.has(tab)))
      return
    this.leaveFocusMode()
    this.patchDrawer({ open: true, tab })
    if (focus) this.focusDrawer(tab)
  }

  /** Puts the keyboard in a drawer tab, which the window's chrome draws. */
  private focusDrawer(tab: DrawerTab) {
    if (!this.host.isActive(this)) return
    // Focusing web contents also raises its window, which a background one mustn't.
    if (this.host.win.isFocused()) this.host.win.webContents.focus()
    this.send(Events.drawerFocus, tab)
  }

  private patchDrawer(patch: Partial<DrawerState>) {
    // Opening or closing it moves the canvas's edge, and the preview with it (in focus mode
    // it's hidden either way).
    const { open } = patch
    if (open !== undefined && open !== this.state.drawer.open && !this.host.focusMode) {
      this.morphLayout('drawer')
    }
    this.patch({ drawer: { ...this.state.drawer, ...patch } })
  }

  private onDevServer(state: DevServerState) {
    const wasRunning = this.state.devServer.status === 'running'
    this.patch({ devServer: state })
    if (state.status === 'running' && state.url && !wasRunning) {
      void this.loadPreview(state.url)
    } else if (state.status === 'exited') {
      // Its last page stays on screen, as after Stop, while the toolbar (and for a crash, a bar
      // under the canvas) says it won't update. Without a page, the canvas says it stopped.
      this.patchPreview({ selecting: false, loading: false })
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

  /** Reloads without the cache, for a change a normal reload keeps serving stale. */
  hardReload() {
    if (this.state.preview.url) this.preview.webContents.reloadIgnoringCache()
  }

  setViewport(viewport: Viewport) {
    if (viewport !== this.state.preview.viewport) this.morphLayout('viewport')
    this.patchPreview({ viewport })
    this.layout()
  }

  /**
   * View → Zoom In (`step` 1), Zoom Out (-1) or Actual Size (0), for the viewport shown: the
   * page, or a device frame's scale. The page keeps its CSS size either way.
   */
  zoom(step: 1 | -1 | 0) {
    // On a canvas's board, the board zooms.
    if (this.resources.board && !this.resources.board.openId) {
      this.send(Events.board, { type: 'zoom', step })
      return
    }
    const { viewport } = this.state.preview
    const next = zoomed(viewport, this.previewArea(), this.zooms[viewport], step)
    if (next === undefined) return shell.beep()
    if (next !== this.zooms[viewport]) this.morphLayout('zoom')
    this.zooms = { ...this.zooms, [viewport]: next }
    this.patchPreview({ zoom: this.zooms.desktop ?? 1 })
    this.layout()
  }

  toggleDevTools() {
    this.preview.webContents.toggleDevTools()
  }

  /**
   * Ends the window's focus mode for something that needs the chrome or the chat; only from
   * the tab it shows (a card in a background tab waits there).
   */
  leaveFocusMode() {
    if (this.host.isActive(this)) this.host.setFocusMode(false)
  }

  /** The keyboard to the page (focus mode, where Esc on it ends focus mode). */
  focusPreview() {
    this.preview.webContents.focus()
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
    wc.on('did-stop-loading', () => {
      this.keepKeyboard()
      this.keyboardBeforeLoad = null
      this.patchPreview({ loading: false })
    })
    // A new document is on its way: whatever failed before is behind it. (Same-document
    // navigations, such as HMR's and the router's, keep the page they're on.)
    wc.on('did-start-navigation', (event) => {
      if (!event.isMainFrame || event.isSameDocument) return
      this.loadFailed = false
      // An edit in place goes with its page.
      this.textEdit = null
      this.keyboardBeforeLoad = this.keyboardOwner()
    })
    // Loading a new document takes the keyboard from whichever view had it (such as the
    // chat's message box mid-sentence when hot reload falls back to a full reload), as it
    // starts and again as it commits, so it's given straight back each time. Unless the user
    // clicks into the page meanwhile: then it's theirs.
    wc.on('input-event', (_event, input) => {
      if (input.type === 'mouseDown') this.keyboardBeforeLoad = null
    })
    wc.on('focus', () => this.keepKeyboard())
    wc.on('dom-ready', () => {
      this.keepKeyboard()
      if (this.loadFailed || wc.getURL() === 'about:blank') return
      this.patchPreview({ visible: true, error: null })
    })
    wc.on('did-navigate', (_event, url) => {
      this.keepKeyboard()
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
      this.loadFailed = true
      // The address is the one that failed, which Try again (a reload) loads again.
      this.patchPreview({ url, error: `${description} — ${url}`, visible: false, loading: false })
    })
    wc.on('render-process-gone', (_event, details) => {
      this.patchPreview({
        error: `The preview crashed (${details.reason}).`,
        visible: false,
        selecting: false,
      })
    })
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape') return
      // Esc in text being edited in place puts it back; the page has it (src/preload/preview.ts).
      if (this.textEdit) return
      // Picking ends first; then focus mode. The page gets Esc once neither is on.
      if (this.state.preview.selecting) {
        event.preventDefault()
        void this.setSelecting(false)
      } else if (this.host.focusMode && this.host.isActive(this)) {
        event.preventDefault()
        this.host.setFocusMode(false)
      } else if (this.resources.board?.openId) {
        // A canvas's frame: back to the board, as in Figma's prototype view.
        event.preventDefault()
        void this.openFrame(null)
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
    const id = this.frameToPick()
    if (id) {
      await this.openFrame(id)
      await this.setSelecting(true)
      return
    }
    await this.setSelecting(!this.state.preview.selecting)
  }

  /**
   * On the board, ⌘D picks in a frame as it does in a project's preview: the one selected,
   * or the only one there is, opens live to pick in. Null when no frame is that one.
   */
  private frameToPick() {
    const board = this.resources.board
    if (!board || board.openId) return null
    if (board.selected.length === 1) return board.selected[0]
    if (!board.selected.length && board.frames.length === 1) return board.frames[0].id
    return null
  }

  async setSelecting(on: boolean) {
    if (on === this.picker.picking) return
    if (!on) {
      this.patchPreview({ selecting: false })
      return
    }
    // Only pick from the local app: what's picked is sent to the agent.
    const local = isLoopback(this.preview.webContents.getURL())
    if (!this.state.preview.visible || !this.resources.chat || !local) return
    // Picking is on the live page: a morph in progress lands at once.
    this.morph.finish()
    // The overlay outlines what's picked now; the page's own highlight would double it.
    this.cancelRehighlight()
    this.highlightedPick = null
    void this.inspector.clearHighlight()
    this.syncOutlined()
    this.picker.start(this.placement, this.cursorOverPreview())
    this.patchPreview({ selecting: true })
  }

  /**
   * A click in the overlay at `at` (its coordinates): picks the element there. On its own
   * it replaces what was picked and ends picking, as a single pick always has; with `add`
   * (⇧) it joins what's picked, or leaves it if it was picked already, and picking goes on.
   */
  pickElement(at: Point, add: boolean) {
    if (!this.picker.picking) return
    if (!add) void this.setSelecting(false)
    this.queuePick(async () => {
      const node = await this.picker.nodeAt(at)
      if (node === null) return
      const already = [...this.pickedNodes].find(([, picked]) => picked === node)?.[0]
      if (add && already) {
        this.resources.chat?.removeFromSelection(already)
        return
      }
      await this.readPick(add, { id: PENDING_PICK, kind: 'element', node }, async (project) => {
        const element = await this.inspectElement(node, project)
        this.pickedNodes.set(element.id, node)
        return { ...element, kind: 'element' }
      })
    })
  }

  /** A drag in the overlay over `rect` (its coordinates): picks that area as a screenshot. */
  pickArea(rect: Rect, add: boolean) {
    if (!this.picker.picking) return
    if (!add) void this.setSelecting(false)
    const area = this.picker.toPageRect(rect)
    this.queuePick(() =>
      this.readPick(add, { id: PENDING_PICK, kind: 'region', area, fixed: true }, (project) =>
        this.inspectArea(area, project),
      ),
    )
  }

  pickHover(at: Point | null) {
    if (this.picker.picking) this.picker.hover(at)
  }

  pickWheel(at: Point, deltaX: number, deltaY: number) {
    if (this.picker.picking || this.picker.guiding) this.picker.wheel(at, deltaX, deltaY)
  }

  // Editing the page's text in place (src/preload/preview.ts)

  /**
   * Text was double-clicked in the page, at `at` (its CSS pixels in the viewport): it may be
   * edited there when it's the app's (or a canvas frame's) and the user isn't picking. The
   * element under `at` is found now, before typing moves it. An id for the edit, or null.
   */
  startTextEdit(at: Point, before: string): string | null {
    if (!this.state.project || !this.resources.chat || this.picker.picking) return null
    if (!this.state.preview.selectable || this.textEdit) return null
    const id = randomUUID()
    this.textEdit = { id, before, node: this.inspector.nodeAt(at) }
    return id
  }

  /**
   * The edit ended, with the text as typed (null: put back, or unchanged). It's written to
   * the source when the text is there plainly, in the file that rendered the element (a
   * canvas frame's own page); otherwise the agent is asked to make the change, with the
   * element picked.
   */
  endTextEdit(id: string, after: string | null) {
    const edit = this.textEdit
    if (edit?.id !== id) return
    this.textEdit = null
    const before = collapseText(edit.before)
    if (after === null || !before || collapseText(after) === before) return
    const project = this.state.project
    const chat = this.resources.chat
    if (!project || !chat) return
    this.queuePick(async () => {
      const node = await edit.node
      const element =
        node === null
          ? null
          : await this.inspectElement(node, project, { screenshot: false }).catch(() => null)
      if (chat !== this.resources.chat) return
      const board = this.resources.board
      const file = board?.openId
        ? board.framePath(board.openId)
        : element?.source && sourceInProject(project.root, element.source.file)
      const line = board?.openId ? null : (element?.source?.line ?? null)
      // During a turn, the change would be the agent's to undo; it waits its turn instead.
      if (file && !chat.busy && (await rewriteText(file, before, after, line))) return
      // The user's own picks stay for their next message.
      const picked = chat.meta.selection
      const nodes = [...this.pickedNodes]
      if (node !== null && element) {
        this.pickedNodes.set(element.id, node)
        chat.setSelection([{ ...element, kind: 'element' }])
      }
      chat.send(`Change the text “${before}” to “${collapseText(after)}”.`)
      for (const [pick, pickNode] of nodes) this.pickedNodes.set(pick, pickNode)
      chat.setSelection(picked)
    })
  }

  // The agent's walkthrough (preview_point), drawn by the pick overlay

  /** A step, if the user can see the preview and isn't picking; whether it's shown. */
  private guideStep(node: number | null, caption: string | null) {
    if (!this.state.preview.visible || this.host.sheetShown) return false
    this.clearGuideEnd()
    return this.picker.guide(this.placement, node, caption)
  }

  /** The user clicked the walkthrough away, or it ran its course. */
  endGuide() {
    this.clearGuideEnd()
    this.picker.endGuide()
  }

  private clearGuideEnd() {
    if (this.guideEndTimer) clearTimeout(this.guideEndTimer)
    this.guideEndTimer = null
  }

  removeSelection(id: string) {
    this.resources.chat?.removeFromSelection(id)
  }

  /** The pointer is over a pick's chip in the composer: the page shows which one it is. */
  hoverSelection(id: string | null) {
    this.hoveredPick = id
    this.syncHighlight()
  }

  private queuePick(read: () => Promise<void>) {
    const run = this.pickTail.then(read)
    this.pickTail = run.catch(() => undefined)
  }

  /**
   * Reads a pick and puts it in the selection: in place of what's there, or after it with
   * `add`. `pending` is outlined meanwhile. A pick that failed says why in the composer.
   */
  private async readPick(
    add: boolean,
    pending: Outlined,
    read: (project: ProjectInfo) => Promise<Picked>,
  ) {
    const project = this.state.project
    const chat = this.resources.chat
    if (!project || !chat || !isLoopback(this.preview.webContents.getURL())) return
    this.pendingPick = pending
    this.picker.setBusy(true)
    this.syncOutlined()
    try {
      const picked = await read(project)
      if (chat !== this.resources.chat) return
      // The pick's highlight replaces any post-turn one and belongs to the selection.
      this.cancelRehighlight()
      if (add) chat.addToSelection(picked)
      else chat.setSelection([picked])
      if (!add) {
        this.panel.focusChat()
        this.panel.dodge(picked.rect, this.placement, this.emulation.scale)
      }
    } catch (error) {
      if (chat !== this.resources.chat) return
      const message = error instanceof Error ? error.message : String(error)
      const what = pending.kind === 'region' ? 'area' : 'element'
      chat.setSelectionError(`Couldn't read that ${what}: ${message}`)
      if (!add) this.panel.focusChat()
    } finally {
      this.pendingPick = null
      this.picker.setBusy(false)
      this.syncOutlined()
      // Reading took the page's highlight down (for the crop); put back what belongs there.
      this.highlightedPick = null
      this.syncHighlight()
    }
  }

  /** A screenshot of the area (CSS pixels in the viewport) and the element around it. */
  private async inspectArea(area: Rect, project: ProjectInfo): Promise<RegionContext> {
    const { viewport, shot } = await this.inspector.captureArea(area)
    if (!shot) throw new Error('it has no size on the page')
    const node = await this.inspector.containerOf(area)
    const element =
      node === null
        ? null
        : await this.inspectElement(node, project, { screenshot: false }).catch(() => null)
    return {
      kind: 'region',
      id: randomUUID(),
      url: this.preview.webContents.getURL(),
      viewport,
      rect: area,
      screenshot: shot.dataUrl,
      crop: shot.crop,
      container: element && {
        tag: element.tag,
        selector: element.selector,
        componentStack: element.componentStack,
        source: element.source,
      },
    }
  }

  /**
   * Where the pointer is over the preview (its coordinates), so picking outlines what's under
   * it at once, without waiting for it to move; null when it's elsewhere.
   */
  private cursorOverPreview(): Point | null {
    const cursor = screen.getCursorScreenPoint()
    const content = this.host.win.getContentBounds()
    const { x, y, width, height } = this.placement
    const at = { x: cursor.x - content.x - x, y: cursor.y - content.y - y }
    return at.x >= 0 && at.y >= 0 && at.x < width && at.y < height ? at : null
  }

  /** The selection changed: its outlines, and the page's highlight, follow it. */
  private onSelection(selection: Picked[]) {
    const ids = new Set(selection.map((picked) => picked.id))
    for (const id of this.pickedNodes.keys()) if (!ids.has(id)) this.pickedNodes.delete(id)
    if (this.hoveredPick && !ids.has(this.hoveredPick)) this.hoveredPick = null
    this.syncOutlined()
    this.syncHighlight()
  }

  /** What the overlay outlines while the user picks: the selection, and a pick being read. */
  private syncOutlined() {
    const outlined = (this.resources.chat?.meta.selection ?? []).flatMap((picked): Outlined[] => {
      if (isRegion(picked)) {
        return picked.crop ? [{ id: picked.id, kind: 'region', area: picked.crop.area }] : []
      }
      const node = this.pickedNodes.get(picked.id)
      return node === undefined ? [] : [{ id: picked.id, kind: 'element', node }]
    })
    if (this.pendingPick) outlined.push(this.pendingPick)
    this.picker.setOutlined(outlined)
  }

  /**
   * Outside picking, the page highlights the pick the chat is about: the one whose chip the
   * pointer is over, else the element picked last. Areas only while their chip is hovered.
   * Nothing picked, the highlight goes (a post-turn re-highlight is left alone).
   */
  private syncHighlight() {
    if (this.picker.picking) return
    const selection = this.resources.chat?.meta.selection ?? []
    const target =
      selection.find((picked) => picked.id === this.hoveredPick) ??
      selection.findLast((picked) => !isRegion(picked) && this.pickedNodes.has(picked.id))
    const id = target?.id ?? null
    if (id === this.highlightedPick) return
    const had = this.highlightedPick
    this.highlightedPick = id
    if (!target) {
      if (had) void this.inspector.clearHighlight()
      return
    }
    if (isRegion(target)) {
      if (target.crop) void this.inspector.highlightArea(target.crop.area).catch(() => undefined)
      return
    }
    const node = this.pickedNodes.get(target.id)
    // It can wait behind an agent screenshot, and a node gone after hot reload doesn't undo
    // the pick.
    if (node !== undefined) void this.inspector.highlight(node).catch(() => undefined)
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

  /**
   * The viewport named in each prompt: a device frame's size, or the preview's (Desktop), in
   * CSS pixels at its zoom.
   */
  private promptViewport(): PromptViewport | null {
    // On a canvas's board there's no page in sight; the canvas block says what is.
    if (this.resources.board && !this.resources.board.openId) return null
    const { name, size } = viewportSpec(this.state.preview.viewport)
    if (size) return { name, ...size, fixed: true }
    const zoom = this.zooms.desktop ?? 1
    const { width, height } = this.placement
    return {
      name,
      width: Math.round(width / zoom),
      height: Math.round(height / zoom),
      fixed: false,
    }
  }

  private devOrigin() {
    if (this.resources.board) return this.resources.board.origin
    return this.state.devServer.url ? originOf(this.state.devServer.url) : null
  }

  // Chat

  async sendChatMessage(
    text: string,
    images: ImageAttachment[],
    ids: string[] = [],
    followUp: string | null = null,
  ) {
    const recordings = this.recordings
    const chat = this.resources.chat
    if (!chat || !recordings) return false
    try {
      const clips = await recordings.attachments(ids)
      if (this.resources.chat !== chat) return false
      const accepted = chat.send(text, images, clips, followUp)
      if (accepted) recordings.retain(ids)
      return accepted
    } catch {
      return false
    }
  }

  /** The composer's message; on a shared branch like main, the user first picks a branch. */
  async sendFromComposer(
    text: string,
    images: ImageAttachment[],
    ids: string[],
    followUp: string | null,
  ) {
    if (!(await this.chooseWorkBranch(text))) return false
    return this.sendChatMessage(text, images, ids, followUp)
  }

  /** Trust to run Git, so it can check the branch before the agent edits. */
  private confirmBranchCheck(root: string) {
    return this.askToTrust(root, {
      message: 'Use source control?',
      detail:
        "Before the agent edits files, Gui checks whether this project is on its main branch so it can offer a separate one. Gui runs Git in this project, which also runs the project's own Git hooks. Only continue for projects you trust.",
      buttons: ['Continue', 'Not Now'],
    })
  }

  /**
   * The agent edits the checked-out files, so a commit from a terminal lands on whatever
   * branch that is. On a shared branch, asks once whether to move to a new Gui branch;
   * staying is remembered for the project. False keeps the draft: cancelled, or failed.
   */
  private async chooseWorkBranch(prompt: string) {
    const root = this.state.project?.root
    // A busy chat queues the message; the branch was settled when its turn started.
    if (!root || !this.resources.chat || this.resources.chat.busy) return true
    if (getPrefs().defaultBranchRoots.includes(root) || this.gitDeclined === root) return true
    if (!(await isTrusted(root))) {
      // Not a repository: nothing to ask about, and `git init` later should still be asked.
      if (!(await inRepository(root)) || this.state.project?.root !== root) return true
      if (!(await this.confirmBranchCheck(root))) {
        this.gitDeclined = root
        return true
      }
    }
    if (this.resources.chat?.busy) return true
    const choice = await workBranchChoice(root, prompt)
    if (!choice || this.disposed || this.state.project?.root !== root) return true
    const current = promptName(choice.current)
    const owner = this.panel.popoutWindow ?? this.host.win
    const { response } = await dialog.showMessageBox(owner, {
      type: 'question',
      message: `Work on a new branch instead of ${current}?`,
      detail: `Gui edits the files checked out here, so commits made from a terminal go to ${current}. A new branch leaves ${current} as it is until you merge.\n\nIf you stay on ${current}, Gui won’t ask again for this project.`,
      buttons: [`Create ${choice.suggested}`, `Stay on ${current}`, 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    if (response === 2 || this.disposed || this.state.project?.root !== root) return false
    if (response === 1) {
      const roots = getPrefs().defaultBranchRoots
      if (!roots.includes(root)) setPrefs({ defaultBranchRoots: [...roots, root] })
      return true
    }
    try {
      await startWorkBranch(root, choice.current, choice.suggested)
      return true
    } catch (error) {
      if (!owner.isDestroyed())
        await dialog.showMessageBox(owner, {
          type: 'warning',
          message: `Couldn’t create ${choice.suggested}`,
          detail: error instanceof Error ? error.message : String(error),
          buttons: ['OK'],
          noLink: true,
        })
      return false
    }
  }

  // Shipping (src/main/ship.ts)

  async getShipInfo(): Promise<ShipInfo | null> {
    const root = this.state.project?.root
    const chat = this.resources.chat
    if (!root) return null
    if (!(await this.confirmGit(root))) return cancelledShipInfo()
    if (this.state.project?.root !== root) return null
    const prompts = (chat?.snapshot().turns ?? [])
      .filter((turn) => turn.status === 'done' && !turn.reverted)
      .map((turn) => turn.prompt)
      .filter((prompt) => !prompt.startsWith(CONFLICT_PROMPT_START))
      .map((prompt) => reviewTitle(prompt) ?? prompt)
    const info = await shipInfo(root, prompts)
    if (this.disposed || this.state.project?.root !== root) return null
    if (this.resources.chat?.busy && info.workspace)
      return {
        ...info,
        workspace: { ...info.workspace, writeBlocked: 'Wait for the agent to finish first.' },
      }
    return info
  }

  async ship(request: ShipRequest): Promise<ShipResult> {
    const root = this.state.project?.root
    if (!root) throw new Error('No project is open.')
    if (this.resources.chat?.busy) throw new Error('Wait for the agent to finish first.')
    if (!(await this.confirmGit(root))) throw new Error('Cancelled.')
    if (this.state.project?.root !== root) throw new Error('No project is open.')
    return ship(root, request, this.gitActions(root))
  }

  async sourceControl(request: SourceControlRequest) {
    const root = await this.gitRootForAction()
    return sourceControl(root, request, this.gitActions(root))
  }

  private gitActions(root: string): ShipActions {
    return {
      assertAvailable: () => {
        if (this.disposed || this.state.project?.root !== root)
          throw new Error('The project changed.')
        if (this.resources.chat?.busy) throw new Error('Wait for the agent to finish first.')
      },
      confirmPush: async ({ remote, branch, count }) => {
        const owner = this.panel.popoutWindow ?? this.host.win
        const { response } = await dialog.showMessageBox(owner, {
          type: 'warning',
          message: `Push ${count} ${count === 1 ? 'commit' : 'commits'} directly to ${remote}/${branch}?`,
          detail: 'This updates the shared branch immediately and skips pull request review.',
          buttons: ['Cancel', 'Create a branch', `Push to ${branch}`],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        })
        return response === 2 ? 'push' : response === 1 ? 'branch' : 'cancel'
      },
    }
  }

  /** source_control_status: never asks to run Git; says so when the user hasn't allowed it. */
  private async sourceControlForAgent() {
    const root = this.state.project?.root
    if (!root) throw new Error('No project is open')
    if (!(await isTrusted(root)))
      return "The user hasn't let Gui run Git in this project yet. Opening Source Control asks them."
    const [info, proposal] = await Promise.all([
      shipInfo(root, []),
      readProposal(root).catch(() => null),
    ])
    return describeSourceControl(info, proposal)
  }

  /** versions_list: what the Versions sheet shows, for an agent helping find a restore point. */
  private async versionsForAgent(limit: number) {
    const chat = this.resources.chat
    if (!this.state.project || !chat) throw new Error('No project is open')
    return describeVersions(await chat.listVersions(), limit, chat.turnRunning)
  }

  /** source_control_propose: Source Control opens with it when the turn ends. */
  private proposeShipForAgent(draft: ShipDraft) {
    if (!this.state.project) throw new Error('No project is open')
    this.shipProposal = draft
    return 'Gui will open Source Control with this filled in when your turn ends. The user reviews it and commits or opens the pull request; nothing is committed until they do. Tell them it is ready to review.'
  }

  // The pull request's progress (src/main/proposal.ts)

  /** Null without a project, or before the user lets Gui run Git here (never asks). */
  async getProposal(refresh: boolean): Promise<Proposal | null> {
    const root = this.state.project?.root
    if (!root || !(await isTrusted(root))) return null
    return readProposal(root, refresh)
  }

  async startFresh() {
    const root = await this.gitRootForAction()
    await withGitMutation(root, () => startFresh(root))
    // The finished idea's chat goes to the archive; the next one starts empty.
    if (this.state.project?.root === root) this.newChat()
  }

  async bringInLatest() {
    const root = await this.gitRootForAction()
    await withGitMutation(root, () => bringInLatest(root))
  }

  async finishMerge() {
    const root = await this.gitRootForAction()
    await withGitMutation(root, () => finishMerge(root))
  }

  async cancelMerge() {
    const root = await this.gitRootForAction()
    await withGitMutation(root, () => cancelMerge(root))
  }

  /** Hands the conflicts to the agent as a message the user sees in the chat. */
  async resolveConflicts() {
    const root = await this.gitRootForAction()
    const proposal = await readProposal(root)
    if (!proposal.merge) return
    const prompt = conflictPrompt(proposal.merge, proposal.defaultBranch ?? 'main')
    if (!(await this.sendChatMessage(prompt, []))) throw new Error('The agent couldn’t take this.')
  }

  private async gitRootForAction() {
    const root = this.state.project?.root
    if (!root) throw new Error('No project is open.')
    if (this.resources.chat?.busy) throw new Error('Wait for the agent to finish first.')
    if (!(await this.confirmGit(root))) throw new Error('Cancelled.')
    if (this.state.project?.root !== root) throw new Error('No project is open.')
    return root
  }

  // Project setup (WindowState.setup)

  /** Runs the picked monorepo app from now on, and remembers it for this project. */
  chooseApp(dir: string) {
    const project = this.state.project
    if (!project || !this.apps.some((app) => app.dir === dir)) return
    if (this.resources.devServer && this.switchingApp === this.resources.devServer) return
    setPrefs({ apps: { ...getPrefs().apps, [project.root]: dir } })
    // Picking an app is picking what runs: a start command set in Gui gives way.
    if (project.custom) void saveStartCommand(project.root, null).catch(() => undefined)
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
        console.error('[gui] failed to create the env file', error)
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
      (error: unknown) => console.error('[gui] not opening the env file', error),
    )
  }

  /**
   * Gets the project running: installs dependencies if they're missing, then starts the
   * dev server. An untrusted project asks first, whether it's opening or the user clicked.
   */
  private async setUpAndStart() {
    const { project, setup } = this.state
    const devServer = this.resources.devServer
    if (!project || !devServer || setup?.apps) return
    // Undo needs git from the first turn: find out now whether it runs, so a missing install
    // shows as a banner rather than macOS's own prompt mid-turn.
    void developerTools.gitAvailable()
    // Nothing can install or run without Node.js, nor can the agent build an app with it:
    // offer Gui's own first. Once it's set up, this runs again (onNodeRuntime).
    if (await nodeRuntime.missingFor(project.packageManager)) {
      if (devServer === this.resources.devServer) this.patchSetup({ node: nodeRuntime.state })
      return
    }
    if (this.state.setup?.node) this.patchSetup({ node: null })
    if (!project.devCommand) return
    if (this.settingUp === devServer || setup?.dependencies === 'installing') return
    this.settingUp = devServer
    try {
      const install = setup?.dependencies === 'missing' || setup?.dependencies === 'failed'
      if (!(await this.confirmScripts(project, install))) return
      if (devServer !== this.resources.devServer) return
      if (install && !(await this.install(devServer, project))) return
      await devServer.start(project.devCommand, project.custom?.url ?? null)
    } finally {
      if (this.settingUp === devServer) this.settingUp = null
    }
  }

  /** Installs at the (workspace) root, streaming into the logs. True when it succeeded. */
  private async install(devServer: DevServer, project: ProjectInfo) {
    this.patchSetup({ dependencies: 'installing' })
    const missing = await missingPackageManager(project.packageManager, await getShellEnv())
    if (devServer !== this.resources.devServer) return false
    const code = missing
      ? null
      : await devServer.runTask(installCommand(project.packageManager), project.root)
    if (devServer !== this.resources.devServer) return false
    if (missing) devServer.print(missing)
    if (code === 0) {
      this.patchSetup({ dependencies: 'ok' })
      return true
    }
    this.patchSetup({ dependencies: 'failed' })
    return false
  }

  /** Switches the dev server to another monorepo app, then sets it up and starts it. */
  private async runApp(dir: string) {
    const devServer = this.resources.devServer
    const root = this.state.project?.root
    if (!devServer || !root) return
    this.switchingApp = devServer
    try {
      await devServer.stopAndWait()
      const { project } = await detectProject(root, dir)
      const env = await detectEnv(root, project.appDir)
      if (devServer !== this.resources.devServer) return
      devServer.setCwd(appRoot(project))
      this.patch({ project, setup: this.nextSetup({ apps: null, env }) })
    } finally {
      if (this.switchingApp === devServer) this.switchingApp = null
    }
    await this.setUpAndStart()
  }

  /** "Switch app…": stops the current app and asks again. */
  private showAppChooser() {
    void this.resources.devServer?.stop()
    void this.inspector.clearHighlight()
    this.preview.setVisible(false)
    this.preview.webContents.loadURL('about:blank').catch(() => undefined)
    this.patchPreview({ url: null, error: null, visible: false, selecting: false })
    this.patchSetup({ apps: this.apps })
  }

  /** Gui's Node.js download moved on: follow it while waiting on it, and go on once it's in. */
  private onNodeRuntime = (node: NodeSetup) => {
    if (!this.state.setup?.node) return
    if (node.status !== 'ready') return this.patchSetup({ node })
    this.patchSetup({ node: null })
    void this.setUpAndStart()
  }

  private patchSetup(patch: Partial<ProjectSetup>) {
    this.patch({ setup: this.nextSetup(patch) })
  }

  private nextSetup(patch: Partial<ProjectSetup>) {
    const setup = this.state.setup ?? { apps: null, dependencies: 'ok', env: null }
    return settleSetup({ ...setup, ...patch })
  }

  // Getting a failed start going again (the agent's dev server tools, start commands)

  /**
   * Gets the app going again from the top, as the project is now: the agent (or the user)
   * may have changed its scripts, installed its packages or set a start command since. Stops
   * what's running, reads the project again, then installs if needed and starts it.
   */
  retryStartup(): Promise<void> {
    this.retrying ??= this.restartFromTop().finally(() => {
      this.retrying = null
    })
    return this.retrying
  }

  private async restartFromTop() {
    const devServer = this.resources.devServer
    const root = this.state.project?.root
    // A setup in flight (installing, or asking to run the project) goes on by itself.
    if (!devServer || !root || this.settingUp === devServer) return
    await devServer.stopAndWait()
    const { project, apps, choosing } = await resolveProject(root, getPrefs().apps[root] ?? null)
    const setup = await detectSetup(project, choosing ? apps : null)
    if (devServer !== this.resources.devServer) return
    this.apps = apps
    devServer.setCwd(appRoot(project))
    // Gui's own Node.js download goes on whatever the project says now.
    const node = this.state.setup?.node ?? null
    this.patch({
      project,
      setup: node
        ? settleSetup({ ...(setup ?? { apps: null, dependencies: 'ok', env: null }), node })
        : setup,
    })
    // The page's error was about the old server; the canvas follows the new one.
    if (this.state.preview.error) this.patchPreview({ error: null })
    if (project.devCommand || choosing) this.stopWatchingForApp()
    else if (!this.appWatcher) this.watchForApp(root)
    await this.setUpAndStart()
  }

  /** Resolves once the app shows in the preview, has failed, is waiting on the user, or after `ms`. */
  private async waitForStart(ms: number) {
    const deadline = Date.now() + ms
    while (Date.now() < deadline && !this.disposed) {
      const { devServer, setup, preview } = this.state
      if (setup?.apps || setup?.node || setup?.dependencies === 'failed') return
      if (devServer.status === 'exited' || preview.error) return
      if (devServer.status === 'running' && preview.visible) return
      if (devServer.status === 'idle' && !this.settingUp && !this.retrying) return
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }

  /** How getting the app going went, for the agent: the headline, the state, the output. */
  private startOutcome() {
    const { devServer, preview } = this.state
    const headline =
      startupFailure(this.state) ??
      (devServer.status === 'running' && preview.visible
        ? `The app is running at ${devServer.url}, and the preview shows it.`
        : devServer.status === 'starting' || devServer.status === 'running'
          ? 'Still starting. Check again in a moment with dev_server_status.'
          : "The app isn't running.")
    const output = logTail(this.getLogs(), AGENT_LOG_LINES)
    return [headline, describeServer(this.state), `Latest output:\n${output || '(none)'}`].join(
      '\n\n',
    )
  }

  /** dev_server_restart: gets the app going again and waits to see how it went. */
  private async restartForAgent() {
    if (!this.state.project) throw new Error('No project is open')
    this.agentRestartedAt = Date.now()
    await this.retryStartup()
    await this.waitForStart(AGENT_START_WAIT_MS)
    return this.startOutcome()
  }

  /**
   * set_start_command: the agent's start command, once the user has seen and approved it
   * (which trusts the project, as starting it would), then the app started with it.
   */
  private async setStartCommandForAgent(input: StartCommandInput | null) {
    const project = this.state.project
    if (!project) throw new Error('No project is open')
    if (!input) {
      if (!project.custom)
        return `Gui already runs the start command it detects.\n\n${describeServer(this.state)}`
      await saveStartCommand(project.root, null)
      return this.restartForAgent()
    }
    const start = await validateStartCommand(project.root, input)
    const where = start.dir ? ` in the ${promptName(start.dir)} folder` : ''
    const address = start.url ? `, at ${promptName(start.url)}` : ''
    const agreed = await this.askToTrust(project.root, {
      message: `Start ${promptName(project.name)} a different way?`,
      detail: `Your agent wants Gui to start this app${where}${address} with:\n\n${promptText(start.command, 2000)}\n\nGui will run it now and whenever you open this project. It runs code on your Mac: only allow commands you trust. You can go back to the detected command in Settings.`,
      buttons: ['Use This Command', 'Cancel'],
      // The agent asked, not the user: Return mustn't be what agrees.
      defaultId: 1,
    })
    if (!agreed) return 'The user declined. Gui still starts the app the way it did.'
    if (this.state.project?.root !== project.root) throw new Error('The project was closed')
    await saveStartCommand(project.root, start)
    return this.restartForAgent()
  }

  /**
   * The user's own start command, from the canvas (null: back to what Gui detects). They
   * wrote it, so it's trusted. Throws what's wrong with it, to show under the field.
   */
  async setStartCommand(input: StartCommandInput | null) {
    const root = this.state.project?.root
    if (!root) return
    const start = input ? await validateStartCommand(root, input) : null
    await saveStartCommand(root, start)
    if (start) await trust(root)
    // Not waited on: installing can take minutes, and the canvas follows it.
    if (this.state.project?.root === root) void this.retryStartup()
  }

  removeQueued(id: string) {
    this.resources.chat?.removeQueued(id)
  }

  clearQueued() {
    this.resources.chat?.clearQueued()
  }

  editQueued(id: string, text: string) {
    this.resources.chat?.editQueued(id, text)
  }

  moveQueued(id: string, index: number) {
    this.resources.chat?.moveQueued(id, index)
  }

  sendQueuedNow() {
    this.resources.chat?.sendQueuedNow()
  }

  sendQueued(id: string) {
    this.resources.chat?.sendQueued(id)
  }

  cancelChat() {
    void this.resources.chat?.cancel()
  }

  /** Auto mode for this tab's project (see ChatMeta.autoApprove); off without one. */
  get autoApprove() {
    const root = this.state.project?.root
    return root !== undefined && isAutoApprove(root)
  }

  setAutoApprove(on: boolean) {
    const root = this.state.project?.root
    if (root) saveAutoApprove(root, on)
  }

  /** The model and effort settings the composer offers; null without a chat. */
  get chatModels() {
    return this.resources.chat?.meta.models ?? null
  }

  setAgentSetting(settingId: string, value: string) {
    this.resources.chat?.setAgentSetting(settingId, value)
  }

  /** Starts the chat's agent early so the command menu can list its commands. */
  loadCommands() {
    return this.resources.chat?.loadCommands()
  }

  /** ⇧⌘M: shows the chat and opens the composer's model picker, searching. */
  chooseModel() {
    if (!this.resources.chat?.meta.models) return shell.beep()
    this.panel.focusChat()
    this.sendChat(Events.command, 'chooseModel')
  }

  respondPermission(turnId: string, itemId: string, optionId: string | null) {
    this.resources.chat?.respondPermission(turnId, itemId, optionId)
  }

  /**
   * What Agent → Allow (⌘↩) or Don't Allow (⌘⌫) answers: the oldest waiting card, with its
   * Allow or Don't Allow (`allow_once`, `reject_once`; never an "always"). Null when no card
   * waits, it doesn't offer that, or the PR sheet has the keys.
   */
  permissionAnswer(allow: boolean) {
    const waiting = this.shipSheetOpen ? null : this.resources.chat?.oldestPermission()
    const kind = allow ? 'allow_once' : 'reject_once'
    const option = waiting?.item.options.find((choice) => choice.kind === kind)
    if (!waiting || !option) return null
    return { turnId: waiting.turnId, itemId: waiting.item.id, optionId: option.optionId }
  }

  answerPermission(allow: boolean) {
    const answer = this.permissionAnswer(allow)
    if (!answer) return shell.beep()
    this.respondPermission(answer.turnId, answer.itemId, answer.optionId)
  }

  setShipSheetOpen(open: boolean) {
    if (open === this.shipSheetOpen) return
    this.shipSheetOpen = open
    this.host.tabChanged(this, false)
  }

  restoreTurn(turnId: string) {
    return this.resources.chat?.restoreTurn(turnId)
  }

  listVersions() {
    return this.resources.chat?.listVersions() ?? null
  }

  saveVersion(name: string) {
    const chat = this.resources.chat
    if (!chat) throw new Error('No project is open.')
    return chat.saveVersion(name)
  }

  restoreVersion(id: string) {
    const chat = this.resources.chat
    if (!chat) throw new Error('No project is open.')
    return chat.restoreVersion(id)
  }

  redo() {
    return this.resources.chat?.redo()
  }

  newChat() {
    void this.resources.chat?.reset()
  }

  /** Archives the open chat, as New chat does; false when it couldn't be. */
  archiveChat() {
    return this.resources.chat?.reset() ?? Promise.resolve(true)
  }

  /** The chat file this tab's chat writes, if one is open. */
  get chatFile() {
    return this.resources.historyFile
  }

  /** The project's archived chats, newest first; none without a project. */
  listChats() {
    const root = this.resources.historyRoot
    return root ? listArchived(root) : Promise.resolve([])
  }

  async openChat(id: string) {
    if (!this.resources.chat) throw new Error('No project is open.')
    await this.resources.chat.openArchived(id)
    this.panel.focusChat()
  }

  async renameChat(id: string, title: string) {
    if (this.resources.historyRoot) await renameArchived(this.resources.historyRoot, id, title)
  }

  async deleteChat(id: string) {
    if (this.resources.historyRoot) await removeArchived(this.resources.historyRoot, id)
  }

  clearSelection() {
    this.resources.chat?.setSelection([])
  }

  setAgent(agentId: AgentId) {
    if (!agentHealth.has(agentId)) return
    agentHealth.ensureChecked(agentId)
    setPrefs({ agentId })
    this.patch({ agentId })
    void this.resources.chat?.setAgent(agentId)
  }

  setChatSidebarSide(side: 'left' | 'right') {
    this.resources.chat?.setSidebarSide(side)
    this.layout()
    this.host.tabChanged(this, false)
  }

  toggleDock() {
    if (!this.resources.chat) return
    if (this.panel.popoutWindow) return this.panel.togglePopOut()
    this.leaveFocusMode()
    this.panel.untuck()
    this.morphLayout('dock')
    const docked = !this.resources.chat.meta.docked
    setPrefs({ chatSidebar: docked })
    this.resources.chat.setDocked(docked)
    if (!this.state.chatVisible) this.patch({ chatVisible: true })
    if (docked) this.panel.holdDock()
    this.layout()
  }

  signInAgain() {
    return this.resources.chat?.signInAgain() ?? Promise.resolve(false)
  }

  setUpAgent() {
    return this.resources.chat?.setUpAgent() ?? Promise.resolve()
  }

  fixProblems() {
    const sent = this.resources.chat?.fixProblems() ?? false
    if (sent) this.panel.focusChat()
    return sent
  }

  /** "Fix with agent" on a start that failed: the agent gets why, and the chat comes forward. */
  fixStartup() {
    const sent = this.resources.chat?.fixStartup() ?? false
    if (!sent) return false
    if (!this.state.chatVisible) {
      this.patch({ chatVisible: true })
      this.layout()
    }
    this.panel.focusChat()
    return true
  }

  /**
   * Shows the changed element in the turn, next to how it looked when it was picked: framed
   * like the pick's crop, so the two line up (see `matchingArea`). An area is the same part
   * of the page again.
   */
  private async captureAfter(chat: ChatController, turnId: string, shown: Picked) {
    const tools = this.resources.previewTools
    if (!tools || chat !== this.resources.chat || !this.state.preview.visible) return
    const crop = shown.crop ?? null
    const options = isRegion(shown)
      ? { area: crop?.area }
      : { selector: shown.selector, matching: crop ?? undefined }
    const shot = await tools.screenshot(options).catch(() => null)
    if (chat !== this.resources.chat) return
    const frame = shot && crop ? previewFrame(crop.area, shot.area) : null
    chat.setPreviewAfter(turnId, thumbnail(shot), frame)
  }

  /** Undoes the newest turn that changed files and hasn't been undone. */
  async undoLastChange() {
    const turnId = this.resources.chat?.lastUndoableTurnId()
    if (!turnId) return shell.beep()
    await this.resources.chat?.restoreTurn(turnId).catch(() => shell.beep())
  }

  async redoLastChange() {
    if (!this.resources.chat?.meta.redoTurnIds.length) return shell.beep()
    await this.resources.chat.redo().catch(() => shell.beep())
  }

  /** Re-finds an element after hot reload (its old node is gone) and highlights it. */
  private async highlightSelector(selector: string | undefined) {
    if (!selector || !this.state.preview.visible || this.resources.chat?.meta.selection.length)
      return
    const generation = this.rehighlightGeneration
    // A turn or pick can start while this waits on the inspector; checked again under its lock.
    const current = () =>
      generation === this.rehighlightGeneration && !this.resources.chat?.meta.selection.length
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

  /** Drops the post-turn re-highlight, shown or still pending (its "after" capture still runs). */
  private cancelRehighlight() {
    this.rehighlightGeneration++
    if (!this.rehighlightShown) return
    this.rehighlightShown = false
    void this.inspector.clearHighlight()
  }

  /** ⌘B and the toolbar's chat button: shows or hides the chat, in whichever form it takes. */
  toggleChat() {
    this.panel.toggleChat()
  }

  /**
   * ⌘L: the cursor in the chat's message box, showing the chat first if it's hidden (or out of
   * its bubble, or ending a pick). It never hides the chat: ⌘B does (`toggleChat`).
   */
  focusMessageBox() {
    this.panel.focusMessageBox()
  }

  setMinimized(minimized: boolean) {
    this.panel.setMinimized(minimized)
  }

  /** The tucked bubble was clicked: the panel comes back, ready to type in. */
  expandChat() {
    this.panel.expandChat()
  }

  /** The chat's own window while popped out, so menus and ⌘W can tell it's this tab's. */
  get popoutWindow() {
    return this.panel.popoutWindow
  }

  /** ⌥⌘L and the chat's header button: into a window of its own, or back into this one. */
  togglePopOut() {
    this.panel.togglePopOut()
  }

  grabChat(at: ChatGrab) {
    this.panel.grabChat(at)
  }

  dragChat(dx: number, dy: number) {
    this.panel.dragChat(dx, dy)
  }

  endDragChat(release: { x: number; y: number } = { x: 0, y: 0 }) {
    this.panel.endDragChat(release)
  }

  chatMorphed(form: ChatForm, seq: number) {
    this.panel.chatMorphed(form, seq)
  }

  resizeChat(edge: PanelEdge, dx: number, dy: number) {
    this.panel.resizeChat(edge, dx, dy)
  }

  endResizeChat() {
    this.panel.endResizeChat()
  }

  /**
   * Screenshot menu for the preview: copy, copy full page, save, attach to chat. At the
   * pointer, or with its top-left corner at `at` in `sender`'s page (the toolbar's button, for
   * ⇧⌘S). Resolves with what was done; null when dismissed, cancelled or the capture failed.
   */
  async screenshotMenu(
    sender: WebContents | null = null,
    at: { x: number; y: number } | null = null,
  ): Promise<ScreenshotResult | null> {
    const tools = this.resources.previewTools
    const project = this.state.project
    if (this.screenshotting) return null
    if (!tools || !project || !this.canCapture()) {
      shell.beep()
      return null
    }
    this.screenshotting = true
    try {
      const action = await this.chooseScreenshot(at && this.inWindow(sender, at))
      if (!action || tools !== this.resources.previewTools || !this.canCapture()) return null
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
      console.error('[gui] screenshot failed', error)
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
  private chooseScreenshot(at: { x: number; y: number } | null) {
    return new Promise<ScreenshotAction | null>((resolve) => {
      const item = (
        label: string,
        action: ScreenshotAction,
        enabled = true,
      ): MenuItemConstructorOptions => ({ label, enabled, click: () => resolve(action) })
      Menu.buildFromTemplate([
        item('Copy screenshot', 'copy'),
        item('Copy full page', 'copy-full-page'),
        item('Save screenshot…', 'save'),
        { type: 'separator' },
        item('Attach to chat', 'attach', this.resources.chat !== null),
      ]).popup({
        window: this.host.win,
        ...at,
        // Electron runs a chosen item's click before this, so this only settles a dismissal.
        callback: () => resolve(null),
      })
    })
  }

  /** False when the user cancelled the save panel. */
  private async saveScreenshot(png: Buffer, name: string) {
    const { canceled, filePath } = await dialog.showSaveDialog(this.host.win, {
      defaultPath: join(app.getPath('desktop'), `${name}.png`),
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    })
    if (canceled || !filePath) return false
    await writeFile(filePath, png)
    return true
  }

  /** Adds the screenshot to the composer as a reference image, then shows the chat. */
  private attachScreenshot(png: Buffer, name: string) {
    if (!this.resources.chat) return false
    const image = nativeImage.createFromBuffer(png)
    if (image.isEmpty()) throw new Error("Couldn't read the captured image")
    this.panel.focusChat()
    this.sendChat(Events.chatAttach, chatImage(image, name))
    return true
  }

  /** The chat or the chrome, when one of them has the keyboard. */
  private keyboardOwner() {
    const views = [this.chatView.webContents, this.host.win.webContents]
    return views.find((wc) => !wc.isDestroyed() && wc.isFocused()) ?? null
  }

  /** Gives the keyboard back to the view that had it before the preview's page loaded. */
  private keepKeyboard() {
    const owner = this.keyboardBeforeLoad
    if (!owner || owner.isDestroyed() || owner.isFocused() || this.state.preview.selecting) return
    if (!this.host.isActive(this) || !this.host.win.isFocused()) return
    owner.focus()
  }

  /** Places the tab's views over the canvas; only the active tab's are in the window. */
  layout() {
    // Focus mode, which lays the tab out again, hides the drawer.
    this.syncDrawerOutput()
    if (this.disposed || !this.host.isActive(this)) return
    const area = this.previewArea()
    const preview = this.state.preview
    // Even while nothing shows, so a page that loads lays out at its viewport's size at once.
    const { viewport } = preview
    const { bounds, emulation } = placePreview(viewport, area, this.zooms[viewport])
    this.placement = bounds
    const covered = this.host.sheetShown
    const visible = preview.visible && area.width > 0 && !covered
    // Nothing on screen to morph into: the new layout is simply there.
    if (!visible) this.morph.finish(false)
    // Desktop's zoom emulates too, without a frame.
    const frame = viewportSpec(viewport).size !== null && emulation
    // Where the view goes: here, or mid-morph where its resize has got to on the way.
    const placed = { rect: bounds, scale: emulation?.scale ?? 1, frame: frame ? viewport : null }
    const live = this.morph.place(placed)
    this.preview.setBounds(live?.rect ?? bounds)
    this.preview.setVisible(visible)
    // Picking needs the page on screen, where the overlay lies over it.
    if (this.picker.picking) {
      if (visible) this.picker.setBounds(bounds)
      else void this.setSelecting(false)
    } else if (this.picker.guiding) {
      if (visible) this.picker.setBounds(bounds)
      else this.endGuide()
    }
    this.emulation.set(live ? live.emulation : emulation)
    // Mid-morph the chrome draws the device frame where the view is; this one shows once it rests.
    const rect = inCanvas(bounds, this.host.canvas)
    this.showFrame(frame ? { viewport, rect, scale: frame.scale } : null)
    this.panel.layoutChat()
  }

  /** Tells the chrome where the device frame is, to draw its edge and label, when that changes. */
  private showFrame(frame: ViewportFrame | null) {
    const shown = this.state.preview.frame
    const same =
      frame === shown ||
      (frame !== null &&
        shown !== null &&
        frame.viewport === shown.viewport &&
        frame.scale === shown.scale &&
        frame.rect.x === shown.rect.x &&
        frame.rect.y === shown.rect.y &&
        frame.rect.width === shown.rect.width &&
        frame.rect.height === shown.rect.height)
    if (!same) this.patchPreview({ frame })
  }

  /**
   * Before a change that moves or resizes the preview: it morphs into its new layout (when the
   * preview is on screen and nothing's being picked), rather than jumping there.
   */
  morphLayout(kind: MorphKind) {
    const { win } = this.host
    const eligible =
      !this.disposed &&
      this.host.isActive(this) &&
      this.state.preview.visible &&
      !this.state.preview.selecting &&
      !this.host.sheetShown &&
      win.isVisible() &&
      !win.isMinimized()
    this.morph.request(kind, eligible)
  }

  /** The canvas: the chrome already leaves room for the sidebar (`sidebarWidth`). */
  private previewArea(): Rect {
    return this.host.canvas
  }

  // Native menus

  showDevServerMenu() {
    const { status, url } = this.state.devServer
    const running = status === 'running' || status === 'starting'
    const showingLogs = this.state.drawer.open && this.state.drawer.tab === 'server'
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
        label: showingLogs ? 'Hide logs' : 'Show logs',
        click: () => (showingLogs ? this.setDrawerOpen(false) : this.showLogs()),
      },
      {
        label: 'Open in browser',
        enabled: !!url,
        click: () => {
          if (url) shell.openExternal(this.state.preview.url ?? url).catch(() => undefined)
        },
      },
    ]
    Menu.buildFromTemplate(template).popup({ window: this.host.win })
  }

  /** At the pointer, or at `at` in `sender`'s page (the chat header's agent switcher). */
  showAgentMenu(
    openSettings: () => void,
    sender: WebContents,
    at: { x: number; y: number } | null,
  ) {
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
    const menu = Menu.buildFromTemplate(template)
    // From a popped-out chat, in its window.
    const window =
      sender === this.chatView.webContents && this.panel.popoutWindow
        ? this.panel.popoutWindow
        : this.host.win
    menu.popup({ window, ...(at && this.inWindow(sender, at)) })
  }

  /**
   * The chat header's More menu: its less-used actions. Pop Out happens here; the pull
   * request sheet and the archived chats are the chat page's, so it's told which was chosen.
   */
  showChatMenu(at: { x: number; y: number }, ship: { open: boolean; busy: boolean }) {
    if (!this.hasProject) return
    const choose = (choice: ChatMenuChoice) => this.sendChat(Events.chatMenuChoice, choice)
    const template: MenuItemConstructorOptions[] = [
      { label: 'Versions…', click: () => choose('versions') },
      {
        label: ship.open ? 'Close Source Control' : 'Source Control…',
        enabled: !ship.busy,
        click: () => choose('pullRequest'),
      },
      { label: 'Archived Chats', click: () => choose('archive') },
      { type: 'separator' },
      {
        label: this.panel.popoutWindow ? 'Back to Window' : 'Pop Out Chat',
        accelerator: SHORTCUTS.popOutChat.accelerator,
        registerAccelerator: false,
        click: () => this.togglePopOut(),
      },
    ]
    const window = this.panel.popoutWindow ?? this.host.win
    Menu.buildFromTemplate(template).popup({
      window,
      ...this.inWindow(this.chatView.webContents, at),
    })
  }

  /**
   * `at` in `sender`'s page, in its window's coordinates: the chat is a view inside the window,
   * or fills its own when popped out.
   */
  private inWindow(sender: WebContents | null, at: { x: number; y: number }) {
    const inChat = sender === this.chatView.webContents && !this.panel.popoutWindow
    const view = inChat ? this.chatView.getBounds() : { x: 0, y: 0 }
    return { x: Math.round(view.x + at.x), y: Math.round(view.y + at.y) }
  }

  /** A frame's context menu on the board; acts on every selected frame when it's one of them. */
  showFrameMenu(id: string, promote: (id: string) => void) {
    const board = this.resources.board
    const frame = board?.frame(id)
    if (!board || !frame) return
    if (!board.selected.includes(id)) board.select([id])
    const ids = board.selected.includes(id) ? [...board.selected] : [id]
    const many = ids.length > 1
    const insection = ids.filter((f) => board.sections.some((s) => s.frames.includes(f)))
    const one = (label: string, click: () => unknown): MenuItemConstructorOptions => ({
      label,
      enabled: !many,
      click: () => void click(),
    })
    const template: MenuItemConstructorOptions[] = [
      one('Open', () => this.openFrame(id)),
      one('Rename', () => this.send(Events.board, { type: 'renameFrame', id })),
      {
        label: many ? `Duplicate ${ids.length} Frames` : 'Duplicate',
        accelerator: 'Alt+CmdOrCtrl+D',
        registerAccelerator: false,
        click: () => void board.duplicate(ids),
      },
      {
        label: many ? `Delete ${ids.length} Frames` : 'Delete',
        accelerator: 'Backspace',
        registerAccelerator: false,
        click: () => void board.remove(ids),
      },
      { type: 'separator' },
      {
        label: 'Add Section',
        accelerator: 'Alt+CmdOrCtrl+G',
        registerAccelerator: false,
        click: () => void this.boardAddSection(ids),
      },
      ...(insection.length
        ? [
            {
              label: 'Remove from Section',
              click: () => {
                for (const section of board.sections)
                  if (section.frames.some((f) => ids.includes(f)))
                    void board.updateSection(section.id, {
                      frames: section.frames.filter((f) => !ids.includes(f)),
                    })
              },
            },
          ]
        : []),
      { type: 'separator' },
      one('Copy HTML', async () =>
        clipboard.writeText(await readFile(board.framePath(id), 'utf8')),
      ),
      one('Copy as PNG', () => this.copyFrameImage(id)),
      {
        label: many ? `Export ${ids.length} Frames as PNG…` : 'Export as PNG…',
        accelerator: 'Shift+CmdOrCtrl+E',
        registerAccelerator: false,
        click: () => void this.exportFrames(ids),
      },
      one('Save as HTML…', () => this.exportFrame(id, 'html')),
      { type: 'separator' },
      one('Turn into Project…', () => promote(id)),
      one('Reveal in Finder', () => shell.showItemInFolder(board.framePath(id))),
    ]
    Menu.buildFromTemplate(template).popup({ window: this.host.win })
  }

  /** A new section around frames, then naming it in place on the board. */
  async boardAddSection(ids: string[]) {
    const board = this.resources.board
    const section = await board?.addSection(ids)
    if (section && this.resources.board === board)
      this.send(Events.board, { type: 'renameSection', id: section.id })
  }

  /** A section's context menu on the board: its name, its frames, exporting, deleting. */
  showSectionMenu(id: string) {
    const board = this.resources.board
    const section = board?.section(id)
    if (!board || !section) return
    const count = section.frames.length
    const template: MenuItemConstructorOptions[] = [
      { label: 'Rename', click: () => this.send(Events.board, { type: 'renameSection', id }) },
      { label: 'Select Frames', click: () => board.select(section.frames) },
      {
        label: count > 1 ? `Export ${count} Frames as PNG…` : 'Export as PNG…',
        click: () => void this.exportFrames(section.frames),
      },
      { type: 'separator' },
      { label: 'Delete Section', click: () => void board.removeSection(id) },
      {
        label: `Delete Section and ${count > 1 ? `${count} Frames` : 'Frame'}`,
        click: () => void board.remove(section.frames),
      },
    ]
    Menu.buildFromTemplate(template).popup({ window: this.host.win })
  }

  /** Saves a frame's page where the user picks. */
  private async exportFrame(id: string, kind: 'html' | 'png') {
    const board = this.resources.board
    const frame = board?.frame(id)
    if (!board || !frame) return
    const { canceled, filePath } = await dialog.showSaveDialog(this.host.win, {
      defaultPath: `${frameId(frame.name, new Set())}.${kind}`,
      filters: [
        kind === 'html'
          ? { name: 'HTML', extensions: ['html'] }
          : { name: 'PNG', extensions: ['png'] },
      ],
    })
    if (canceled || !filePath) return
    try {
      if (kind === 'html') await writeFile(filePath, await readFile(board.framePath(id)))
      else await writeFile(filePath, (await board.screenshot(id, FRAME_EXPORT_SCALE)).toPNG())
    } catch (error) {
      frameError(error)
    }
  }

  /**
   * Frames as PNGs at twice their size, sharp on a Retina display: one where the user picks,
   * or several into the folder they pick, each named for its frame.
   */
  async exportFrames(ids: string[]) {
    const board = this.resources.board
    const found = ids.filter((id) => board?.has(id))
    if (!board || !found.length) return
    if (found.length === 1) return this.exportFrame(found[0], 'png')
    const { canceled, filePaths } = await dialog.showOpenDialog(this.host.win, {
      title: `Export ${found.length} Frames`,
      buttonLabel: 'Export',
      properties: ['openDirectory', 'createDirectory'],
    })
    const dir = filePaths[0]
    if (canceled || !dir) return
    const files = exportPaths(found, board.frames, board.sections)
    // Each frame renders in turn, a second or so apiece: the Dock icon shows how far it is.
    const win = this.host.win
    try {
      for (const [i, { id, path }] of files.entries()) {
        if (!win.isDestroyed()) win.setProgressBar(i / files.length)
        const file = join(dir, ...path.split('/'))
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, (await board.screenshot(id, FRAME_EXPORT_SCALE)).toPNG())
      }
      shell.showItemInFolder(join(dir, files[0].path.split('/')[0]))
    } catch (error) {
      frameError(error)
    } finally {
      if (!win.isDestroyed()) win.setProgressBar(-1)
    }
  }

  /** A frame's PNG on the clipboard, at twice its size. */
  private async copyFrameImage(id: string) {
    const board = this.resources.board
    if (!board?.has(id)) return
    try {
      const png = new Uint8Array((await board.screenshot(id, FRAME_EXPORT_SCALE)).toPNG())
      await clipboard.write([
        new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) }),
      ])
    } catch (error) {
      frameError(error)
    }
  }

  /** The toolbar's Frame menu: a new frame at one of the preset sizes, beside what's selected. */
  showAddFrameMenu(at: { x: number; y: number }) {
    if (!this.resources.board) return
    const template = FRAME_PRESETS.map(
      (preset): MenuItemConstructorOptions => ({
        label: `${preset.name}  ${preset.width} × ${preset.height}`,
        click: () => void this.boardAddFrame(preset.id, null),
      }),
    )
    Menu.buildFromTemplate(template).popup({
      window: this.host.win,
      x: Math.round(at.x),
      y: Math.round(at.y),
    })
  }

  /** The canvas's menu, under its name in the toolbar. */
  showBoardMenu(newBoard: () => void) {
    const board = this.resources.board
    if (!board) return
    const template: MenuItemConstructorOptions[] = [
      { label: 'Rename Canvas', click: () => this.send(Events.board, { type: 'renameBoard' }) },
      { label: 'New Canvas', click: newBoard },
      { type: 'separator' },
      {
        label: 'Export All Frames as PNG…',
        enabled: board.frames.length > 0,
        click: () => void this.exportFrames(board.frames.map((frame) => frame.id)),
      },
      { type: 'separator' },
      {
        label: 'Reveal in Finder',
        click: () => shell.showItemInFolder(join(board.root, 'canvas.json')),
      },
    ]
    Menu.buildFromTemplate(template).popup({ window: this.host.win })
  }

  showProjectMenu(
    openPicker: () => void,
    openNew: () => void,
    openClone: () => void,
    openRecent: (root: string) => void,
  ) {
    const recent = (this.state.recent ?? []).filter((p) => p.root !== this.state.project?.root)
    const template: MenuItemConstructorOptions[] = [
      { label: 'Open Project…', click: openPicker },
      { label: 'New Project…', click: openNew },
      { label: 'Clone by URL…', click: openClone },
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
              label: 'Switch App…',
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
    Menu.buildFromTemplate(template).popup({ window: this.host.win })
  }

  // Plumbing

  patch(patch: Partial<TabState>) {
    this.state = { ...this.state, ...patch }
    this.syncDrawerOutput()
    this.host.tabChanged(this, true)
  }

  /** The preview shows the local app, so the chat can offer to pick an element. */
  private get canSelect() {
    return this.state.preview.visible && this.state.preview.selectable
  }

  private patchPreview(patch: Partial<PreviewState>) {
    const { visible, selecting } = this.state.preview
    this.patch({ preview: { ...this.state.preview, ...patch } })
    const preview = this.state.preview
    this.resources.chat?.setCanSelect(this.canSelect)
    // Picking draws the floating chat as a bubble (see `bubbled`).
    if (preview.visible !== visible || preview.selecting !== selecting) this.layout()
    if (preview.selecting === selecting) return
    if (!preview.selecting && this.picker.picking) {
      this.picker.stop()
      this.syncHighlight()
    }
    this.resources.chat?.setSelecting(preview.selecting)
    const attention = this.panel.takeAttention()
    // A permission card that came up while the user picked shows now, as it would have then.
    if (!preview.selecting && attention && this.resources.chat?.awaitingPermission)
      this.panel.focusChat()
  }

  private send(channel: string, payload: unknown) {
    this.host.sendChrome(this, channel, payload)
  }

  sendChat(channel: string, payload: unknown) {
    if (!this.chatView.webContents.isDestroyed()) this.chatView.webContents.send(channel, payload)
  }

  private onAgentHealth = (agents: TabState['agents']) => this.patch({ agents })

  private onDeveloperTools = (status: DeveloperToolsStatus) =>
    this.patch({ developerTools: shownTools(status) })

  /**
   * Stops the tab's dev server, terminals and agent and closes its pages; it's out of its
   * window.
   */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.panel.dispose()
    agentHealth.off('change', this.onAgentHealth)
    nodeRuntime.off('change', this.onNodeRuntime)
    developerTools.off('change', this.onDeveloperTools)
    this.morph.dispose()
    if (this.rehighlightTimer) clearTimeout(this.rehighlightTimer)
    this.clearGuideEnd()
    this.problems.dispose()
    this.disposeProjectResources()
    this.emulation.dispose()
    this.picker.dispose()
    this.inspector.dispose()
    if (!this.preview.webContents.isDestroyed()) this.preview.webContents.close()
    if (!this.chatView.webContents.isDestroyed()) this.chatView.webContents.close()
  }
}
