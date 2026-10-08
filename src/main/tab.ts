import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { type FSWatcher, watch } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'
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
  screen,
  shell,
  type WebContents,
  WebContentsView,
  type WebFrameMain,
} from 'electron'
import { type ChatMenuChoice, Events } from '../shared/ipc'
import { BUBBLE, MINI, PANEL_SHADOW_MARGIN, TRAFFIC_LIGHTS } from '../shared/layout'
import { project, SPRINGS, type SpringConfig } from '../shared/motion'
import { reviewTitle } from '../shared/review'
import { SHORTCUTS } from '../shared/shortcuts'
import {
  type AgentId,
  agentName,
  type ChatFloat,
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
  type PanelCorner,
  type PanelEdge,
  type Picked,
  type PreviewFrame,
  type PreviewState,
  type ProjectInfo,
  type ProjectSetup,
  type Proposal,
  primaryPick,
  type RecentProject,
  type Rect,
  type RegionContext,
  type ShipInfo,
  type ShipRequest,
  type ShipResult,
  type TabStatus,
  type TerminalId,
  type Viewport,
  type ViewportFrame,
  viewportSpec,
  type WindowState,
  type WorkspaceApp,
} from '../shared/types'
import { agentHealth } from './agent-status'
import { agentMenuItems } from './agents'
import { isAutoApprove, setAutoApprove as saveAutoApprove } from './auto-approve'
import { availableModels, ChatController } from './chat'
import { Checkpoints } from './checkpoints'
import { DevServer } from './dev-server'
import { type DeveloperToolsStatus, developerTools } from './developer-tools'
import {
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
import { type RunningMcpServer, startMcpServer } from './mcp-server'
import { nodeRuntime } from './node-runtime'
import { Flight, type Point, prefersReducedMotion } from './panel-flight'
import { type Outlined, Picker } from './picker'
import { type ChatSize, getPrefs, setPrefs } from './prefs'
import { PreviewMorph } from './preview-morph'
import { PreviewTools } from './preview-tools'
import { Problems } from './problems'
import { detectProject, readPackageJson } from './project'
import type { PromptViewport } from './prompt'
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
import { Recordings } from './recordings'
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
import { Terminals } from './terminals'
import { followSurface, surfaceColor } from './theme'
import { thumbnail } from './thumbnail'
import { askToTrust, isTrusted, promptName, promptText } from './trust'
import { placePreview, ViewportEmulation, type Zoom, zoomed } from './viewport'
import { focusWindow, showWindow } from './window'

const PANEL_MIN = { width: 320, height: 360 }
/** Below this the panel can't show its header, a line of transcript and the composer. */
const PANEL_SHORTEST = 200
/** Space the floating panel's size leaves around it in the window. */
const PANEL_MARGIN = 12
const DOCK_MIN_WIDTH = 320
/** The docked panel leaves the preview at least the rest of the canvas. */
const DOCK_MAX_SHARE = 0.6
/** A screenshot attached to the chat, sized like the composer's images (images.ts). */
const ATTACH_EDGE = 1568
const ATTACH_THUMBNAIL_EDGE = 160
const ATTACH_MAX_PNG_BYTES = 3 * 1024 * 1024
/**
 * Letting go of the floating panel faster than this (px/s) throws it: it lands on a slightly
 * bouncy spring. Slower, it settles into the nearest corner without overshooting.
 */
const THROW_SPEED = 500
/** Faster than any real flick; a glitch in the pointer's history beyond it is capped. */
const MAX_THROW_SPEED = 8000
/**
 * A grab mid-flight puts the panel back where the pointer found it, unless that's further
 * than this from where it's drawn: then the report doesn't match the view, so it stays put.
 */
const GRAB_SLOP = 240
/**
 * The floating view shrinks to a smaller form once the chat reports its morph done; if it
 * doesn't in this long (its page isn't drawing), it shrinks anyway.
 */
const MORPH_TIMEOUT_MS = 700
/**
 * How long after the keyboard leaves the floating chat it tucks into its bubble: long enough
 * that a quick look at the page doesn't set the panel moving, so it reads as getting out of
 * the way once the user has moved on.
 */
const TUCK_DELAY_MS = 2500
/** A window appearing fades in over this long (--motion-fade), unless motion is reduced. */
const WINDOW_FADE_MS = 150

/**
 * Fades a window in as it's shown (a popped-out chat), so it arrives rather than blinks on.
 * Opacity only, which macOS draws for any window; with reduced motion it's simply there.
 */
function fadeIn(win: BrowserWindow) {
  if (prefersReducedMotion()) return
  win.setOpacity(0)
  const start = Date.now()
  const timer = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(timer)
    const t = Math.min(1, (Date.now() - start) / WINDOW_FADE_MS)
    // Eases out, as every arrival does (--ease-out).
    win.setOpacity(1 - (1 - t) ** 3)
    if (t === 1) clearInterval(timer)
  }, 16)
}

/** The floating forms by size: the view grows to a larger one at once. */
const FORM_SIZE: Record<ChatForm, number> = { bubble: 0, pill: 1, panel: 2 }
/** Wait for hot reload to apply before re-finding the element a turn edited. */
const REHIGHLIGHT_DELAY_MS = 900
/** The id a pick goes by in the overlay while it's read, before it has its own */
const PENDING_PICK = 'pending'
/** A package.json being written fires several changes; look once they've settled. */
const APP_CHECK_DELAY_MS = 500
/** Package scripts an install runs from the project's own package.json. */
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

type ScreenshotAction = 'copy' | 'copy-full-page' | 'save' | 'attach'
type ScreenshotResult = 'copied' | 'saved' | 'attached'

/** A corner of the canvas, and how far the floating panel's own corner there is from it. */
interface Anchor extends PanelCorner {
  /** From the canvas's left or right edge */
  dx: number
  /** From the canvas's top or bottom edge */
  dy: number
}

/** What the window shows for its active tab, without the window's own tab strip. */
export type TabState = Omit<
  WindowState,
  'tabs' | 'activeTab' | 'focusMode' | 'shortcutsOpen' | 'fullScreen'
>

/** The window a tab is in (window.ts), as the tab sees it. */
export interface TabHost {
  readonly win: BrowserWindow
  /** Where the chrome renderer's canvas is, which the active tab lays out over. */
  readonly canvas: Rect
  /** The window's chrome above the canvas: the toolbar, and the tab row while it shows. */
  readonly chromeHeight: number
  /** Focus mode: the preview alone, without the chat (WindowState.focusMode). */
  readonly focusMode: boolean
  /**
   * The chrome's shortcuts sheet is over the window, open or still fading out, where the tab's
   * views would hide it.
   */
  readonly sheetShown: boolean
  setFocusMode(on: boolean): void
  /** The tab whose views are in the window; only it lays out and talks to the chrome. */
  isActive(tab: ProjectTab): boolean
  /** The tab's state changed (`stateChanged`), or only what its tab in the strip shows. */
  tabChanged(tab: ProjectTab, stateChanged: boolean): void
  /** Main → the chrome renderer, dropped unless `tab` is the active tab. */
  sendChrome(tab: ProjectTab, channel: string, payload: unknown): void
  /** A project was added to the recent list: every tab's project menu lists it. */
  shareRecent(recent: RecentProject[]): void
}

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

/**
 * One project in a window's tab: its preview and chat views, dev server, terminals, agent,
 * inspector, preview tools and problems, plus where its chat panel sits. Only the window's
 * active tab has its views in the window; the others keep running out of sight.
 */
export class ProjectTab {
  readonly id = `tab-${++lastTabId}`
  private host: TabHost
  private readonly preview: WebContentsView
  private readonly chatView: WebContentsView
  private readonly inspector: Inspector
  /** The page at its viewport's size: a device frame's or zoomed Desktop's; none at 100%. */
  private readonly emulation: ViewportEmulation
  /** Each viewport's zoom, Desktop's at 100% and the frames fitting until the user zooms. */
  private zooms: Record<Viewport, Zoom> = { desktop: 1, laptop: null, tablet: null, mobile: null }
  /** Moves the preview into a new layout by morphing a snapshot of it (preview-morph.ts). */
  private readonly morph: PreviewMorph
  /**
   * Where the preview is laid out, in the window: the view's bounds, except mid-morph, when
   * the view is out of sight. What picks, the chat's dodge and prompts measure against.
   */
  private placement: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private state: TabState
  private devServer: DevServer | null = null
  /** The project's terminals in the drawer; none run until the user opens one. */
  private terminals: Terminals | null = null
  private chat: ChatController | null = null
  /** The chat file this tab's chat writes; claimed so another tab on the folder gets its own. */
  private historyFile: string | null = null
  /** The project `historyFile` is for, which its chat is archived under */
  private historyRoot: string | null = null
  private mcp: RunningMcpServer | null = null
  /** The current project's preview tools; also used to show how a change turned out. */
  private previewTools: PreviewTools | null = null
  recordings: Recordings | null = null

  get recordingSource() {
    return this.preview.webContents.mainFrame
  }

  attachRecording(recording: import('../shared/types').RecordingAttachment) {
    if (!this.chat) return
    this.sendChat(Events.recordingAttach, recording)
    focusWindow(this.popout ?? this.host.win)
    this.focusChat()
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
  /**
   * Where the floating panel sits: by one of its corners, from the canvas's same corner, so it
   * stays there as the window and the logs resize. Letting go of it picks a corner of the
   * canvas, at the standard margin; a drag and a resize move it freely from its corner.
   */
  private anchor: Anchor = { ...getPrefs().chatCorner, dx: PANEL_MARGIN, dy: PANEL_MARGIN }
  /**
   * The floating panel springing to its anchor after a drop, a throw or a dodge: its anchored
   * corner's point is on a spring per axis. Null at rest.
   */
  private flight: Flight | null = null
  /**
   * The docked panel sliding in from the canvas's right edge, covering the preview as its morph
   * narrows it: off to the right (no flight yet) until the morph starts moving, then on a spring
   * of main's, from the same moment as the chrome's.
   */
  private dockSlide: { flight: Flight | null } | null = null
  /** The floating panel's size as the user left it; drawn smaller when the window is. */
  private panelSize: ChatSize = getPrefs().chatSize
  private dockWidth = getPrefs().chatSidebarWidth
  /** Which size the resize in progress changes, to remember it when it ends. */
  private resizing: 'floating' | 'docked' | null = null
  /** What the chat view was last told to draw (Events.chatFloat); null until it's told. */
  private floatShown: ChatFloat | null = null
  /**
   * The form the floating view is sized to. It grows to a larger form at once, and shrinks to a
   * smaller one only once the chat has morphed into it (`chatMorphed`), so the morph isn't cut
   * off by the view's edge.
   */
  private viewForm: ChatForm = 'panel'
  /**
   * The smaller form the view waits to shrink to (as of float `seq`), and the fallback that
   * shrinks it anyway.
   */
  private morphing: { form: ChatForm; seq: number; timer: NodeJS.Timeout } | null = null
  /** Counts changes of the floating form, so a report of a morph that has since turned around is ignored. */
  private formSeq = 0
  private lastForm: ChatForm = 'panel'
  /** A permission card came up while the user picked over the bubble; shown when picking ends. */
  private attentionWaiting = false
  /**
   * The floating panel is tucked into its bubble: the user went back to the page (or the
   * toolbar), so it gets out of the way until they want it again (`untuck`).
   */
  private tucked = false
  private tuckTimer: NodeJS.Timeout | null = null
  /** The chat's own window while it's popped out of this one (`togglePopOut`); null otherwise. */
  private popout: BrowserWindow | null = null
  /** The screenshot menu is open or its capture is running. */
  private screenshotting = false
  /** "Create pull request" has the chat, and ⌘↩ with it (`permissionAnswer`). */
  private shipSheetOpen = false
  private disposed = false
  /** Bumped per openProject; async steps of a superseded open must not touch the window. */
  private openGeneration = 0
  private opening: string | null = null
  /** Pending "after" capture and re-highlight of the element a finished turn edited. */
  private rehighlightTimer: NodeJS.Timeout | null = null
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
      drawer: closedDrawer(),
      recent: recentSoFar(),
      home: app.getPath('home'),
      agents: agentHealth.list(),
      setup: null,
      developerTools: shownTools(developerTools.state),
    }

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

    this.inspector = new Inspector(this.preview.webContents, () => this.emulation.scale)
    this.emulation = new ViewportEmulation(this.inspector)
    this.morph = new PreviewMorph({
      window: () => this.host.win,
      view: this.preview,
      exclusive: (fn) => this.inspector.exclusive(() => fn()),
      send: (event) => this.send(Events.morph, event),
      layout: () => this.layout(),
      moving: (reduced) => this.slideDock(reduced),
      ended: () => this.landDock(),
    })
    this.picker = new Picker(this.preview.webContents, this.inspector, () => this.emulation.scale)
    this.problems.on('change', (problems) => this.chat?.setProblems(problems))
    agentHealth.on('change', this.onAgentHealth)
    nodeRuntime.on('change', this.onNodeRuntime)
    developerTools.on('change', this.onDeveloperTools)

    this.bindPreview()
    guardAppContents(this.chatView.webContents)
    // A reloaded chat page starts from what main tells it next.
    this.chatView.webContents.on('did-start-loading', () => {
      this.floatShown = null
    })
    // The keyboard leaving the floating panel tucks it away; coming back (a click on the
    // bubble, ⌘L) brings it out.
    this.chatView.webContents.on('blur', () => this.scheduleTuck())
    this.chatView.webContents.on('focus', () => this.untuck())
    loadRenderer(this.chatView.webContents, 'chat').catch((error) =>
      console.error('[gui] failed to load chat', error),
    )
    void loadRecent()
      .then(withChats)
      .then((recent) => this.patch({ recent }))
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
    if (this.chat?.awaitingPermission) return 'attention'
    if (this.chat?.turnRunning) return 'working'
    const { devServer, setup } = this.state
    const crashed = devServer.status === 'exited' && devServer.exitCode !== 0
    const failed = this.chat?.meta.status === 'error' || setup?.dependencies === 'failed'
    return crashed || failed ? 'error' : 'idle'
  }

  /** Puts the tab's views in its window, over the chrome, and lays them out. */
  activate() {
    const { contentView } = this.host.win
    contentView.addChildView(this.preview)
    contentView.addChildView(this.picker.view)
    // Popped out, the chat is in its own window, which shows again with its tab.
    if (this.popout) this.popout.showInactive()
    else contentView.addChildView(this.chatView)
    this.layout()
    // A permission card that came up in the background is what the user switched here for
    // (in a focused window: focusing the chat would raise it).
    if (this.chat?.awaitingPermission && this.host.win.isFocused()) this.focusChat()
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
    this.landDock()
    // A panel still landing is where it was going when the tab comes back, in its new form.
    this.flight?.finish()
    this.settleForm(this.wantedForm())
    const { contentView } = this.host.win
    contentView.removeChildView(this.preview)
    contentView.removeChildView(this.picker.view)
    // A background tab's popped-out chat hides, so the one in sight is the tab in sight's.
    if (this.popout) this.popout.hide()
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

  getLogs() {
    return this.devServer?.logs() ?? ''
  }

  /** The dev server's output, for the drawer to draw it from. */
  logsOutput() {
    return this.devServer?.output.snapshot()
  }

  getChat(): ChatSnapshot {
    if (this.chat) return { ...this.chat.snapshot(), float: this.float() }
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
        minimized: false,
        docked: getPrefs().chatSidebar,
        trafficLights: false,
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
      float: this.float(),
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
    const generation = ++this.openGeneration
    this.opening = root
    this.closeProject()
    const current = () => !this.disposed && generation === this.openGeneration
    let file: string | null = null
    try {
      file = await claimHistoryFile(root)
      const [{ project, apps, choosing }, env, saved] = await Promise.all([
        detectProject(root, getPrefs().apps[root] ?? null),
        getShellEnv(),
        loadHistory(file),
      ])
      // Several apps and none picked yet: nothing runs until the user chooses one.
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
        viewScale: () => this.emulation.scale,
        restoreViewport: () => this.emulation.restore(),
      })
      this.previewTools = tools
      this.recordings = new Recordings(root)
      this.recordings.retain(
        saved?.turns.flatMap((turn) => turn.recordings?.map((clip) => clip.id) ?? []) ?? [],
      )
      const mcp = await startMcpServer(tools, this.recordings).catch((error: unknown) => {
        console.error('[gui] preview tools unavailable', error)
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
        docked: getPrefs().chatSidebar,
        saved,
        historyFile: file,
        recordings: this.recordings,
        mcpServers: () => (this.mcp ? [this.mcp.config] : []),
        viewport: () => this.promptViewport(),
      })
      chat.on('meta', (meta) => {
        this.sendChat(Events.chatMeta, meta)
        this.onSelection(meta.selection)
        if (meta.agentId !== this.state.agentId) this.patch({ agentId: meta.agentId })
        this.layout()
        this.host.tabChanged(this, false)
      })
      chat.on('turn', (turn) => {
        this.sendChat(Events.chatTurn, turn)
        // The edited element's highlight would otherwise sit in the next turn's screenshots.
        if (turn.status === 'running') this.cancelRehighlight()
        // Working, or a permission card answered: the tab strip shows it.
        this.host.tabChanged(this, false)
      })
      chat.on('reset', (snapshot) => this.sendChat(Events.chatReset, snapshot))
      chat.on('attention', () => {
        this.onAttention()
        this.host.tabChanged(this, false)
      })
      chat.on('turnEnd', (turn) => {
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
      this.chat = chat
      this.historyFile = file
      this.historyRoot = root
      chat.setCanSelect(this.canSelect)
      this.patch({ agentId: chat.meta.agentId })
      this.sendChat(Events.chatReset, chat.snapshot())

      // The agent, checkpoints and history stay at the root; only the dev server moves into the app.
      const devServer = new DevServer(appRoot(project))
      devServer.on('data', (chunk) => this.send(Events.logs, chunk))
      devServer.on('line', (line) => this.problems.addServerLine(line))
      devServer.on('change', (state) => this.onDevServer(state))
      this.devServer = devServer
      this.apps = apps

      // At the root, like the agent: a monorepo's app is a `cd` away.
      const terminals = new Terminals(project.root)
      terminals.on('data', (output) => this.send(Events.terminalData, output))
      terminals.on('change', () => this.patchDrawer({ terminals: terminals.list() }))
      this.terminals = terminals

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
    } finally {
      if (generation === this.openGeneration) this.opening = null
      // A superseded open never handed its file to a chat.
      if (file && file !== this.historyFile) releaseHistoryFile(file)
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
      message: 'Create a pull request?',
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
    const devServer = this.devServer
    const root = this.state.project?.root
    if (!devServer || !root || this.chat?.turnRunning) return
    const { project, apps, choosing } = await detectProject(root, getPrefs().apps[root] ?? null)
    if (!project.devCommand && !choosing) return
    const setup = await detectSetup(project, choosing ? apps : null)
    if (devServer !== this.devServer || !this.appWatcher) return
    this.stopWatchingForApp()
    this.apps = apps
    devServer.setCwd(appRoot(project))
    this.patch({ project, setup })
    void this.setUpAndStart()
  }

  closeProject() {
    this.recordings?.dispose()
    this.recordings = null
    this.stopWatchingForApp()
    this.cancelRehighlight()
    if (this.rehighlightTimer) clearTimeout(this.rehighlightTimer)
    this.rehighlightTimer = null
    this.devServer?.dispose()
    this.devServer = null
    this.terminals?.dispose()
    this.terminals = null
    this.apps = []
    this.chat?.dispose()
    this.chat = null
    this.retireHistoryFile()
    this.mcp?.close()
    this.mcp = null
    this.previewTools = null
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
      preview: { ...this.state.preview, url: null, error: null, visible: false, selecting: false },
    })
  }

  // Dev server

  /** From the UI; an untrusted project still shows its scripts and asks first. */
  startDevServer() {
    void this.setUpAndStart()
  }

  stopDevServer() {
    void this.devServer?.stop()
  }

  restartDevServer() {
    if (this.devServer?.state.command) void this.devServer.restart()
    else this.startDevServer()
  }

  resizeLogs(cols: number, rows: number) {
    this.devServer?.resize(cols, rows)
  }

  // Drawer: the dev server's output and the terminals

  /**
   * ⌘J: opens the drawer on the tab it showed last (the first time, a terminal, started now if
   * there's none yet) and puts the keyboard in it; open, closes it.
   */
  toggleDrawer() {
    const terminals = this.terminals
    if (!terminals) return
    // In focus mode it's hidden whatever its setting: ⌘J brings it back, with the rest.
    if (this.state.drawer.open && !this.host.focusMode) return this.setDrawerOpen(false)
    this.showDrawer(this.state.drawer.tab ?? terminals.list()[0]?.id ?? terminals.create(), true)
  }

  /** Opened, it shows the tab it showed last; the dev server's output the first time. */
  setDrawerOpen(open: boolean) {
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
    const id = this.terminals?.create()
    if (id) this.showDrawer(id, true)
  }

  /** Ends the terminal's shell; if it was showing, the drawer shows its neighbor instead. */
  closeTerminal(id: TerminalId) {
    const terminals = this.terminals
    if (!terminals?.has(id)) return
    if (this.state.drawer.tab === id) {
      this.patchDrawer({ tab: drawerNeighbor(terminals.list(), id) })
    }
    terminals.close(id)
  }

  restartTerminal(id: TerminalId) {
    this.terminals?.restart(id)
  }

  terminalOutput(id: TerminalId) {
    return this.terminals?.output(id) ?? ''
  }

  writeTerminal(id: TerminalId, data: string) {
    this.terminals?.write(id, data)
  }

  resizeTerminal(id: TerminalId, cols: number, rows: number) {
    this.terminals?.resize(id, cols, rows)
  }

  clearTerminal(id: TerminalId) {
    this.terminals?.clear(id)
  }

  /** The drawer has drawn a view's output up to `end`: the dev server's, or a terminal's. */
  ackOutput(id: string, end: number) {
    if (id === this.devServer?.output.id) this.devServer.output.ack(end)
    else if (isTerminalId(id)) this.terminals?.ack(id, end)
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
    this.devServer?.output.setShown(shown === 'server')
    this.terminals?.show(shown === 'server' ? null : shown)
  }

  /** Only a tab the drawer has: the dev server's output, or one of this project's terminals. */
  private showDrawer(tab: DrawerTab, focus = false) {
    if (!this.terminals || (tab !== 'server' && !this.terminals.has(tab))) return
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
  private leaveFocusMode() {
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
      // Picking ends first; then focus mode. The page gets Esc once neither is on.
      if (this.state.preview.selecting) {
        event.preventDefault()
        void this.setSelecting(false)
      } else if (this.host.focusMode && this.host.isActive(this)) {
        event.preventDefault()
        this.host.setFocusMode(false)
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
    if (on === this.picker.picking) return
    if (!on) {
      this.patchPreview({ selecting: false })
      return
    }
    // Only pick from the local app: what's picked is sent to the agent.
    const local = isLoopback(this.preview.webContents.getURL())
    if (!this.state.preview.visible || !this.chat || !local) return
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
        this.chat?.removeFromSelection(already)
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
    if (this.picker.picking) this.picker.wheel(at, deltaX, deltaY)
  }

  removeSelection(id: string) {
    this.chat?.removeFromSelection(id)
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
    const chat = this.chat
    if (!project || !chat || !isLoopback(this.preview.webContents.getURL())) return
    this.pendingPick = pending
    this.picker.setBusy(true)
    this.syncOutlined()
    try {
      const picked = await read(project)
      if (chat !== this.chat) return
      // The pick's highlight replaces any post-turn one and belongs to the selection.
      this.cancelRehighlight()
      if (add) chat.addToSelection(picked)
      else chat.setSelection([picked])
      if (!add) {
        this.focusChat()
        this.dodge(picked.rect)
      }
    } catch (error) {
      if (chat !== this.chat) return
      const message = error instanceof Error ? error.message : String(error)
      const what = pending.kind === 'region' ? 'area' : 'element'
      chat.setSelectionError(`Couldn't read that ${what}: ${message}`)
      if (!add) this.focusChat()
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
    const outlined = (this.chat?.meta.selection ?? []).flatMap((picked): Outlined[] => {
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
    const selection = this.chat?.meta.selection ?? []
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
  private promptViewport(): PromptViewport {
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
    return this.state.devServer.url ? originOf(this.state.devServer.url) : null
  }

  // Chat

  async sendChatMessage(text: string, images: ImageAttachment[], ids: string[] = []) {
    const recordings = this.recordings
    const chat = this.chat
    if (!chat || !recordings) return false
    try {
      const clips = await recordings.attachments(ids)
      if (this.chat !== chat) return false
      const accepted = chat.send(text, images, clips)
      if (accepted) recordings.retain(ids)
      return accepted
    } catch {
      return false
    }
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
      .filter((prompt) => !prompt.startsWith(CONFLICT_PROMPT_START))
      .map((prompt) => reviewTitle(prompt) ?? prompt)
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

  // The pull request's progress (src/main/proposal.ts)

  /** Null without a project, or before the user lets Gui run Git here (never asks). */
  async getProposal(refresh: boolean): Promise<Proposal | null> {
    const root = this.state.project?.root
    if (!root || !(await isTrusted(root))) return null
    return readProposal(root, refresh)
  }

  async startFresh() {
    const root = await this.gitRootForAction()
    await startFresh(root)
    // The finished idea's chat goes to the archive; the next one starts empty.
    if (this.state.project?.root === root) this.newChat()
  }

  async bringInLatest() {
    await bringInLatest(await this.gitRootForAction())
  }

  async finishMerge() {
    await finishMerge(await this.gitRootForAction())
  }

  async cancelMerge() {
    await cancelMerge(await this.gitRootForAction())
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
    if (this.chat?.busy) throw new Error('Wait for the agent to finish first.')
    if (!(await this.confirmGit(root))) throw new Error('Cancelled.')
    if (this.state.project?.root !== root) throw new Error('No project is open.')
    return root
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
    const devServer = this.devServer
    if (!project || !devServer || setup?.apps) return
    // Undo needs git from the first turn: find out now whether it runs, so a missing install
    // shows as a banner rather than macOS's own prompt mid-turn.
    void developerTools.gitAvailable()
    // Nothing can install or run without Node.js, nor can the agent build an app with it:
    // offer Gui's own first. Once it's set up, this runs again (onNodeRuntime).
    if (await nodeRuntime.missingFor(project.packageManager)) {
      if (devServer === this.devServer) this.patchSetup({ node: nodeRuntime.state })
      return
    }
    if (this.state.setup?.node) this.patchSetup({ node: null })
    if (!project.devCommand) return
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
    void this.devServer?.stop()
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

  removeQueued(id: string) {
    this.chat?.removeQueued(id)
  }

  sendQueuedNow() {
    this.chat?.sendQueuedNow()
  }

  cancelChat() {
    void this.chat?.cancel()
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
    return this.chat?.meta.models ?? null
  }

  setAgentSetting(settingId: string, value: string) {
    this.chat?.setAgentSetting(settingId, value)
  }

  /** Starts the chat's agent early so the command menu can list its commands. */
  loadCommands() {
    return this.chat?.loadCommands()
  }

  /** ⇧⌘M: shows the chat and opens the composer's model picker, searching. */
  chooseModel() {
    if (!this.chat?.meta.models) return shell.beep()
    this.focusChat()
    this.sendChat(Events.command, 'chooseModel')
  }

  respondPermission(turnId: string, itemId: string, optionId: string | null) {
    this.chat?.respondPermission(turnId, itemId, optionId)
  }

  /**
   * What Agent → Allow (⌘↩) or Don't Allow (⌘⌫) answers: the oldest waiting card, with its
   * Allow or Don't Allow (`allow_once`, `reject_once`; never an "always"). Null when no card
   * waits, it doesn't offer that, or the PR sheet has the keys.
   */
  permissionAnswer(allow: boolean) {
    const waiting = this.shipSheetOpen ? null : this.chat?.oldestPermission()
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
    return this.chat?.restoreTurn(turnId)
  }

  redo() {
    return this.chat?.redo()
  }

  newChat() {
    void this.chat?.reset()
  }

  /** Archives the open chat, as New chat does; false when it couldn't be. */
  archiveChat() {
    return this.chat?.reset() ?? Promise.resolve(true)
  }

  /** The chat file this tab's chat writes, if one is open. */
  get chatFile() {
    return this.historyFile
  }

  /** Once its chat has saved for the last time: a second tab's numbered file is archived. */
  private retireHistoryFile() {
    const file = this.historyFile
    const root = this.historyRoot
    this.historyFile = null
    this.historyRoot = null
    if (!file) return
    if (root) void retireHistoryFile(root, file)
    else releaseHistoryFile(file)
  }

  /** The project's archived chats, newest first; none without a project. */
  listChats() {
    const root = this.historyRoot
    return root ? listArchived(root) : Promise.resolve([])
  }

  async openChat(id: string) {
    if (!this.chat) throw new Error('No project is open.')
    await this.chat.openArchived(id)
    this.focusChat()
  }

  async renameChat(id: string, title: string) {
    if (this.historyRoot) await renameArchived(this.historyRoot, id, title)
  }

  async deleteChat(id: string) {
    if (this.historyRoot) await removeArchived(this.historyRoot, id)
  }

  clearSelection() {
    this.chat?.setSelection([])
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
    if (this.popout) return this.popIn()
    this.leaveFocusMode()
    this.untuck()
    this.morphLayout('dock')
    const docked = !this.chat.meta.docked
    setPrefs({ chatSidebar: docked })
    this.chat.setDocked(docked)
    if (!this.state.chatVisible) this.patch({ chatVisible: true })
    if (docked) this.holdDock()
    this.layout()
  }

  signInAgain() {
    return this.chat?.signInAgain() ?? Promise.resolve(false)
  }

  setUpAgent() {
    return this.chat?.setUpAgent() ?? Promise.resolve()
  }

  fixProblems() {
    const sent = this.chat?.fixProblems() ?? false
    if (sent) this.focusChat()
    return sent
  }

  /**
   * Shows the changed element in the turn, next to how it looked when it was picked: framed
   * like the pick's crop, so the two line up (see `matchingArea`). An area is the same part
   * of the page again.
   */
  private async captureAfter(chat: ChatController, turnId: string, shown: Picked) {
    const tools = this.previewTools
    if (!tools || chat !== this.chat || !this.state.preview.visible) return
    const crop = shown.crop ?? null
    const options = isRegion(shown)
      ? { area: crop?.area }
      : { selector: shown.selector, matching: crop ?? undefined }
    const shot = await tools.screenshot(options).catch(() => null)
    if (chat !== this.chat) return
    const frame = shot && crop ? previewFrame(crop.area, shot.area) : null
    chat.setPreviewAfter(turnId, thumbnail(shot), frame)
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
    if (!selector || !this.state.preview.visible || this.chat?.meta.selection.length) return
    const generation = this.rehighlightGeneration
    // A turn or pick can start while this waits on the inspector; checked again under its lock.
    const current = () =>
      generation === this.rehighlightGeneration && !this.chat?.meta.selection.length
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
    // Popped out, it's in a window of its own: ⌘B brings that forward rather than hiding it.
    if (this.popout) return this.focusChat()
    // In focus mode the chat is out of sight whatever its setting: bring everything back.
    if (this.host.focusMode) return this.focusChat()
    // Docked, it takes its column from the preview, or gives it back.
    if (this.docked) this.morphLayout('dock')
    this.patch({ chatVisible: !this.state.chatVisible })
    if (this.state.chatVisible && this.docked) this.holdDock()
    this.layout()
    // While the user picks, showing the chat brings back its bubble and leaves the pick alone.
    if (this.state.chatVisible && !this.bubbled) this.focusChat()
    // Hidden, typing goes to the chrome, not to the panel that just left.
    else if (!this.state.chatVisible && this.host.win.isFocused()) this.host.win.webContents.focus()
  }

  /**
   * ⌘L: the cursor in the chat's message box, showing the chat first if it's hidden (or out of
   * its bubble, or ending a pick). It never hides the chat: ⌘B does (`toggleChat`).
   */
  focusMessageBox() {
    if (!this.hasProject) return
    this.focusChat()
  }

  setMinimized(minimized: boolean) {
    this.cancelTuck()
    this.tucked = false
    this.chat?.setMinimized(minimized)
    this.layout()
  }

  /** The tucked bubble was clicked: the panel comes back, ready to type in. */
  expandChat() {
    this.focusChat()
  }

  /** The chat's own window while popped out, so menus and ⌘W can tell it's this tab's. */
  get popoutWindow() {
    return this.popout
  }

  /** ⌥⌘L and the chat's header button: into a window of its own, or back into this one. */
  togglePopOut() {
    if (!this.hasProject || !this.chat) return
    if (this.popout) this.popIn()
    else this.popOut()
  }

  /**
   * Moves the chat's view into a window of its own, beside this one: the same page, so the
   * conversation, a draft and where it was scrolled to come along. The preview takes the
   * sidebar's room, or the floating panel's place, until it comes back (`popIn`).
   */
  private popOut() {
    this.leaveFocusMode()
    if (this.state.preview.selecting) void this.setSelecting(false)
    this.cancelTuck()
    this.tucked = false
    this.flight?.finish()
    if (this.sidebarShown) this.morphLayout('dock')
    const bounds = this.popoutBounds()
    const win = new BrowserWindow({
      ...bounds,
      minWidth: DOCK_MIN_WIDTH,
      minHeight: PANEL_MIN.height,
      show: false,
      title: `${this.title ?? 'Chat'} — Chat`,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: TRAFFIC_LIGHTS,
      fullscreenable: false,
      backgroundColor: surfaceColor(),
    })
    followSurface(win)
    // Its own page is never used; the chat's view covers it.
    win.webContents.loadURL('about:blank').catch(() => undefined)
    this.popout = win
    if (this.host.isActive(this)) this.host.win.contentView.removeChildView(this.chatView)
    win.contentView.addChildView(this.chatView)
    this.chatView.setVisible(true)
    this.layoutPopout()
    win.on('resize', () => this.layoutPopout())
    // Closing it (its button, ⌘W) brings the chat back rather than losing it.
    win.on('close', (event) => {
      if (this.popout !== win) return
      event.preventDefault()
      this.popIn()
    })
    win.on('page-title-updated', (event) => event.preventDefault())
    this.chat?.setPopped(true)
    if (!this.state.chatVisible) this.patch({ chatVisible: true })
    this.layout()
    win.once('ready-to-show', () => {
      if (this.popout !== win || !this.host.isActive(this)) return
      fadeIn(win)
      showWindow(win)
      this.focusChat()
    })
  }

  /** Back into this window, as the sidebar or the floating panel it was before. */
  private popIn() {
    if (!this.popout) return
    this.closePopout()
    this.chat?.setPopped(false)
    if (this.host.isActive(this)) {
      this.host.win.contentView.addChildView(this.chatView)
      if (this.docked) {
        this.morphLayout('dock')
        this.holdDock()
      }
    }
    if (!this.state.chatVisible) this.patch({ chatVisible: true })
    this.layout()
    focusWindow(this.host.win)
    this.focusChat()
  }

  /** Takes the chat's view out of its window and closes the window, view untouched. */
  private closePopout() {
    const win = this.popout
    if (!win) return
    this.popout = null
    if (!win.isDestroyed()) {
      win.contentView.removeChildView(this.chatView)
      win.destroy()
    }
  }

  /** The chat fills its window; the traffic lights sit in its header, as in the sidebar. */
  private layoutPopout() {
    const win = this.popout
    if (!win || win.isDestroyed()) return
    const [width, height] = win.getContentSize()
    this.chatView.setBounds({ x: 0, y: 0, width, height })
    this.chat?.setTrafficLights(true)
  }

  /**
   * Where the popped-out window opens: as tall as this window and as wide as the chat was,
   * beside it on the right if the screen has room, else on the left, else over its edge.
   */
  private popoutBounds() {
    const main = this.host.win.getBounds()
    const { workArea } = screen.getDisplayMatching(main)
    const width = Math.max(DOCK_MIN_WIDTH, this.docked ? this.dockedWidth() : this.panelSize.width)
    const height = Math.min(main.height, workArea.height)
    const gap = 8
    const right = main.x + main.width + gap
    const left = main.x - gap - width
    const x =
      right + width <= workArea.x + workArea.width
        ? right
        : left >= workArea.x
          ? left
          : Math.max(workArea.x, main.x + main.width - width)
    return { x: Math.round(x), y: Math.max(workArea.y, main.y), width, height }
  }

  /** Tucks the floating panel into its bubble shortly, unless the keyboard comes back. */
  private scheduleTuck() {
    this.cancelTuck()
    this.tuckTimer = setTimeout(() => {
      this.tuckTimer = null
      if (!this.shouldTuck()) return
      this.tucked = true
      this.layout()
    }, TUCK_DELAY_MS)
  }

  /**
   * Only the open floating panel tucks, and only for something else in this window (not a
   * trip to another app). It stays out while it's being moved or resized, while the user
   * picks (that has its own bubble), and while a permission card waits for an answer.
   */
  private shouldTuck() {
    return (
      !this.tucked &&
      !this.disposed &&
      this.chatShown &&
      !this.docked &&
      !this.chat?.meta.minimized &&
      !this.chat?.awaitingPermission &&
      !this.state.preview.selecting &&
      !this.resizing &&
      !this.flight &&
      this.host.isActive(this) &&
      this.host.win.isFocused() &&
      !this.chatView.webContents.isFocused()
    )
  }

  private cancelTuck() {
    if (this.tuckTimer) clearTimeout(this.tuckTimer)
    this.tuckTimer = null
  }

  private untuck() {
    this.cancelTuck()
    if (!this.tucked) return
    this.tucked = false
    this.layout()
  }

  /**
   * The pointer pressed the panel's header (or the pill) to drag it. Still landing from a
   * throw, it stops where it was when pressed, so the drag carries on with the pointer where it
   * grabbed: main's timer may have moved it a step or two since.
   */
  grabChat(at: ChatGrab) {
    if (!this.flight) return
    const [contentWidth, contentHeight] = this.host.win.getContentSize()
    const drawn = this.floatingRect(contentWidth, contentHeight)
    const view = this.floatingBounds(contentWidth, contentHeight, this.viewForm)
    // Where the view was under the pointer: the pointer, less where it was in the view's page.
    const content = this.host.win.getContentBounds()
    const zoom = this.chatView.webContents.getZoomFactor()
    const dx = Math.round(at.screenX - content.x - at.clientX * zoom) - view.x
    const dy = Math.round(at.screenY - content.y - at.clientY * zoom) - view.y
    const near = Math.abs(dx) <= GRAB_SLOP && Math.abs(dy) <= GRAB_SLOP
    this.holdFlight(near ? { ...drawn, x: drawn.x + dx, y: drawn.y + dy } : drawn)
    this.layoutChat()
  }

  dragChat(dx: number, dy: number) {
    // A drag without a grab (from a script) takes over a landing panel just the same.
    this.holdFlight()
    // From where the panel is on screen, so dragging back from past an edge moves it at once.
    const [contentWidth, contentHeight] = this.host.win.getContentSize()
    const rect = this.floatingRect(contentWidth, contentHeight)
    const area = this.anchorArea(contentWidth, contentHeight)
    this.anchor = anchorFor({ ...rect, x: rect.x + dx, y: rect.y + dy }, area, this.anchor)
    this.layoutChat()
  }

  /**
   * Lets go of the panel: it springs into a corner of the canvas. Which one is chosen from
   * where its momentum would carry it (`project`), so a flick lands where it was thrown, and
   * the spring starts at the pointer's velocity. A throw lands on a slightly bouncy spring; a
   * slow drop settles without overshooting.
   */
  endDragChat(release: Point = { x: 0, y: 0 }) {
    this.holdFlight()
    const [contentWidth, contentHeight] = this.host.win.getContentSize()
    const rect = this.floatingRect(contentWidth, contentHeight)
    const area = this.anchorArea(contentWidth, contentHeight)
    const speed = Math.hypot(release.x, release.y)
    const cap = speed > MAX_THROW_SPEED ? MAX_THROW_SPEED / speed : 1
    const velocity = { x: release.x * cap, y: release.y * cap }
    const landing = {
      x: project(rect.x + rect.width / 2, velocity.x),
      y: project(rect.y + rect.height / 2, velocity.y),
    }
    this.anchor = {
      x: landing.x < area.x + area.width / 2 ? 'left' : 'right',
      y: landing.y < area.y + area.height / 2 ? 'top' : 'bottom',
      dx: PANEL_MARGIN,
      dy: PANEL_MARGIN,
    }
    // Later tabs start in the corner it was put in.
    setPrefs({ chatCorner: { x: this.anchor.x, y: this.anchor.y } })
    this.fly(rect, velocity, speed > THROW_SPEED ? SPRINGS.thrown : SPRINGS.default)
  }

  /** The chat has morphed into `form` (float `seq`): the view can shrink to it now. */
  chatMorphed(form: ChatForm, seq: number) {
    if (this.morphing?.form !== form || this.morphing.seq !== seq) return
    this.settleForm(form)
    this.layoutChat()
  }

  /**
   * Chat panel resizing by a pointer delta from one of its edges or corners: the dragged edges
   * follow the pointer and the opposite ones stay where they are. As the sidebar, only its
   * right edge resizes it.
   */
  resizeChat(edge: PanelEdge, dx: number, dy: number) {
    if (!this.state.chatVisible || !this.hasProject) return
    if (this.docked) {
      if (edge !== 'right') return
      const width = this.dockedWidth() + dx
      const [contentWidth] = this.host.win.getContentSize()
      this.dockWidth = Math.round(clamp(width, DOCK_MIN_WIDTH, contentWidth * DOCK_MAX_SHARE))
      this.resizing = 'docked'
    } else {
      if (this.chat?.meta.minimized || this.bubbled) return
      // Resizing follows the pointer 1:1: a panel still landing stops where it is.
      this.holdFlight()
      const [contentWidth, contentHeight] = this.host.win.getContentSize()
      const area = this.anchorArea(contentWidth, contentHeight)
      const max = maxFloatingSize(contentWidth, area)
      // From the panel on screen, which may be smaller than the remembered size.
      const panel = this.floatingRect(contentWidth, contentHeight)
      let left = panel.x
      let top = panel.y
      let right = panel.x + panel.width
      let bottom = panel.y + panel.height
      // In whole pixels, each dragged edge stopping at the panel's smallest and largest size,
      // at the window's edges, below the toolbar and above the logs.
      const [moveX, moveY] = [Math.round(dx), Math.round(dy)]
      if (edge.includes('left')) {
        const leftmost = Math.max(0, right - max.width)
        left = clamp(left + moveX, leftmost, right - PANEL_MIN.width)
      } else if (edge.includes('right')) {
        const rightmost = Math.min(contentWidth, left + max.width)
        right = clamp(right + moveX, left + PANEL_MIN.width, rightmost)
      }
      if (edge.startsWith('top')) {
        const highest = Math.max(this.host.chromeHeight, bottom - max.height)
        top = clamp(top + moveY, highest, bottom - PANEL_MIN.height)
      } else if (edge.startsWith('bottom')) {
        const lowest = Math.min(area.y + area.height, top + max.height)
        bottom = clamp(bottom + moveY, top + PANEL_MIN.height, lowest)
      }
      this.panelSize = { width: right - left, height: bottom - top }
      this.anchor = anchorFor({ x: left, y: top, ...this.panelSize }, area, this.anchor)
      this.resizing = 'floating'
    }
    this.layout()
  }

  /** Remembers the new size for this and later tabs. */
  endResizeChat() {
    if (this.resizing === 'docked') {
      setPrefs({ chatSidebarWidth: this.dockWidth })
    } else if (this.resizing === 'floating') {
      setPrefs({ chatSize: this.panelSize })
      this.settleAnchor()
    }
    this.resizing = null
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
    const tools = this.previewTools
    const project = this.state.project
    if (this.screenshotting) return null
    if (!tools || !project || !this.canCapture()) {
      shell.beep()
      return null
    }
    this.screenshotting = true
    try {
      const action = await this.chooseScreenshot(at && this.inWindow(sender, at))
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
        item('Attach to chat', 'attach', this.chat !== null),
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
    if (!this.chat) return false
    const image = nativeImage.createFromBuffer(png)
    if (image.isEmpty()) throw new Error("Couldn't read the captured image")
    this.focusChat()
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

  private focusChat() {
    this.leaveFocusMode()
    this.cancelTuck()
    this.tucked = false
    // Popped out: its window comes forward, with the cursor in the message box.
    if (this.popout) {
      if (!this.host.isActive(this)) return
      focusWindow(this.popout)
      this.chatView.webContents.focus()
      this.sendChat(Events.chatFocus, null)
      return
    }
    // The floating panel is wanted in full, so picking over it ends first.
    if (this.state.preview.selecting && this.hasProject && !this.docked) {
      void this.setSelecting(false).then(() => {
        if (!this.state.preview.selecting) this.focusChat()
      })
      return
    }
    if (!this.state.chatVisible) {
      if (this.docked) {
        this.morphLayout('dock')
        this.holdDock()
      }
      this.patch({ chatVisible: true })
    }
    if (this.chat?.meta.minimized) this.chat.setMinimized(false)
    this.layout()
    // In a background tab the panel is ready for when the user switches to it.
    if (!this.host.isActive(this)) return
    this.chatView.webContents.focus()
    this.sendChat(Events.chatFocus, null)
  }

  /**
   * Something needs the user, such as a permission card. While they pick over the floating
   * panel it stays a bubble, with a badge, rather than cover the page; the card shows when
   * picking ends.
   */
  private onAttention() {
    if (!this.state.preview.selecting || this.docked) return this.focusChat()
    this.attentionWaiting = true
    if (!this.state.chatVisible) {
      this.patch({ chatVisible: true })
      this.layout()
    }
  }

  /** Docked to the side: the chat's own setting, or the saved one while a project opens. */
  private get docked() {
    return this.chat?.meta.docked ?? getPrefs().chatSidebar
  }

  /**
   * While the user picks an element, the floating panel is drawn as a bubble at its anchored
   * corner, out of the way. Its size, place and minimized state stay as they were.
   */
  private get bubbled() {
    return this.state.preview.selecting && this.chatShown && !this.docked
  }

  // Layout

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
    // Where the view goes: here, or mid-morph out of sight at this size; frozen, nowhere yet.
    const [, contentHeight = 0] = this.host.win.getContentSize()
    const placed = { rect: bounds, scale: emulation?.scale ?? 1, frame: frame ? viewport : null }
    const at = this.morph.place(placed, contentHeight)
    if (at) this.preview.setBounds(at)
    this.preview.setVisible(visible)
    // Picking needs the page on screen, where the overlay lies over it.
    if (this.picker.picking) {
      if (visible) this.picker.setBounds(bounds)
      else void this.setSelecting(false)
    }
    // Frozen, the emulation waits behind the morph's capture in the inspector's lock, and the
    // chrome's device frame stays around the view where it is, until the morph draws it.
    this.emulation.set(emulation)
    if (!this.morph.frozen) {
      const rect = inCanvas(bounds, this.host.canvas)
      this.showFrame(frame ? { viewport, rect, scale: frame.scale } : null)
    }
    this.layoutChat()
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

  /** The chrome has the morph's snapshot on screen; false when it's not this tab's morph. */
  morphShown(id: number) {
    return this.morph.snapshotShown(id)
  }

  morphLanded(id: number, seq: number) {
    this.morph.landed(id, seq)
  }

  cancelMorph(id: number) {
    this.morph.cancel(id)
  }

  /**
   * Places the chat view: docked, or floating at its anchor (or where its flight has got to) as
   * the panel, the pill or the bubble.
   */
  private layoutChat() {
    if (this.disposed || !this.host.isActive(this)) return
    this.syncSidebarWidth()
    if (this.popout) return
    const [contentWidth, contentHeight] = this.host.win.getContentSize()
    const showChat = this.chatShown
    // While a project opens there's no chat yet; the panel renders from prefs meanwhile.
    const docked = showChat && this.docked
    const covered = this.host.sheetShown
    const float = this.float()
    const { form } = float
    // Hidden or docked, a panel still landing is simply there, already in its new form; the
    // chat page is told too, so it isn't still morphing when it's floating in sight again.
    if (!showChat || docked) {
      this.flight?.finish()
      this.settleForm(form)
      this.showFloat(float)
    }
    this.chatView.setVisible(showChat && !covered)
    this.chat?.setTrafficLights(docked && !this.host.win.isFullScreen())
    if (docked) {
      const dockWidth = this.dockedWidth()
      // Still off past the window's left edge while it slides in (`holdDock`).
      const slide = this.dockSlide ? (this.dockSlide.flight?.point.x ?? dockWidth) : 0
      this.chatView.setBounds({
        x: -Math.round(slide),
        y: 0,
        width: dockWidth,
        height: Math.max(0, contentHeight),
      })
      return
    }
    if (!showChat) return
    // Growing, the view makes room first and the chat morphs into it; shrinking, the chat
    // morphs first (the smaller form drawn in the view's anchored corner) and says when.
    if (FORM_SIZE[form] > FORM_SIZE[this.viewForm]) this.settleForm(form)
    else if (form !== this.viewForm) this.awaitMorph(form)
    else this.settleForm(form)
    this.chatView.setBounds(this.floatingBounds(contentWidth, contentHeight, this.viewForm))
    this.showFloat(float)
  }

  /** What the floating chat should be drawn as now. */
  private wantedForm(): ChatForm {
    if (this.bubbled) return 'bubble'
    if (this.tucked && this.chatShown && !this.docked && !this.chat?.meta.minimized) return 'bubble'
    return this.chat?.meta.minimized ? 'pill' : 'panel'
  }

  private float(): ChatFloat {
    const form = this.wantedForm()
    if (form !== this.lastForm) {
      this.lastForm = form
      this.formSeq++
    }
    return { form, corner: { x: this.anchor.x, y: this.anchor.y }, seq: this.formSeq }
  }

  /** The view is sized to `form` from now on; any wait to shrink is over. */
  private settleForm(form: ChatForm) {
    this.viewForm = form
    if (this.morphing) clearTimeout(this.morphing.timer)
    this.morphing = null
  }

  /** Waits for the chat to morph into `form` before shrinking the view to it. */
  private awaitMorph(form: ChatForm) {
    if (this.morphing?.form === form && this.morphing.seq === this.formSeq) return
    if (this.morphing) clearTimeout(this.morphing.timer)
    const seq = this.formSeq
    const timer = setTimeout(() => this.chatMorphed(form, seq), MORPH_TIMEOUT_MS)
    this.morphing = { form, seq, timer }
  }

  /**
   * The floating view for `form`: the panel, or the pill while minimized, at its anchor (or
   * mid-flight); the bubble sits in the anchored corner of either.
   */
  private floatingBounds(contentWidth: number, contentHeight: number, form: ChatForm): Rect {
    const base =
      form === 'bubble'
        ? this.floatingRect(contentWidth, contentHeight)
        : this.floatingRect(contentWidth, contentHeight, form)
    const { x, y, width, height } = form === 'bubble' ? inCorner(base, BUBBLE, this.anchor) : base
    return {
      x: x - PANEL_SHADOW_MARGIN,
      y: y - PANEL_SHADOW_MARGIN,
      width: width + PANEL_SHADOW_MARGIN * 2,
      height: height + PANEL_SHADOW_MARGIN * 2,
    }
  }

  /**
   * The floating panel, or the pill while minimized, as drawn: at its anchor, or mid-flight
   * with its anchored corner where the flight has got to. Kept inside the window below the
   * toolbar, and above the logs drawer when it's open.
   */
  private floatingRect(
    contentWidth: number,
    contentHeight: number,
    shape: 'panel' | 'pill' = this.chat?.meta.minimized ? 'pill' : 'panel',
    /** Where it rests at its anchor, even mid-flight */
    atRest = false,
  ): Rect {
    const { width, height } =
      shape === 'pill' ? MINI : this.floatingSize(contentWidth, contentHeight)
    const area = this.anchorArea(contentWidth, contentHeight)
    const { x, y, dx, dy } = this.anchor
    // The anchored corner's point: the flight's, or the anchor's.
    const corner = (!atRest && this.flight?.point) || {
      x: x === 'left' ? area.x + dx : area.x + area.width - dx,
      y: y === 'top' ? area.y + dy : area.y + area.height - dy,
    }
    const left = x === 'left' ? corner.x : corner.x - width
    const top = y === 'top' ? corner.y : corner.y - height
    return {
      x: Math.round(clamp(left, 0, contentWidth - width)),
      y: Math.round(clamp(top, this.host.chromeHeight, area.y + area.height - height)),
      width,
      height,
    }
  }

  /** Where the floating panel's anchored corner is when at rest at its anchor. */
  private restingCorner(): Point {
    const [contentWidth, contentHeight] = this.host.win.getContentSize()
    return cornerPoint(this.floatingRect(contentWidth, contentHeight, undefined, true), this.anchor)
  }

  /**
   * Springs the floating panel from `from` (as drawn) to its anchor, starting at `velocity`
   * (px/s). With Reduce motion on, or out of sight, it's there at once.
   */
  private fly(from: Rect, velocity: Point, config: SpringConfig) {
    this.flight?.stop()
    this.flight = null
    if (prefersReducedMotion() || !this.host.isActive(this) || !this.chatShown) {
      this.layoutChat()
      return
    }
    const flight: Flight = new Flight({
      win: this.host.win,
      from: cornerPoint(from, this.anchor),
      velocity,
      config,
      target: () => this.restingCorner(),
      frame: () => this.layoutChat(),
      rest: () => {
        if (this.flight === flight) this.flight = null
        this.layoutChat()
      },
    })
    this.flight = flight
    this.layoutChat()
  }

  /**
   * Stops a landing panel where it is (or at `at`): anchored from there, as a drag leaves it,
   * so the user can take it over mid-flight.
   */
  private holdFlight(at?: Rect) {
    if (!this.flight) return
    const [contentWidth, contentHeight] = this.host.win.getContentSize()
    const rect = at ?? this.floatingRect(contentWidth, contentHeight)
    this.flight.stop()
    this.flight = null
    this.anchor = anchorFor(rect, this.anchorArea(contentWidth, contentHeight), this.anchor)
  }

  /**
   * The sidebar coming into sight with a morph of the preview (docking, or showing it docked)
   * waits past the window's left edge until the morph moves. Without a morph it's simply there.
   */
  private holdDock() {
    this.dockSlide?.flight?.stop()
    this.dockSlide = this.morph.active ? { flight: null } : null
  }

  /** The preview's morph starts moving: the docked panel slides in with it (or, reduced, is there). */
  private slideDock(reduced: boolean) {
    const slide = this.dockSlide
    if (!slide || slide.flight) return
    if (reduced || !this.chatShown || !this.docked || !this.host.isActive(this)) {
      this.dockSlide = null
      this.layoutChat()
      return
    }
    const flight: Flight = new Flight({
      win: this.host.win,
      from: { x: this.dockedWidth(), y: 0 },
      velocity: { x: 0, y: 0 },
      config: SPRINGS.default,
      target: () => ({ x: 0, y: 0 }),
      frame: () => this.layoutChat(),
      rest: () => {
        if (this.dockSlide?.flight === flight) this.dockSlide = null
        this.layoutChat()
      },
    })
    slide.flight = flight
  }

  /** The morph is over: the docked panel is in its place. */
  private landDock() {
    const slide = this.dockSlide
    if (!slide) return
    if (slide.flight) return slide.flight.finish()
    this.dockSlide = null
    this.layoutChat()
  }

  /** What the anchor is a corner of: the canvas, or the window below the toolbar until then. */
  private anchorArea(contentWidth: number, contentHeight: number): Rect {
    const { canvas, chromeHeight } = this.host
    if (canvas.width > 0 && canvas.height > 0) return canvas
    return { x: 0, y: chromeHeight, width: contentWidth, height: contentHeight - chromeHeight }
  }

  /**
   * After a resize, which leaves the panel where the user put its edges: anchors it there by
   * its corner nearest the canvas's same corner.
   */
  private settleAnchor() {
    const [contentWidth, contentHeight] = this.host.win.getContentSize()
    const rect = this.floatingRect(contentWidth, contentHeight)
    const area = this.anchorArea(contentWidth, contentHeight)
    this.anchor = anchorFor(rect, area, {
      x: rect.x + rect.width / 2 < area.x + area.width / 2 ? 'left' : 'right',
      y: rect.y + rect.height / 2 < area.y + area.height / 2 ? 'top' : 'bottom',
    })
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

  /** Tells the chat view what to draw and where it's anchored, when that changes. */
  private showFloat(float: ChatFloat) {
    const shown = this.floatShown
    const same =
      shown?.form === float.form &&
      shown.corner.x === float.corner.x &&
      shown.corner.y === float.corner.y
    if (same) return
    this.floatShown = float
    this.sendChat(Events.chatFloat, float)
  }

  /**
   * The chat shows: the user hasn't hidden it, there's a project to chat about, and the window
   * isn't in focus mode.
   */
  /** The chat shows in this window: the sidebar or the floating panel (not popped out). */
  private get chatShown() {
    return this.state.chatVisible && this.hasProject && !this.host.focusMode && !this.popout
  }

  /** Where the preview goes: the canvas, less the column a docked panel takes on its right. */
  /** The canvas: the chrome lays it out right of the sidebar (`sidebarWidth`) already. */
  private previewArea(): Rect {
    return this.host.canvas
  }

  /** The sidebar's width: the remembered one, within its share of the window. */
  private dockedWidth() {
    const [contentWidth] = this.host.win.getContentSize()
    return Math.round(clamp(this.dockWidth, DOCK_MIN_WIDTH, contentWidth * DOCK_MAX_SHARE))
  }

  /** The chat shows as the window's left sidebar. */
  get sidebarShown() {
    return this.chatShown && this.docked
  }

  /**
   * Tells the chrome how much room to leave on the left: it lays out the tab row, toolbar,
   * canvas and drawer right of it, and reports the canvas back (`setCanvasRect`).
   */
  private syncSidebarWidth() {
    const width = this.sidebarShown ? this.dockedWidth() : 0
    if (width !== this.state.sidebarWidth) this.patch({ sidebarWidth: width })
  }

  /** The floating panel's size: the remembered one, within the window and the canvas's height. */
  private floatingSize(contentWidth: number, contentHeight: number): ChatSize {
    const max = maxFloatingSize(contentWidth, this.anchorArea(contentWidth, contentHeight))
    // A canvas shorter than the panel's minimum (a short window with the logs open) wins over
    // it, so the panel never hangs over the logs; the remembered size returns with the room.
    const height = Math.min(clamp(this.panelSize.height, PANEL_MIN.height, max.height), max.height)
    return {
      width: Math.round(clamp(this.panelSize.width, PANEL_MIN.width, max.width)),
      height: Math.round(Math.max(height, PANEL_SHORTEST)),
    }
  }

  /** Moves the floating panel to the other side if it covers the element just picked. */
  private dodge(rect: Rect) {
    // Picking again already: the view is the bubble, not the panel to move.
    if (!this.chat || this.chat.meta.docked || !this.chatShown || this.bubbled) return
    // Page coordinates, which a device frame or a zoom draws at its scale, in the window.
    const previewBounds = this.placement
    const scale = this.emulation.scale
    const element = {
      x: previewBounds.x + rect.x * scale,
      y: previewBounds.y + rect.y * scale,
      width: rect.width * scale,
      height: rect.height * scale,
    }
    const view = this.chatView.getBounds()
    const panel = {
      x: view.x + PANEL_SHADOW_MARGIN,
      y: view.y + PANEL_SHADOW_MARGIN,
      width: view.width - PANEL_SHADOW_MARGIN * 2,
      height: view.height - PANEL_SHADOW_MARGIN * 2,
    }
    const overlaps =
      element.x < panel.x + panel.width &&
      element.x + element.width > panel.x &&
      element.y < panel.y + panel.height &&
      element.y + element.height > panel.y
    if (!overlaps) return
    const [contentWidth, contentHeight] = this.host.win.getContentSize()
    const area = this.anchorArea(contentWidth, contentHeight)
    const elementCenter = element.x + element.width / 2
    // Put the panel against whichever side of the canvas is farther from the element: it
    // springs there from where it is, still moving if it was landing.
    const x = elementCenter > area.x + area.width / 2 ? 'left' : 'right'
    // (Landing, the anchor is already where it was going.)
    const from = this.floatingRect(contentWidth, contentHeight)
    const velocity = this.flight?.velocity ?? { x: 0, y: 0 }
    this.anchor = { ...this.anchor, x, dx: PANEL_MARGIN }
    this.fly(from, velocity, SPRINGS.default)
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
    const window = sender === this.chatView.webContents && this.popout ? this.popout : this.host.win
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
      {
        label: ship.open ? 'Close Pull Request' : 'Create Pull Request…',
        enabled: !ship.busy,
        click: () => choose('pullRequest'),
      },
      { label: 'Archived Chats', click: () => choose('archive') },
      { type: 'separator' },
      {
        label: this.popout ? 'Back to Window' : 'Pop Out Chat',
        accelerator: SHORTCUTS.popOutChat.accelerator,
        registerAccelerator: false,
        click: () => this.togglePopOut(),
      },
    ]
    const window = this.popout ?? this.host.win
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
    const inChat = sender === this.chatView.webContents && !this.popout
    const view = inChat ? this.chatView.getBounds() : { x: 0, y: 0 }
    return { x: Math.round(view.x + at.x), y: Math.round(view.y + at.y) }
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

  private patch(patch: Partial<TabState>) {
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
    this.chat?.setCanSelect(this.canSelect)
    // Picking draws the floating chat as a bubble (see `bubbled`).
    if (preview.visible !== visible || preview.selecting !== selecting) this.layout()
    if (preview.selecting === selecting) return
    if (!preview.selecting && this.picker.picking) {
      this.picker.stop()
      this.syncHighlight()
    }
    this.chat?.setSelecting(preview.selecting)
    const attention = this.attentionWaiting
    this.attentionWaiting = false
    // A permission card that came up while the user picked shows now, as it would have then.
    if (!preview.selecting && attention && this.chat?.awaitingPermission) this.focusChat()
  }

  private send(channel: string, payload: unknown) {
    this.host.sendChrome(this, channel, payload)
  }

  private sendChat(channel: string, payload: unknown) {
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
    this.cancelTuck()
    this.closePopout()
    agentHealth.off('change', this.onAgentHealth)
    nodeRuntime.off('change', this.onNodeRuntime)
    developerTools.off('change', this.onDeveloperTools)
    this.flight?.stop()
    this.morph.dispose()
    this.dockSlide?.flight?.stop()
    if (this.morphing) clearTimeout(this.morphing.timer)
    if (this.rehighlightTimer) clearTimeout(this.rehighlightTimer)
    this.problems.dispose()
    // Async work still in flight checks these against what it started with; clearing them
    // is what tells it the project is gone.
    this.stopWatchingForApp()
    this.devServer?.dispose()
    this.devServer = null
    this.terminals?.dispose()
    this.terminals = null
    this.chat?.dispose()
    this.chat = null
    this.retireHistoryFile()
    this.mcp?.close()
    this.mcp = null
    this.previewTools = null
    this.emulation.dispose()
    this.picker.dispose()
    this.inspector.dispose()
    this.recordings?.dispose()
    this.recordings = null
    if (!this.preview.webContents.isDestroyed()) this.preview.webContents.close()
    if (!this.chatView.webContents.isDestroyed()) this.chatView.webContents.close()
  }
}

/** App UI never navigates; links open in the user's browser instead. */

/** What the ship sheet shows when the user didn't let Gui run Git. */
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

/** `rect` (window coordinates) in the canvas's own. */
function inCanvas(rect: Rect, canvas: Rect): Rect {
  return { ...rect, x: rect.x - canvas.x, y: rect.y - canvas.y }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

/**
 * Where the before image sits in a larger after image, when the element changed size
 * (page coordinates in, the after image's own coordinates out). Null when both show the
 * same area, or the after image doesn't cover the before one.
 */
function previewFrame(before: Rect, after: Rect): PreviewFrame | null {
  const same =
    Math.abs(before.width - after.width) <= 1 && Math.abs(before.height - after.height) <= 1
  const covers =
    before.x >= after.x - 1 &&
    before.y >= after.y - 1 &&
    before.x + before.width <= after.x + after.width + 1 &&
    before.y + before.height <= after.y + after.height + 1
  if (same || !covers) return null
  return {
    width: after.width,
    height: after.height,
    before: { ...before, x: before.x - after.x, y: before.y - after.y },
  }
}

/** The anchor at `corner` of `area` (the canvas) that puts the floating panel at `rect`. */
function anchorFor(rect: Rect, area: Rect, corner: PanelCorner): Anchor {
  return {
    x: corner.x,
    y: corner.y,
    dx: corner.x === 'left' ? rect.x - area.x : area.x + area.width - rect.x - rect.width,
    dy: corner.y === 'top' ? rect.y - area.y : area.y + area.height - rect.y - rect.height,
  }
}

/** The point at `rect`'s `corner`. */
function cornerPoint(rect: Rect, corner: PanelCorner): Point {
  return {
    x: corner.x === 'left' ? rect.x : rect.x + rect.width,
    y: corner.y === 'top' ? rect.y : rect.y + rect.height,
  }
}

/** A box of `size` in `rect`'s `corner`. */
function inCorner(rect: Rect, size: ChatSize, corner: PanelCorner): Rect {
  return {
    x: corner.x === 'left' ? rect.x : rect.x + rect.width - size.width,
    y: corner.y === 'top' ? rect.y : rect.y + rect.height - size.height,
    width: size.width,
    height: size.height,
  }
}

/** The largest the floating panel can be: the window's width, the canvas's (`area`) height. */
function maxFloatingSize(contentWidth: number, area: Rect): ChatSize {
  return {
    width: contentWidth - PANEL_MARGIN * 2,
    height: area.height - PANEL_MARGIN * 2,
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

/** What the window says about Apple's developer tools: nothing until they're found missing. */
function shownTools(status: DeveloperToolsStatus): WindowState['developerTools'] {
  return status === 'missing' || status === 'installing' ? status : null
}
