import { randomUUID } from 'node:crypto'
import { type FSWatcher, watch } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, posix } from 'node:path'
import {
  app,
  ClipboardItem,
  clipboard,
  dialog,
  type Event,
  type Input,
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
  BOARD_MANIFEST,
  type BoardCamera,
  exportPaths,
  FRAME_PRESETS,
  FRAMES_DIR,
  type FramePreset,
  frameId,
  isFrameId,
  parseManifest,
} from '../shared/board'
import { viewPointFrom } from '../shared/coords'
import {
  type ChatMenuChoice,
  Events,
  type FrameArrangement,
  type GuidePointerPhase,
} from '../shared/ipc'
import { RULER_SIZE } from '../shared/layout'
import { SHORTCUTS } from '../shared/shortcuts'
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
  frameViewport,
  type ImageAttachment,
  isCustomViewport,
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
  primaryPick,
  type RecentBoard,
  type RecentProject,
  type Rect,
  type RegionContext,
  type StartCommandInput,
  type TabStatus,
  type TerminalId,
  type VariationAction,
  type Viewport,
  type ViewportFrame,
  viewportSpec,
  type WorkspaceApp,
} from '../shared/types'
import { agentHealth } from './agent-status'
import { agentMenuItems, declaresOwnPermissions } from './agents'
import { isAutoApprove, setAutoApprove as saveAutoApprove } from './auto-approve'
import { boardIdOf, listBoards, writeManifest } from './board'
import { BoardSession } from './board-session'
import { createBoardTools } from './board-tool-workflow'
import { branchStatus } from './branch'
import { mergeLayout, nextFrameName, sameLayout } from './canvas-layout'
import { availableModels, type BoardLayout, ChatController } from './chat'
import { Checkpoints } from './checkpoints'
import { DevServer } from './dev-server'
import { type DeveloperToolsStatus, developerTools } from './developer-tools'
import { Guides } from './guides'
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
import { recordInstall } from './install-state'
import { crashFailure, loadFailure } from './load-failure'
import { isLoopback } from './loopback'
import { describeTurns, describeVersions } from './mcp-app-tools'
import { startMcpServer } from './mcp-server'
import { nodeRuntime } from './node-runtime'
import { type Outlined, Picker } from './picker'
import { getPrefs, setPrefs } from './prefs'
import { PreviewMorph } from './preview-morph'
import { PreviewTools } from './preview-tools'
import { Problems } from './problems'
import { execFile } from './process'
import { detectProject } from './project'
import { retireProject, waitForRetiredProject } from './project-handoff'
import { ProjectResources } from './project-resources'
import type { PromptBoard, PromptGuides, PromptViewport } from './prompt'
import { addRecent, loadRecent, recentSoFar, withChats } from './recent'
import { type CursorFrame, CursorTrack } from './recording-cursor'
import { RecordingTrace } from './recording-trace'
import { Recordings } from './recordings'
import { guardAppContents, loadRenderer, PRELOAD, PREVIEW_PRELOAD } from './renderer'
import {
  createEnvFile,
  detectEnv,
  detectSetup,
  envFile,
  type InstallTarget,
  installCommand,
  installsNeeded,
  installTargets,
  missingPackageManager,
  packageManagerOf,
  recordInstalled,
  settleSetup,
} from './setup'
import { getShellEnv } from './shell-env'
import { resolveProject, saveStartCommand, validateStartCommand } from './start-commands'
import {
  agreedScripts,
  type CurrentScripts,
  changedInstalls,
  scriptsOf,
  startChanged,
  startKey,
} from './start-scripts'
import { reloadsItself, StartWatch, startDirs, startSignature } from './start-watch'
import { describeServer, logTail, startupFailure, startupReport } from './startup'
import { PREVIEW_PARTITION } from './storage'
import { ChatPanel, type ChatPanelOwner } from './tab-chat-panel'
import {
  appRoot,
  chatImage,
  frameError,
  inCanvas,
  needsNode,
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
import {
  askToTrust,
  isTrusted,
  promptName,
  promptText,
  recordTrustedScripts,
  type TrustedScripts,
  trust,
  trustedScripts,
} from './trust'
import { Variations } from './variations'
import { placePreview, ViewportEmulation, type Zoom, zoomed } from './viewport'
import { isPublicWebsite, LOCAL_ADDRESS } from './web-session'
import { Website, type WebsiteHooks } from './website'
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
/**
 * A frame's page that hasn't committed (stuck behind a page that hung) or still hasn't loaded
 * this long after it was opened is checked: if its process doesn't answer, Gui stops it.
 */
const FRAME_LOAD_CHECK_MS = 4000
/** How long a frame's page has to answer that check */
const FRAME_ANSWER_MS = 1500
/** Undoing a turn waits up to this long for the board to take in the pages it put back. */
const BOARD_SETTLE_MS = 3000
/** A press that selected a frame, then a second one opening it: one double-click. */
const OPEN_GESTURE_MS = 600
/** What a frame that kept the preview busy shows once Gui stopped it. */
const HUNG_FRAME = {
  message:
    'This frame stopped responding (a script in it may loop forever), so Gui stopped it. Go back to the canvas to open another.',
  detail: "The frame's page didn't answer, and its process was ended.",
}
/**
 * Whether Esc in the window's chrome is free to go back to the board: nothing there is being
 * typed in, and no menu or dialog of its own (which Esc closes) is open. Gui's own world.
 */
const CHROME_ESC_FREE = `(() => {
  if (document.querySelector('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')) return false
  const el = document.activeElement
  if (!el || el === document.body) return true
  return !(el.isContentEditable || el.closest('input, textarea, select, [contenteditable]'))
})()`
/** A project trusted to run a start command set in Gui, and nothing of its own yet */
const NOTHING_AGREED: TrustedScripts = { starts: {}, installs: null }
/** An install that runs longer than this is stuck (a prompt, a hung download): Gui stops it. */
const INSTALL_TIMEOUT_MS = 20 * 60_000
/** At most this many automatic restarts in AUTO_RESTART_WINDOW_MS, so a loop can't run on. */
const MAX_AUTO_RESTARTS = 3
const AUTO_RESTART_WINDOW_MS = 60_000

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
  productionScript: null,
})

/**
 * A canvas's `canvas.json` in undo, redo and restoring versions (chat.ts `BoardLayout`): read
 * at each checkpoint, merged onto the board as it is (`mergeLayout`), and written once the
 * board has taken in the pages the restore put back, so its own sync can't write over it.
 */
function boardLayout(
  board: BoardSession,
  checkpoints: Checkpoints,
  current: () => boolean,
): BoardLayout {
  const at = async (sha: string) => {
    const text = await checkpoints.read(sha, BOARD_MANIFEST)
    return text === null ? null : parseManifest(text, board.name)
  }
  return {
    path: BOARD_MANIFEST,
    changed: async (from, to) => !sameLayout(...(await Promise.all([at(from), at(to)]))),
    restore: async (from, to) => {
      const [before, after] = await Promise.all([at(from), at(to)])
      if (!after || !current()) return
      await boardSettled(board)
      if (!current()) return
      // Pending moves and pans land first, so they're in `now` rather than written over it.
      await board.save()
      const text = await readFile(join(board.root, BOARD_MANIFEST), 'utf8').catch(() => null)
      const now = {
        ...parseManifest(text, board.name),
        name: board.name,
        frames: [...board.frames],
        sections: [...board.sections],
      }
      const merged = mergeLayout(now, before ?? { ...now, frames: [], sections: [] }, after)
      if (!sameLayout(merged, now) && current()) await writeManifest(board.root, merged)
    },
  }
}

/**
 * Resolves once the board's frames are the pages in its folder (a restore just removed or put
 * some back, which it takes in a moment later), or after BOARD_SETTLE_MS.
 */
async function boardSettled(board: BoardSession) {
  const pages = async () => {
    const files = await readdir(join(board.root, FRAMES_DIR)).catch(() => [] as string[])
    return files.flatMap((file) => {
      const id = file.endsWith('.html') ? file.slice(0, -'.html'.length) : ''
      return isFrameId(id) ? [id] : []
    })
  }
  const deadline = Date.now() + BOARD_SETTLE_MS
  while (Date.now() < deadline) {
    const want = (await pages()).sort().join()
    if (
      board.frames
        .map((frame) => frame.id)
        .sort()
        .join() === want
    )
      return
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        board.off('change', done)
        resolve()
      }
      const timer = setTimeout(done, 250)
      board.on('change', done)
    })
  }
}

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
  /**
   * Each viewport's zoom, Desktop's at 100% and the frames (a canvas frame's own size too)
   * fitting until the user zooms.
   */
  private zooms: Partial<Record<Viewport, Zoom>> = { desktop: 1 }
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

  /**
   * Traces what happens in the preview while it's recorded (recording-trace.ts), and where the
   * pointer goes (recording-cursor.ts), sent to `onCursor` as it moves for the recorder to draw.
   */
  traceRecording(onCursor: (frame: CursorFrame) => void) {
    const contents = this.preview.webContents
    const trace = new RecordingTrace(contents)
    const cursor = new CursorTrack(contents, {
      pointer: () => {
        const at = this.cursorOverPreview()
        return at && viewPointFrom(at)
      },
      size: () => ({ width: this.placement.width, height: this.placement.height }),
      scale: () => this.emulation.scale,
      locate: (x, y) => trace.locate(x, y),
      onFrame: onCursor,
    })
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
        const pointer = await cursor.finish(startedAt, durationMs)
        return { timeline: await trace.finish(startedAt, durationMs), cursor: pointer }
      },
      dispose: () => {
        detach()
        cursor.dispose()
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
  /** Rulers and guides over the preview (⇧R) */
  private readonly guides: Guides
  /** The versions of an element the agent showed to flip through (docs/variations.md) */
  private readonly variations: Variations
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
  disposed = false
  private opening: string | null = null
  /** Pending "after" capture and re-highlight of the element a finished turn edited. */
  private rehighlightTimer: NodeJS.Timeout | null = null
  /** Ends the agent's walkthrough a little after its turn did */
  private guideEndTimer: NodeJS.Timeout | null = null
  /** The website the agent opened in the preview, over the app (website.ts) */
  private website: Website | null = null
  private websiteOpening: Promise<Website> | null = null
  /** Bumped as a website closes: one still opening then closes too, unseen. */
  private websiteGeneration = 0
  /**
   * Why the website closed while the agent's turn was using it (the user went back to their
   * app), for its next page tool to say once, rather than act on the app unawares.
   */
  private websiteClosedNote: string | null = null
  /** The turn last seen starting, so a new one is told from a permission card being answered */
  private runningTurn: string | null = null
  /**
   * The preview's current page is Chromium's error page for a load that failed. It fires
   * dom-ready like any page, which must not take the failure back.
   */
  private loadFailed = false
  /** The view that had the keyboard when the preview's page started loading (`keepKeyboard`). */
  private keyboardBeforeLoad: WebContents | null = null
  /** The page the preview last committed (`did-navigate`), so a canvas knows which frame shows. */
  private committedUrl: string | null = null
  /**
   * A canvas frame on its way into the preview: until its page commits, what the page it
   * replaces does (a late in-page navigation) doesn't say which frame is open.
   */
  private frameLoading: string | null = null
  /** The check on a frame's page that hasn't loaded yet (`watchFrame`) */
  private frameCheck: NodeJS.Timeout | null = null
  /**
   * Gui is ending the preview's process: `hung`, a frame that stopped responding, which then
   * shows HUNG_FRAME; otherwise a hung page the open frame was stuck behind, which loads again.
   */
  private stopping: { hung: boolean } | null = null
  /** The open frame loading again after that (`stopping`): its cancelled first load isn't a failure */
  private reloadingFrame: string | null = null
  /**
   * The board's selection before the user opened a frame (double-click, Return, Open), put
   * back when they go back to the board; null when the agent opened it.
   */
  private selectionBeforeFrame: string[] | null = null
  /** The selection before the user's last board selection, and when it changed */
  private lastSelection: { ids: string[]; at: number } | null = null
  /** Frames the user adds, one after another, so each takes the next number (`boardAddFrame`) */
  private addingFrames: Promise<unknown> = Promise.resolve()
  /** Esc in the window's chrome, while this tab is the one it shows (`activate`) */
  private chromeKeys: { wc: WebContents; listener: (event: Event, input: Input) => void } | null =
    null
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
  /**
   * A start (`startKey`) the user saw come about in this session: a dev script the agent
   * changed during a turn. It runs without asking again, and becomes what's trusted.
   */
  private watchedStart: string | null = null
  /** The start as the running turn began, to tell what the agent changed in it */
  private turnStartKey: Promise<string | null> | null = null
  /** Settles once the end of the last turn has been looked at (`noteTurnScripts`) */
  private scriptsNoted: Promise<void> = Promise.resolve()
  /** What the app last started from (`startSignature`), to restart it only on a real change */
  private startedSignature: string | null = null
  /** Its start files changed mid-turn: restart once the turn is over. */
  private restartAfterTurn = false
  /** When Gui last restarted the app by itself, for MAX_AUTO_RESTARTS */
  private autoRestarts: number[] = []

  constructor(host: TabHost) {
    this.host = host
    this.state = {
      project: null,
      devServer: idleDevServer(),
      serverErrors: 0,
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
        rulers: getPrefs().rulers,
        selectable: false,
        visible: false,
        website: null,
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
      branch: null,
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
      moving: (reduced) => {
        this.panel.slideDock(reduced)
        this.panel.flyHeld()
      },
      ended: () => {
        this.panel.landDock()
        this.panel.landFloat()
      },
    })
    this.panel = new ChatPanel(this)
    this.picker = new Picker(this.preview.webContents, this.inspector, () => this.emulation.scale)
    this.guides = new Guides(this.preview, {
      inspector: this.inspector,
      scale: () => this.emulation.scale,
      root: () => this.state.project?.root ?? null,
      sendChrome: (channel, payload) => this.send(channel, payload),
      relayout: () => {
        this.patchPreview({ rulers: this.guides.on })
        this.layout()
      },
    })
    this.variations = new Variations({
      inspector: this.inspector,
      chat: () => this.resources.chat,
      generation: () => this.resources.generation,
      stillCurrent: (generation) => this.resources.stillCurrent(generation),
      onApp: () => !this.website && isLoopback(this.preview.webContents.getURL()),
      setBar: (bar) => {
        this.placeBar()
        this.picker.setBar(bar)
      },
      send: (text) => this.sendChatMessage(text, []),
    })
    this.problems.on('change', (problems) => {
      this.resources.chat?.setProblems(problems)
      const serverErrors = problems.filter((problem) => problem.source === 'server').length
      if (serverErrors !== this.state.serverErrors) this.patch({ serverErrors })
    })
    agentHealth.on('change', this.onAgentHealth)
    nodeRuntime.on('change', this.onNodeRuntime)
    developerTools.on('change', this.onDeveloperTools)

    this.bindPreview()
    guardAppContents(this.chatView.webContents)
    // A reloaded chat page starts from what main tells it next.
    this.chatView.webContents.on('did-start-loading', () => {
      this.panel.clearFloatShown()
    })
    // The keyboard leaving the floating panel is the user going back to their app: once the
    // agent is done, the panel shrinks to its message box. Coming back to it holds it open.
    this.chatView.webContents.on('blur', () => this.panel.leftChat(false))
    this.chatView.webContents.on('focus', () => this.panel.cancelCollapse())
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
    return (
      wc === this.chatView.webContents ||
      this.picker.owns(wc) ||
      this.guides.owns(wc) ||
      this.website?.picker.owns(wc) === true
    )
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
    if (this.website) {
      contentView.addChildView(this.website.view)
      contentView.addChildView(this.website.picker.view)
    }
    // Popped out, the chat is in its own window, which shows again with its tab.
    if (this.panel.popoutWindow) this.panel.popoutWindow.showInactive()
    else contentView.addChildView(this.chatView)
    this.layout()
    // A permission card that came up in the background is what the user switched here for
    // (in a focused window: focusing the chat would raise it).
    if (this.resources.chat?.awaitingPermission && this.host.win.isFocused()) this.panel.focusChat()
    void this.refreshBranch()
    this.listenToChrome()
  }

  /**
   * Esc with the window's chrome holding the keyboard (as it does after a double-click opens a
   * frame) goes back to the board, as it does in the frame's page (`bindPreview`). Picking ends
   * first, an edit in place and focus mode keep it (the chrome ends focus mode itself), and the
   * chrome's own fields, menus and dialogs have it to themselves.
   */
  private listenToChrome() {
    this.stopListeningToChrome()
    const wc = this.host.win.webContents
    const listener = (_event: Event, input: Input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape' || input.isAutoRepeat) return
      const board = this.resources.board
      if (!board?.openId || wc !== this.host.win.webContents || !this.host.isActive(this)) return
      if (this.state.preview.selecting) {
        void this.setSelecting(false)
        return
      }
      if (this.textEdit || this.host.focusMode) return
      const open = board.openId
      void wc
        .executeJavaScriptInIsolatedWorld(1001, [{ code: CHROME_ESC_FREE }])
        .then((free) => {
          if (free === true && this.resources.board === board && board.openId === open)
            void this.openFrame(null)
        })
        .catch(() => undefined)
    }
    wc.on('before-input-event', listener)
    this.chromeKeys = { wc, listener }
  }

  private stopListeningToChrome() {
    const keys = this.chromeKeys
    this.chromeKeys = null
    if (keys && !keys.wc.isDestroyed()) keys.wc.off('before-input-event', keys.listener)
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
    this.guides.unmount()
    contentView.removeChildView(this.picker.view)
    if (this.website) {
      contentView.removeChildView(this.website.view)
      contentView.removeChildView(this.website.picker.view)
    }
    // A background tab's popped-out chat hides, so the one in sight is the tab in sight's.
    if (this.panel.popoutWindow) this.panel.popoutWindow.hide()
    else contentView.removeChildView(this.chatView)
    this.syncDrawerOutput()
    this.stopListeningToChrome()
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
        modeIsUsual: false,
        commands: [],
        selection: [],
        selectionError: null,
        selecting: this.state.preview.selecting,
        canSelect: this.canSelect,
        canvas: !!this.resources.board,
        canvasEmpty: this.resources.board?.frames.length === 0,
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
        ownPermissions: declaresOwnPermissions(this.state.agentId),
        autoNoteSeen: getPrefs().autoNoteSeen,
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
      const [{ project, apps, choosing }, saved] = await Promise.all([
        resolveProject(root, getPrefs().apps[root] ?? null),
        loadHistory(file),
      ])
      // Several apps and none picked yet: nothing runs until the user chooses one.
      const setup = await detectSetup(project, choosing ? apps : null)
      if (!current()) return

      if (!(await this.attachChat(root, file, saved, resources, current, null))) return

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
        branch: await branchStatus(root),
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
      const [saved] = await Promise.all([loadHistory(file), board.open()])
      if (!current()) return
      board.on('change', () => {
        if (this.resources.board === board) this.syncBoard()
      })
      board.on('frameChanged', (frame) => {
        // A page has no hot reload: the one in sight loads again as it's rewritten.
        if (this.resources.board === board && board.openId === frame && this.state.preview.url)
          this.preview.webContents.reload()
      })
      if (!(await this.attachChat(root, file, saved, resources, current, board))) return
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

  /** The agent's preview tools are sending their input to the page (see `PageTools.input`). */
  get agentInput() {
    return this.resources.previewTools?.inputting === true || this.website?.tools.inputting === true
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
    // The open frame resized while shown at its own size: shown at its new one. (A frame
    // opening is sized by openFrame.)
    const open = board.openId ? board.frame(board.openId) : null
    const { viewport } = this.state.preview
    const resized = open && this.state.board?.open === open.id && frameViewport(open) !== viewport
    if (resized && isCustomViewport(viewport)) this.setViewport(frameViewport(open))
    this.resources.chat?.setCanvasEmpty(board.frames.length === 0)
    this.patch({ board: board.state(), project })
  }

  // The canvas's board (from the chrome)

  boardSelect(ids: string[]) {
    const board = this.resources.board
    if (!board) return
    const before = [...board.selected]
    board.select(ids)
    if (board.selected.join() !== before.join())
      this.lastSelection = { ids: before, at: Date.now() }
  }

  boardArrange(updates: FrameArrangement[]) {
    return this.resources.board?.arrange(updates, true)
  }

  /**
   * A frame the user adds, of a preset size, where they asked or beside what's selected. One at
   * a time, each named once the one before it is on the board, so quick adds never share a name.
   */
  boardAddFrame(preset: FramePreset, at: { x: number; y: number } | null) {
    const board = this.resources.board
    if (!board) return Promise.resolve()
    const added = this.addingFrames.then(async () => {
      const { name, width, height } =
        FRAME_PRESETS.find((option) => option.id === preset) ?? FRAME_PRESETS[0]
      const frame = await board.create({
        name: nextFrameName(name, board.frames),
        width,
        height,
        at: at ?? undefined,
        after: [...board.selected],
      })
      board.select([frame.id])
    })
    this.addingFrames = added.catch(() => undefined)
    return added
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

  /**
   * Edit › Undo on a canvas: the user's own last board change, before any of the agent's turns,
   * with a frame open live too. True when that's all Undo does here: it took one back, or a frame
   * is open and there's none (Undo there never reaches into the agent's turns, which would take
   * its frames away). False on the board with nothing of the user's: the chat's turns are next.
   */
  async undoBoard() {
    const board = this.resources.board
    if (!board) return false
    if (board.state().canUndo) {
      // The agent's change in the meantime left nothing of the user's to take back.
      if (!(await board.undo())) shell.beep()
      return true
    }
    if (!board.openId) return false
    shell.beep()
    return true
  }

  /**
   * Shows a frame's page live in the preview (double-click, Return, Open, or the agent's
   * `by`), sized like its frame when a device viewport matches it; null goes back to the board.
   */
  async openFrame(id: string | null, by: 'user' | 'agent' = 'user') {
    const board = this.resources.board
    if (!board) return
    // A frame (or the board) takes the preview back from a website.
    this.closeWebsite()
    if (id === null || !board.has(id)) {
      board.setOpen(null)
      this.closeFrame()
      return
    }
    // Opened from the board by the user: their selection is back as it was when they're back.
    if (!board.openId)
      this.selectionBeforeFrame = by === 'user' ? this.selectionBeforeOpening(board, id) : null
    board.setOpen(id)
    this.fitFrame(id)
    const url = board.frameUrl(id)
    this.frameLoading = url
    this.watchFrame(id)
    try {
      await this.loadPreview(url)
    } finally {
      if (this.frameLoading === url) this.frameLoading = null
    }
  }

  /**
   * The selection before the user opened `id`: a double-click's first press selected the frame
   * it opens, so then it's the one before that press.
   */
  private selectionBeforeOpening(board: BoardSession, id: string) {
    const now = [...board.selected]
    const last = this.lastSelection
    const pressed = now.length === 1 && now[0] === id
    return last && pressed && Date.now() - last.at < OPEN_GESTURE_MS ? last.ids : now
  }

  /** The preview at the device viewport a frame's size matches, or at the frame's own size. */
  private fitFrame(id: string) {
    const frame = this.resources.board?.frame(id)
    if (!frame) return
    const viewport = frameViewport(frame)
    if (viewport !== this.state.preview.viewport) this.patchPreview({ viewport })
  }

  /** A viewport the user can choose: a device's, or the open canvas frame's own size. */
  private canShow(viewport: Viewport) {
    if (!isCustomViewport(viewport)) return true
    const board = this.resources.board
    const frame = board?.openId ? board.frame(board.openId) : null
    return frame !== null && frameViewport(frame) === viewport
  }

  private zoomOf(viewport: Viewport): Zoom {
    return this.zooms[viewport] ?? (viewport === 'desktop' ? 1 : null)
  }

  /** Back to the board: the preview hides and unloads, and its picking ends. */
  private closeFrame() {
    this.clearFrameCheck()
    this.frameLoading = null
    this.reloadingFrame = null
    if (this.state.preview.selecting) void this.setSelecting(false)
    this.preview.setVisible(false)
    if (this.state.preview.url !== null)
      this.preview.webContents.loadURL('about:blank').catch(() => undefined)
    this.patchPreview({ url: null, error: null, visible: false, loading: false })
    void this.inspector.clearHighlight()
    // Opening it selected the frame; the next message is about what the user had selected.
    const before = this.selectionBeforeFrame
    this.selectionBeforeFrame = null
    if (before) this.resources.board?.select(before)
  }

  /**
   * A frame's page that may hang the preview: checked a moment after it's opened, unless it's
   * loaded by then (`checkFrame`).
   */
  private watchFrame(id: string) {
    this.clearFrameCheck()
    this.frameCheck = setTimeout(() => {
      this.frameCheck = null
      void this.checkFrame(id)
    }, FRAME_LOAD_CHECK_MS)
  }

  private clearFrameCheck() {
    if (this.frameCheck) clearTimeout(this.frameCheck)
    this.frameCheck = null
  }

  /**
   * The open frame still hasn't loaded: if the preview's page doesn't answer, its process is
   * ended (`stopping`). One that hung itself then shows HUNG_FRAME; one stuck behind a page that
   * hung (an earlier frame's, the preview's process shared) loads again in a new process.
   */
  private async checkFrame(id: string) {
    const board = this.resources.board
    const wc = this.preview.webContents
    if (!board || board.openId !== id || wc.isDestroyed() || this.stopping) return
    const committed = board.frameAt(this.committedUrl) === id
    if (committed && !wc.isLoading()) return
    const answered = await Promise.race([
      // Rejected (the frame went away) is an answer too: the process is alive.
      wc.mainFrame.executeJavaScript('1').then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), FRAME_ANSWER_MS)),
    ])
    if (answered || this.resources.board !== board || board.openId !== id || wc.isDestroyed())
      return
    this.stopPreview(board.frameAt(this.committedUrl) === id)
  }

  /** Ends the preview's process, which a page has stopped from answering (see `stopping`). */
  private stopPreview(hung: boolean) {
    if (this.stopping) return
    this.stopping = { hung }
    this.preview.webContents.forcefullyCrashRenderer()
  }

  /**
   * preview_navigate on a canvas: a frame's page (`/frames/<id>.html`, or its address in the
   * preview) opens that frame; there's nothing else to open. Where it landed.
   */
  private async navigateToFrame(board: BoardSession, url: URL) {
    const named = /^\/frames\/([^/]+)\.html$/.exec(url.pathname)?.[1]
    const id = board.frameAt(url.href) ?? (named && board.has(named) ? named : null)
    if (!id) {
      const missing = named && isFrameId(named) ? ` There's no frame ${named}.` : ''
      throw new Error(`On a canvas, open a frame with canvas_open_frame.${missing}`)
    }
    await this.openFrame(id, 'agent')
    return board.frameUrl(id)
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
      openFrame: board ? (url) => this.navigateToFrame(board, url) : undefined,
      logs: () => this.getLogs(),
      viewScale: () => this.emulation.scale,
      restoreViewport: () => this.emulation.restore(),
      serverStatus: () => (board ? BOARD_SERVER_STATUS : describeServer(this.state)),
      restartServer: () => (board ? Promise.resolve(BOARD_SERVER_STATUS) : this.restartForAgent()),
      setStartCommand: (input) =>
        board ? Promise.resolve(BOARD_SERVER_STATUS) : this.setStartCommandForAgent(input),
      guide: (node, caption) => this.guideStep(this.picker, node, caption),
      guideInput: (at, click) => this.guideInput(this.picker, at, click),
      variations: (input) => this.variations.show(input),
      // A late call from an opening since replaced mustn't touch the next project's guides.
      guides: {
        list: () => (current() ? this.guides.list() : []),
        shown: () => current() && this.rulersShown,
        change: (change) => {
          if (!current()) throw new Error('The project was closed')
          return this.guides.change(change)
        },
      },
      website: {
        shown: () => (this.website && !this.website.closed ? this.website.tools : null),
        open: (url) => this.openWebsite(url),
        close: () => {
          this.closeWebsite()
          this.websiteClosedNote = null
        },
        takeClosedNote: () => {
          const note = this.websiteClosedNote
          this.websiteClosedNote = null
          return note
        },
      },
    })
    this.resources.previewTools = tools
    // A narrated clip's transcript comes in after it's attached: the composer updates it.
    const recordings = new Recordings(root, (clip) => {
      if (current() && this.resources.recordings === recordings)
        this.sendChat(Events.recordingUpdate, clip)
    })
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
        versions: (limit) => this.versionsForAgent(limit),
        turns: (limit) => describeTurns(this.resources.chat?.snapshot().turns ?? [], limit),
      },
      board
        ? createBoardTools(board, {
            prompt: () => this.promptBoard(),
            open: (id) => this.openFrame(id, 'agent'),
            live: current,
            closed: resources.signal,
          })
        : null,
    ).catch((error: unknown) => {
      console.error('[gui] preview tools unavailable', error)
      return null
    })
    if (!resources.attachMcp(mcp) || !current()) return false

    // Opening doesn't wait for the shell's environment, still loading just after launch:
    // checkpoints' git, the agent and the dev server each wait for it before they spawn.
    const store = join(app.getPath('userData'), 'checkpoints')
    const checkpoints = new Checkpoints(root, store, getShellEnv(), {
      referenced: () => chatReferences(root).then((found) => found?.checkpoints ?? null),
      // A canvas's folders stay, even when undoing its first turn empties them.
      keepDirs: board ? [FRAMES_DIR, 'assets'] : undefined,
    })
    const chat = new ChatController(root, checkpoints, {
      agentId: this.state.agentId,
      docked: getPrefs().chatSidebar,
      saved,
      historyFile: file,
      recordings,
      mcpServers: () => (resources.mcp ? [resources.mcp.config] : []),
      viewport: () => this.promptViewport(),
      guides: () => this.promptGuides(),
      board: board ? () => this.promptBoard() : undefined,
      startupReport: (tools) => startupReport(this.state, this.getLogs(), tools),
      layout: board ? boardLayout(board, checkpoints, current) : undefined,
    })
    this.bindChat(chat)
    this.resources.chat = chat
    this.panel.untuck()
    resources.attachHistory(root, file)
    chat.setCanSelect(this.canSelect)
    if (board) chat.setCanvasEmpty(board.frames.length === 0)
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
      // Each message starts on the user's app: a website the agent opened before closes, and
      // its session is cleared, before this turn's agent can act on it.
      if (turn.status === 'running' && turn.id !== this.runningTurn) {
        this.runningTurn = turn.id
        this.turnStartKey = this.currentStartKey()
        // A reply is starting: the floating chat shows the conversation.
        this.panel.showConversation()
        this.closeWebsite()
        this.websiteClosedNote = null
      }
      // Once the turn ends, the website is the user's to use.
      this.holdWebsite()
      // Its variations go once the turn that made them is undone.
      this.variations.onTurn(turn)
      // Working, or a permission card answered: the tab strip shows it.
      this.host.tabChanged(this, false)
    })
    chat.on('reset', (snapshot) => {
      this.sendChat(Events.chatReset, snapshot)
      this.variations.clear()
      // A chat opened from the archive shows; a new one has nothing to show yet, so the
      // floating panel is its message box.
      if (snapshot.turns.length > 0) this.panel.showConversation()
      else this.panel.newConversation()
    })
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
      // The reply stays in view until the user goes back to their app.
      this.panel.showConversation()
      // Before anything restarts the app: what the agent changed in how it starts.
      this.scriptsNoted = this.noteTurnScripts(true)
      if (this.restartAfterTurn) {
        this.restartAfterTurn = false
        void this.scriptsNoted.then(() => this.restartForChanges())
      }
      // The agent may have switched branches itself.
      void this.refreshBranch()
      // The walkthrough's last step stays a moment to be read, then gets out of the way.
      if (this.picker.guiding || this.website?.picker.guiding) {
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
   * Opening a folder must not run its scripts until the user has seen them. Installing runs
   * package scripts too, so it's agreed to in the same dialog. A trusted project asks again
   * when what it runs changed since the user agreed, unless they saw it change here
   * (`watchedStart`); an install asks about install scripts they haven't seen.
   */
  private async confirmScripts(project: ProjectInfo, installs: InstallTarget[]) {
    await this.scriptsNoted
    if (this.resources.chat?.turnRunning) await this.noteTurnScripts(false)
    const installing = installs.length > 0
    const now = await scriptsOf(project)
    if (await isTrusted(project.root)) {
      const saved = await trustedScripts(project.root)
      // Trusted before Gui kept what was agreed to: what it runs now is what was agreed.
      if (!saved) {
        await this.keepScripts(project.root, agreedScripts(now, true, null))
        return true
      }
      const picked = !!project.appDir && getPrefs().apps[project.root] === project.appDir
      const changed = startChanged(project, now, saved, picked, this.watchedStart)
      const installsChanged = installing ? changedInstalls(saved.installs, now.installs) : []
      if (!changed && installsChanged.length === 0) {
        const agreed = agreedScripts(now, installing, saved)
        if (JSON.stringify(agreed) === JSON.stringify(saved)) return true
        await this.keepScripts(project.root, agreed)
        return true
      }
      return this.confirmChangedScripts(project, now, saved, changed, installsChanged, installs)
    }

    // Scripts and folder names come from the project: shown cleaned up and cut short.
    const devCommand = this.startDescription(project)
    const script = promptText(project.devScript ?? project.devCommand ?? '')
    const agreed = agreedScripts(now, installing, null)
    if (!installing) {
      return this.askToTrust(
        project.root,
        {
          message: `Start ${promptName(project.name)}?`,
          detail: `To show your app, Gui starts its dev server, ${devCommand}:\n\n${script}\n\nGui won't ask again for this project unless its scripts change. Only start projects you trust.`,
          buttons: ['Start Dev Server', 'Not Now'],
        },
        agreed,
      )
    }
    const scripts = Object.entries(now.installs).map(
      ([name, body]) => `${promptName(name)}: ${promptText(body)}`,
    )
    const installScripts = scripts.length ? `Installing runs:\n\n${scripts.join('\n\n')}\n\n` : ''
    return this.askToTrust(
      project.root,
      {
        message: `Start ${promptName(project.name)}?`,
        detail: `Gui will install dependencies (${this.installDescription(installs)}) and start the dev server (${devCommand}) to preview the project. ${installScripts}The dev server runs:\n\n${script}\n\nBoth run code from this project. Only start projects you trust.`,
        buttons: ['Install and Start', 'Not Now'],
      },
      agreed,
    )
  }

  /**
   * A trusted project whose scripts changed since the user agreed to them (a `git pull`, an
   * edit outside Gui): shows what changed before it runs. Declining runs nothing, and asks
   * again next time.
   */
  private confirmChangedScripts(
    project: ProjectInfo,
    now: CurrentScripts,
    saved: TrustedScripts,
    startChanged: boolean,
    installsChanged: string[],
    installs: InstallTarget[],
  ) {
    const changes = [
      ...(startChanged
        ? [
            `The dev server, ${this.startDescription(project)}:\n${promptText(project.devScript ?? project.devCommand ?? '')}`,
          ]
        : []),
      ...installsChanged.map((key) => `${promptName(key)}: ${promptText(now.installs[key] ?? '')}`),
    ]
    const installing = installs.length > 0
    return this.askToTrust(
      project.root,
      {
        message: `${promptName(project.name)}'s scripts changed`,
        detail: `Since you last started it, ${changes.length > 1 ? 'these changed' : 'this changed'}:\n\n${changes.join('\n\n')}\n\n${installing ? `Gui will install dependencies (${this.installDescription(installs)}) and start it. ` : ''}It runs code on your Mac. Only start projects you trust.`,
        buttons: [installing ? 'Install and Start' : 'Start Dev Server', 'Not Now'],
      },
      agreedScripts(now, installing, saved),
    )
  }

  /** "bun run dev in apps/web", project text cleaned up. */
  private startDescription(project: ProjectInfo) {
    const command = promptName(project.devCommand ?? '')
    return project.appDir ? `${command} in ${promptName(project.appDir)}` : command
  }

  /** "bun install", or "bun install, then npm install in web". */
  private installDescription(installs: InstallTarget[]) {
    return installs
      .map((target) =>
        target.dir
          ? `${installCommand(target.packageManager)} in ${promptName(target.dir)}`
          : installCommand(target.packageManager),
      )
      .join(', then ')
  }

  /** Records what the user agreed to run (or ran unchanged). */
  private async keepScripts(root: string, scripts: TrustedScripts): Promise<void> {
    await recordTrustedScripts(root, scripts).catch((error: unknown) =>
      console.error('[gui] failed to keep the trusted scripts', error),
    )
  }

  /** The start as it is now, or null with nothing to start (or an app still to pick). */
  private async currentStartKey(): Promise<string | null> {
    const root = this.state.project?.root
    if (!root || this.state.board) return null
    const { project, choosing } = await resolveProject(root, getPrefs().apps[root] ?? null)
    return choosing ? null : startKey(project)
  }

  /**
   * A dev script the agent changed during the turn (at its end, or mid-turn as it restarts
   * the app), in a start the user had agreed to, runs without asking: the user watched the
   * turn. Install scripts aren't covered: they ask before the next install.
   */
  private async noteTurnScripts(ending: boolean) {
    const resources = this.resources
    const generation = resources.generation
    const root = this.state.project?.root
    const pending = this.turnStartKey
    if (ending) this.turnStartKey = null
    const before = await pending
    if (!root || !before) return
    if (!resources.stillCurrent(generation)) return
    const after = await this.currentStartKey()
    if (after === null || after === before || !resources.stillCurrent(generation)) return
    const saved = await trustedScripts(root)
    if (!resources.stillCurrent(generation)) return
    const agreed = Object.values(saved?.starts ?? {}).includes(before)
    if (agreed || this.watchedStart === before) this.watchedStart = after
  }

  /** The trust prompt; agreeing trusts the project from then on, and keeps `scripts`. */
  private askToTrust(
    root: string,
    options: MessageBoxOptions,
    scripts: TrustedScripts | null = null,
  ) {
    if (this.disposed) return Promise.resolve(false)
    return askToTrust(root, options, this.host.win, scripts)
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
    // A website the project's agent opened goes with it, and its session is cleared.
    this.closeWebsite()
    this.variations.clear()
    this.opening = null
    this.stopWatchingForApp()
    this.watchedStart = null
    this.turnStartKey = null
    this.scriptsNoted = Promise.resolve()
    this.startedSignature = null
    this.restartAfterTurn = false
    this.autoRestarts = []
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
      branch: null,
      preview: {
        ...this.state.preview,
        // A canvas frame's own size goes with its canvas; a project has devices only.
        viewport: isCustomViewport(this.state.preview.viewport)
          ? 'desktop'
          : this.state.preview.viewport,
        url: null,
        error: null,
        visible: false,
        selecting: false,
      },
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

  /** Restart, from the UI: from the top, so changed scripts, packages and settings are used. */
  restartDevServer() {
    void this.retryStartup()
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
    // The user typing an address goes back to their own preview.
    this.backToApp()
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
    if (this.website) return
    const history = this.preview.webContents.navigationHistory
    if (this.canNavigateHistory(-1)) history.goBack()
  }

  forward() {
    if (this.website) return
    const history = this.preview.webContents.navigationHistory
    if (this.canNavigateHistory(1)) history.goForward()
  }

  private canNavigateHistory(offset: -1 | 1) {
    if (!this.state.preview.url) return false
    const history = this.preview.webContents.navigationHistory
    if (!history.canGoToOffset(offset)) return false
    return history.getEntryAtIndex(history.getActiveIndex() + offset)?.url !== 'about:blank'
  }

  reload() {
    if (this.website) return this.website.view.webContents.reload()
    if (!this.state.preview.url) return
    if (this.preview.webContents.getURL() === 'about:blank') {
      void this.loadPreview(this.state.preview.url)
    } else this.preview.webContents.reload()
  }

  /** Reloads without the cache, for a change a normal reload keeps serving stale. */
  hardReload() {
    if (this.website) return this.website.view.webContents.reloadIgnoringCache()
    if (!this.state.preview.url) return
    if (this.preview.webContents.getURL() === 'about:blank') {
      void this.loadPreview(this.state.preview.url)
    } else this.preview.webContents.reloadIgnoringCache()
  }

  setViewport(viewport: Viewport) {
    if (!this.canShow(viewport)) return
    if (viewport !== this.state.preview.viewport) this.morphLayout('viewport')
    this.patchPreview({ viewport })
    this.layout()
  }

  /**
   * View → Zoom In (`step` 1), Zoom Out (-1) or Actual Size (0), for the viewport shown: the
   * page, or a device frame's scale. The page keeps its CSS size either way. `morph` false (a
   * keyboard shortcut) lands it at once, unless a morph is already under way.
   */
  zoom(step: 1 | -1 | 0, morph = true) {
    // On a canvas's board, the board zooms.
    if (this.resources.board && !this.resources.board.openId) {
      this.send(Events.board, { type: 'zoom', step })
      return
    }
    const { viewport } = this.state.preview
    const zoom = this.zoomOf(viewport)
    const next = zoomed(viewport, this.previewArea(), zoom, step)
    if (next === undefined) return shell.beep()
    if (next !== zoom && morph) this.morphLayout('zoom')
    this.zooms = { ...this.zooms, [viewport]: next }
    this.patchPreview({ zoom: this.zoomOf('desktop') ?? 1 })
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
    this.pageKeyboard().focus()
  }

  /** What takes the keyboard for the page: a website's overlay while the agent's turn holds it. */
  private pageKeyboard() {
    const website = this.website
    if (website?.picker.holding && website.picker.view.getVisible())
      return website.picker.view.webContents
    return (website?.view ?? this.preview).webContents
  }

  /**
   * F6 and ⇧F6: the keyboard to the next pane on screen, or with `step` -1 the previous one,
   * wrapping around: the chrome, the preview, the chat. Tab stays inside each, as in a browser.
   */
  focusPane(step: 1 | -1) {
    if (!this.host.isActive(this) || !this.host.win.isFocused()) return
    const chrome = this.host.win.webContents
    const panes = [{ contents: chrome, focus: () => chrome.focus() }]
    const page = this.website?.view ?? this.preview
    if (page.getVisible())
      panes.push({ contents: this.pageKeyboard(), focus: () => this.focusPreview() })
    if (this.chatView.getVisible() && !this.panel.popoutWindow)
      panes.push({ contents: this.chatView.webContents, focus: () => this.panel.focusChat() })
    const at = panes.findIndex((pane) => pane.contents.isFocused())
    const from = at === -1 ? (step === 1 ? panes.length - 1 : 0) : at
    panes[(from + step + panes.length) % panes.length].focus()
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
      // The open frame's page loaded: it didn't hang the preview on its way in.
      const board = this.resources.board
      if (board?.openId && board.frameAt(this.committedUrl) === board.openId) this.clearFrameCheck()
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
      // The agent's own clicks and keys (preview_click and the rest) aren't the user's.
      if (this.agentInput) return
      if (input.type === 'mouseDown') this.keyboardBeforeLoad = null
      // Using the app: the floating chat can get out of its way.
      if (input.type === 'mouseDown' || input.type === 'keyDown') this.panel.leftChat(true)
      if (input.type === 'mouseDown') this.panel.pagePressed()
    })
    wc.on('focus', () => this.keepKeyboard())
    wc.on('dom-ready', () => {
      this.keepKeyboard()
      if (this.loadFailed || wc.getURL() === 'about:blank') return
      this.patchPreview({ visible: true, error: null })
    })
    wc.on('did-navigate', (_event, url) => {
      this.committedUrl = url
      // A page committed: the process Gui was ending, if it was, is a new one by now.
      this.stopping = null
      this.reloadingFrame = null
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
      if (!isMainFrame || code === -3 || url === this.reloadingFrame) return
      this.loadFailed = true
      // The address is the one that failed, which Try again (a reload) loads again.
      this.patchPreview({
        url,
        error: loadFailure(description, url),
        visible: false,
        loading: false,
      })
    })
    wc.on('render-process-gone', (_event, details) => {
      const stopping = this.stopping
      this.stopping = null
      this.committedUrl = null
      const board = this.resources.board
      const open = board?.openId
      if (board && open && stopping && !stopping.hung) {
        // The open frame was stuck behind a page that hung: it loads in a new process.
        const url = board.frameUrl(open)
        this.reloadingFrame = url
        this.frameLoading = url
        this.watchFrame(open)
        void this.loadPreview(url)
        return
      }
      this.clearFrameCheck()
      this.patchPreview({
        error: stopping?.hung ? HUNG_FRAME : crashFailure(details.reason),
        visible: false,
        selecting: false,
        loading: false,
      })
    })
    // A canvas frame that keeps the preview busy (a script looping forever) is stopped, so the
    // preview's process (which other frames share) is free for the next one.
    wc.on('unresponsive', () => {
      const board = this.resources.board
      if (board?.openId) this.stopPreview(board.frameAt(this.committedUrl) === board.openId)
    })
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape') return
      // The agent's own Esc (preview_press) is for the page: it closes the page's dialog, not
      // the frame, nor ends the user's picking.
      if (this.agentInput) return
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
    const navigation = {
      canGoBack: this.canNavigateHistory(-1),
      canGoForward: this.canNavigateHistory(1),
    }
    if (url === 'about:blank') {
      this.patchPreview(navigation)
      return
    }
    if (this.followFrame(url)) return
    this.patchPreview({
      url,
      selectable: isLoopback(url),
      ...navigation,
    })
  }

  /**
   * On a canvas, the page that just committed says which frame is open: a link in one frame to
   * another's page opens that one (its viewport, its file for edits in place, what the agent is
   * told), and a page that isn't a frame goes back to the board. True when it went back.
   */
  private followFrame(url: string) {
    const board = this.resources.board
    if (!board) return false
    const id = board.frameAt(url)
    // A frame on its way in: until its page commits, the page it replaces says nothing.
    const loading = this.frameLoading
    if (loading) {
      if (board.frameAt(loading) !== id) return false
      this.frameLoading = null
    }
    if (id === board.openId) return false
    if (!id) {
      void this.openFrame(null)
      return true
    }
    board.setOpen(id)
    this.fitFrame(id)
    return false
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
    const local = isLoopback(this.preview.webContents.getURL()) && !this.website
    if (!this.state.preview.visible || !this.resources.chat || !local) return
    // Picking is on the live page: a morph in progress lands at once.
    this.morph.finish()
    // The overlay outlines what's picked now; the page's own highlight would double it.
    this.cancelRehighlight()
    this.highlightedPick = null
    void this.inspector.clearHighlight()
    this.syncOutlined()
    this.picker.start(this.placement, this.cursorOverPreview())
    // Picking has its own bubble, and the panel comes back once it ends.
    this.panel.untuck()
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
    if (this.website?.picker.guiding) this.website.picker.wheel(at, deltaX, deltaY)
    else if (this.picker.picking || this.picker.guiding) this.picker.wheel(at, deltaX, deltaY)
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
      if (this.panel.untuck()) this.layout()
      for (const [pick, pickNode] of nodes) this.pickedNodes.set(pick, pickNode)
      chat.setSelection(picked)
    })
  }

  // A website the agent opened in the preview (website.ts)

  /**
   * Opens `url` in a website over the app, opening one first in a fresh, signed-out session;
   * where it landed. It goes with this opening of the project, and closes if the preview went
   * back to the app while it opened.
   */
  private async openWebsite(url: URL): Promise<string> {
    // A canvas has no app to go back to, nor an address bar: it looks at websites with
    // canvas_screenshot_url.
    if (this.resources.board)
      throw new Error('On a canvas, look at websites with canvas_screenshot_url.')
    // Taken before anything waits: a DNS lookup can take seconds, and by then the user may have
    // stopped this turn, sent the next message, or gone back to their app.
    const resources = this.resources
    const generation = resources.generation
    const opened = this.websiteGeneration
    const turn = resources.chat?.workingTurnId ?? null
    const current = () =>
      !this.disposed &&
      this.resources === resources &&
      resources.stillCurrent(generation) &&
      this.websiteGeneration === opened &&
      (resources.chat?.workingTurnId ?? null) === turn
    const gone =
      "Not opened: the turn was stopped, or the preview went back to the user's app, while the website was being checked."
    // Nothing opens for an address that isn't public; the session checks every request too.
    if (!(await isPublicWebsite(url.hostname))) throw new Error(LOCAL_ADDRESS)
    if (!current()) throw new Error(gone)
    let website = this.website
    const fresh = !website || website.closed
    if (!website || website.closed) {
      // Shared by this generation's calls only: closing the website starts the next afresh.
      let opening = this.websiteOpening
      if (!opening) {
        const made = Website.create(this.websiteHooks())
        const done = () => {
          if (this.websiteOpening === made) this.websiteOpening = null
        }
        made.then(done, done)
        this.websiteOpening = opening = made
      }
      website = await opening
      if (!current()) {
        if (this.website !== website) void website.close()
        throw new Error(gone)
      }
      if (this.website !== website) this.showWebsite(website, url)
    }
    let landed: string
    try {
      landed = await website.load(url)
    } catch (error) {
      // A website that couldn't open its first page leaves the app in view.
      if (fresh && this.website === website) this.closeWebsite()
      throw error
    }
    if (this.website === website) this.patchPreview({ website: landed || url.toString() })
    return landed
  }

  /** Puts the website over the app's page and its overlay, under the chat. */
  private showWebsite(website: Website, url: URL) {
    this.website = website
    this.websiteClosedNote = null
    if (this.state.preview.selecting) void this.setSelecting(false)
    this.morph.finish(false)
    // The app's walkthrough is out of sight now.
    this.picker.endGuide()
    if (this.host.isActive(this)) {
      const { contentView } = this.host.win
      const chat = contentView.children.indexOf(this.chatView)
      contentView.addChildView(website.view, chat === -1 ? undefined : chat)
      contentView.addChildView(website.picker.view, chat === -1 ? undefined : chat + 1)
    }
    this.patchPreview({ website: url.toString() })
    // Shown mid-turn: held (`holdWebsite`, from layout) until the turn ends.
    this.layout()
  }

  /**
   * While the agent's turn uses the website, the user's pointer and keys don't reach it, so
   * what the agent did stays the agent's and nothing the user types lands in its throwaway
   * session: a guide's overlay lies over the page (a click there says why) and takes the
   * keyboard (website.ts `hold`). The wheel still scrolls the page. Once the turn ends, the
   * website is the user's to use.
   */
  private holdWebsite() {
    const website = this.website
    if (!website || website.closed) return
    const held = this.resources.chat?.turnRunning === true
    if (held && !website.picker.guiding) this.guideStep(website.picker, null, null)
    website.hold(held)
  }

  /** Back to the app: the website closes and its session is wiped for the next one. */
  private closeWebsite() {
    this.websiteGeneration++
    this.websiteOpening = null
    const website = this.website
    if (!website) return
    this.website = null
    if (!this.disposed) {
      const { contentView } = this.host.win
      contentView.removeChildView(website.view)
      contentView.removeChildView(website.picker.view)
    }
    void website.close()
    if (this.disposed) return
    this.patchPreview({ website: null })
    this.layout()
  }

  /**
   * "Back to your app", or the user navigating their preview: the website closes. Mid-turn,
   * the agent's next page tool hears why, rather than acting on the app unawares.
   */
  backToApp() {
    if (!this.website) return
    if (this.resources.chat?.turnRunning)
      this.websiteClosedNote =
        "The user went back to their app, so the website is closed and its session cleared. Open it again with preview_navigate and its full address only if they still want it; the page tools now act on the user's app."
    this.closeWebsite()
  }

  private websiteHooks(): WebsiteHooks {
    return {
      guide: (picker, node, caption) => this.guideStep(picker, node, caption),
      guideInput: (picker, at, click) => this.guideInput(picker, at, click),
      navigated: (url) => {
        if (this.website?.url === url) this.patchPreview({ website: url })
      },
      gone: () => {
        if (!this.website) return
        if (this.resources.chat?.turnRunning)
          this.websiteClosedNote =
            "The website's page crashed, so the preview is back on the user's app. Open it again with preview_navigate if needed."
        this.closeWebsite()
      },
      loadStarted: () => {
        this.keyboardBeforeLoad = this.keyboardOwner()
      },
      keepKeyboard: () => this.keepKeyboard(),
      loadStopped: () => {
        this.keepKeyboard()
        this.keyboardBeforeLoad = null
      },
      clicked: () => {
        this.keyboardBeforeLoad = null
        this.panel.pagePressed()
      },
      escape: () => {
        if (!this.host.focusMode || !this.host.isActive(this)) return false
        this.host.setFocusMode(false)
        return true
      },
    }
  }

  // The agent's walkthrough (preview_point), drawn by the pick overlay: the app's, or the
  // website's over it

  /**
   * A step on `picker` (the app's overlay, or the website's), if the user can see that page
   * and isn't picking; whether it's shown.
   */
  private guideStep(picker: Picker, node: number | null, caption: string | null) {
    if (this.host.sheetShown) return false
    const website = this.website && !this.website.closed ? this.website : null
    // The app's page is out of sight under a website, and a website's once it closed.
    if (
      picker === this.picker ? website || !this.state.preview.visible : picker !== website?.picker
    )
      return false
    if (this.placement.width <= 0) return false
    this.clearGuideEnd()
    return picker.guide(this.placement, node, caption)
  }

  /**
   * Every click, hover and keystroke the agent makes shows its pointer, so the user can follow
   * along, walkthrough or not. Not while the page is out of sight or they're picking.
   */
  private async guideInput(picker: Picker, at: Point, click: boolean) {
    if (!picker.guiding && !this.guideStep(picker, null, null)) return
    picker.guideCursor(at)
    await new Promise((resolve) => setTimeout(resolve, GUIDE_GLIDE_MS))
    // Once the pointer is there, as the click it shows goes through
    if (click) picker.guideClick()
  }

  /** The variations bar's buttons and keys. */
  variationsAction(action: VariationAction) {
    void this.variations.act(action)
  }

  variationsSize(width: number, height: number) {
    this.picker.setBarSize(width, height)
  }

  /**
   * The variations bar goes in the bottom-left of the app's page while it's in sight (a device
   * frame's page, beside a docked chat), right of a floating chat in that corner.
   */
  chatPlaced() {
    this.placeBar()
  }

  private placeBar() {
    const { visible } = this.state.preview
    const shown = visible && !this.website && !this.host.sheetShown && this.placement.width > 0
    this.picker.placeBar(shown ? this.placement : null, this.panel.bottomLeftRect())
  }

  /** The user clicked the walkthrough away, or it ran its course. A held website keeps its own. */
  endGuide() {
    this.clearGuideEnd()
    this.picker.endGuide()
    if (!this.website?.picker.holding) this.website?.picker.endGuide()
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
    const zoom = this.zoomOf('desktop') ?? 1
    const { width, height } = this.placement
    return {
      name,
      width: Math.round(width / zoom),
      height: Math.round(height / zoom),
      fixed: false,
    }
  }

  /** The user's guides, named in each prompt while the rulers show them. */
  private promptGuides(): PromptGuides | null {
    if (!this.rulersShown) return null
    const guides = this.guides.list()
    const viewport = this.promptViewport()
    if (!guides.length || !viewport) return null
    return { width: viewport.width, guides }
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
      // A message from outside the chat (the board's starters): the chat shows it going.
      if (accepted && this.panel.untuck()) this.layout()
      return accepted
    } catch {
      return false
    }
  }

  /** The toolbar's branch, from the HEAD file: on open, focus and a turn's end. */
  async refreshBranch() {
    const root = this.state.project?.root
    if (!root || this.resources.board) return
    const branch = await branchStatus(root)
    if (this.disposed || this.state.project?.root !== root) return
    const now = this.state.branch
    if (now?.branch === branch?.branch && (now === null) === (branch === null)) return
    this.patch({ branch })
  }

  /** versions_list: what the Versions sheet shows, for an agent helping find a restore point. */
  private async versionsForAgent(limit: number) {
    const chat = this.resources.chat
    if (!this.state.project || !chat) throw new Error('No project is open')
    return describeVersions(await chat.listVersions(), limit, chat.turnRunning)
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
   * Gets the project running: installs dependencies if they're missing or changed, then
   * starts the dev server. An untrusted project asks first, whether it's opening or the user
   * clicked; a trusted one asks again when its scripts changed.
   */
  private async setUpAndStart() {
    const { project, setup } = this.state
    const devServer = this.resources.devServer
    if (!project || !devServer || setup?.apps) return
    // Undo needs git from the first turn: find out now whether it runs, so a missing install
    // shows as a banner rather than macOS's own prompt mid-turn.
    void developerTools.gitAvailable()
    if (this.settingUp === devServer || setup?.dependencies === 'installing') return
    this.settingUp = devServer
    try {
      const installs = project.devCommand ? await this.installsFor(project) : []
      if (devServer !== this.resources.devServer) return
      // Nothing can install or run without Node.js, nor can the agent build an app with it:
      // offer Gui's own first. Once it's set up, this runs again (onNodeRuntime). A start
      // command of the user's own that isn't Node's (`python manage.py runserver`) doesn't.
      if (needsNode(project, installs) && (await nodeRuntime.missingFor(project.packageManager))) {
        if (devServer === this.resources.devServer) this.patchSetup({ node: nodeRuntime.state })
        return
      }
      if (this.state.setup?.node) this.patchSetup({ node: null })
      if (!project.devCommand) return
      if (!(await this.confirmScripts(project, installs))) return
      if (devServer !== this.resources.devServer) return
      this.watchStartFiles(project)
      const installed = installs.length === 0 || (await this.install(devServer, project, installs))
      // From now on a change to what it starts from restarts it; an install's own changes
      // to the lockfile came before this.
      const signature = await startSignature(project)
      if (!installed || devServer !== this.resources.devServer) return
      this.startedSignature = signature
      // The package manager is checked before every start: it may have gone since the install.
      const tool = packageManagerOf(project.devCommand)
      const missing = tool && (await missingPackageManager(tool, await getShellEnv()))
      if (devServer !== this.resources.devServer) return
      if (missing) return devServer.fail(missing)
      await devServer.start(project.devCommand, project.custom?.url ?? null)
    } finally {
      if (this.settingUp === devServer) this.settingUp = null
    }
  }

  /** What to install before starting: after a failed install, all of it again. */
  private async installsFor(project: ProjectInfo) {
    if (this.state.setup?.dependencies === 'failed') return installTargets(project)
    return installsNeeded(project)
  }

  /**
   * Installs where it's needed (the workspace root, an app with its own package.json),
   * streaming into the logs. True when every install succeeded.
   */
  private async install(devServer: DevServer, project: ProjectInfo, installs: InstallTarget[]) {
    const current = () => devServer === this.resources.devServer
    this.patchSetup({ dependencies: 'installing' })
    const env = await getShellEnv()
    for (const target of installs) {
      const missing = await missingPackageManager(target.packageManager, env)
      if (!current()) return false
      if (missing) {
        devServer.print(missing)
        this.patchSetup({ dependencies: 'failed' })
        return false
      }
      // Marked as not installed until it succeeds: an install cut short leaves a partial
      // node_modules that must not pass for installed next time.
      try {
        await recordInstall(project.root, target.dir, '')
      } catch (error) {
        console.error('[gui] failed to clear the installed dependencies', error)
        if (current()) {
          devServer.print("Gui couldn't record the dependency setup. Try installing again.")
          this.patchSetup({ dependencies: 'failed' })
        }
        return false
      }
      if (!current()) return false
      const dir = target.dir ? join(project.root, target.dir) : project.root
      const command = installCommand(target.packageManager)
      const result = await devServer.runTask(command, dir, INSTALL_TIMEOUT_MS)
      if (!current()) return false
      if (result === 'timeout') {
        devServer.print(
          `${command} ran for ${INSTALL_TIMEOUT_MS / 60_000} minutes without finishing, so Gui stopped it. The logs show where it got stuck.`,
        )
      }
      if (result !== 0) {
        this.patchSetup({ dependencies: 'failed' })
        return false
      }
      try {
        await recordInstalled(project, target.dir)
      } catch (error) {
        console.error('[gui] failed to record the installed dependencies', error)
        if (current()) {
          devServer.print("Gui couldn't record the installed dependencies. Try installing again.")
          this.patchSetup({ dependencies: 'failed' })
        }
        return false
      }
      if (!current()) return false
    }
    this.patchSetup({ dependencies: 'ok' })
    return true
  }

  /**
   * Watches the files the app starts from, in its folder and the root, and restarts it when
   * they change. Follows the app: a switch to another one watches its folder instead.
   */
  private watchStartFiles(project: ProjectInfo) {
    const resources = this.resources
    const generation = resources.generation
    void reloadsItself(project).then((selfReloading) => {
      if (!resources.stillCurrent(generation)) return
      const dirs = startDirs(project)
      const current = resources.startWatch
      if (current?.key === StartWatch.keyOf(dirs, selfReloading)) {
        return
      }
      current?.close()
      resources.startWatch = new StartWatch(dirs, selfReloading, () => {
        if (resources.stillCurrent(generation)) this.onStartFilesChanged()
      })
    })
  }

  /** The app's start files changed: restart it, once any turn in progress is over. */
  private onStartFilesChanged() {
    if (this.resources.chat?.turnRunning) {
      this.restartAfterTurn = true
      return
    }
    void this.restartForChanges()
  }

  /**
   * Restarts the app because what it starts from changed: not if it isn't running (stopped,
   * or never agreed to), nor if the files hash as they did when it started.
   */
  private async restartForChanges() {
    const resources = this.resources
    const generation = resources.generation
    const { project, devServer, setup } = this.state
    if (!project?.devCommand || this.resources.chat?.turnRunning) {
      if (project?.devCommand) this.restartAfterTurn = true
      return
    }
    // Busy starting or installing: look again once that's done.
    if (this.settingUp || this.retrying) {
      const watch = this.resources.startWatch
      watch?.schedule()
      return
    }
    if (devServer.status === 'idle' && setup?.dependencies !== 'failed') return
    const signature = await startSignature(project)
    if (signature === this.startedSignature || !resources.stillCurrent(generation)) return
    const now = Date.now()
    this.autoRestarts = this.autoRestarts.filter((at) => now - at < AUTO_RESTART_WINDOW_MS)
    if (this.autoRestarts.length >= MAX_AUTO_RESTARTS) return
    this.autoRestarts.push(now)
    this.resources.devServer?.print('Your project’s setup changed, so Gui is restarting your app.')
    await this.retryStartup()
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
    devServer.clearExit()
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
    const agreed = await this.askToTrust(
      project.root,
      {
        message: `Start ${promptName(project.name)} a different way?`,
        detail: `Your agent wants Gui to start this app${where}${address} with:\n\n${promptText(start.command, 2000)}\n\nGui will run it now and whenever you open this project. You can go back to the detected command in Settings. It runs code on your Mac. Only use commands you trust.`,
        buttons: ['Use This Command', 'Cancel'],
        // The agent asked, not the user: Return mustn't be what agrees.
        defaultId: 1,
      },
      // The command is agreed to; the project's install scripts aren't, yet.
      (await trustedScripts(project.root)) ?? NOTHING_AGREED,
    )
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
    // They wrote it: it runs without asking. Install scripts they haven't seen still ask.
    if (start) await this.trustCommand(root)
    // Not waited on: installing can take minutes, and the canvas follows it.
    if (this.state.project?.root === root) void this.retryStartup()
  }

  /** The user's own start command: the project is trusted to run it. */
  private async trustCommand(root: string) {
    await trust(root)
    if (!(await trustedScripts(root))) await recordTrustedScripts(root, NOTHING_AGREED)
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
   * waits, or it doesn't offer that.
   */
  permissionAnswer(allow: boolean) {
    const waiting = this.resources.chat?.oldestPermission()
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
    this.setDocked(!this.resources.chat.meta.docked)
  }

  /**
   * Docks the chat beside the preview, on `side` or the side it was last, or floats it: ⇧⌘D,
   * and the chat dragged to an edge or pulled off it. Either way the preview morphs into the
   * room it gets or gives up, and it's the default for chats from now on.
   */
  setDocked(docked: boolean, side?: 'left' | 'right') {
    const chat = this.resources.chat
    if (!chat) return
    this.leaveFocusMode()
    // From where it's drawn now, before anything changes: the card turns into the sidebar or
    // back, rather than one replacing the other.
    const shaped = this.panel.shapeTo(docked, side ?? getPrefs().chatSidebarSide)
    // Floating again, it shows the conversation the sidebar did.
    this.panel.showConversation()
    this.panel.untuck()
    this.morphLayout('dock')
    setPrefs(side ? { chatSidebar: docked, chatSidebarSide: side } : { chatSidebar: docked })
    if (side) chat.setSidebarSide(side)
    chat.setDocked(docked)
    if (!this.state.chatVisible) this.patch({ chatVisible: true })
    // Not on screen to turn from: the sidebar slides in from the edge.
    if (docked && !shaped) this.panel.holdDock()
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

  /**
   * Undoes the newest turn that changed files and hasn't been undone. Only with the chat in
   * view, where its turn shows "Undone" and Redo: hidden, the change would go back unseen.
   */
  async undoLastChange() {
    const chat = this.resources.chat
    const turnId = this.panel.chatInView ? chat?.lastUndoableTurnId() : null
    if (!chat || !turnId) return shell.beep()
    await chat.restoreTurn(turnId).catch(() => shell.beep())
  }

  async redoLastChange() {
    if (!this.panel.chatInView || !this.resources.chat?.meta.redoTurnIds.length) return shell.beep()
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

  /** The message box's Show conversation: the floating panel grows to show it. */
  expandChat() {
    this.panel.expandChat()
  }

  chatCollapsed(seq: number) {
    this.panel.chatCollapsed(seq)
  }

  chatBoxHeight(height: number) {
    this.panel.setBoxHeight(height)
  }

  holdChat(held: boolean) {
    this.panel.hold(held)
  }

  chatDrafted(drafted: boolean) {
    this.panel.setDrafted(drafted)
  }

  /** A press in the page (the board's, from the chrome): see `ChatPanel.pagePressed`. */
  pagePressed() {
    this.panel.pagePressed()
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

  /** Like the agent's tools: only the local app, never a page it linked to or a website. */
  private canCapture() {
    return (
      this.state.preview.visible &&
      this.state.preview.website === null &&
      isLoopback(this.preview.webContents.getURL())
    )
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
        item('Copy Screenshot', 'copy'),
        item('Copy Full Page', 'copy-full-page'),
        item('Save Screenshot…', 'save'),
        { type: 'separator' },
        item('Attach to Chat', 'attach', this.resources.chat !== null),
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

  /** Gives the keyboard back to the view that had it before the page loaded; true when it did. */
  private keepKeyboard() {
    const owner = this.keyboardBeforeLoad
    if (!owner || owner.isDestroyed() || owner.isFocused() || this.state.preview.selecting)
      return false
    if (!this.host.isActive(this) || !this.host.win.isFocused()) return false
    owner.focus()
    return true
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
    const { bounds, emulation } = placePreview(viewport, area, this.zoomOf(viewport))
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
    // A website the agent opened lies over the app, in its viewport, whether or not the app
    // has a page to show.
    const website = this.website
    const websiteShown = website !== null && area.width > 0 && !covered
    if (website) {
      website.view.setBounds(bounds)
      website.view.setVisible(websiteShown)
      website.emulation.set(emulation)
      if (website.picker.guiding) {
        if (websiteShown) website.picker.setBounds(bounds)
        else website.picker.endGuide()
      }
      // Back in sight mid-turn: held again.
      if (websiteShown) this.holdWebsite()
    }
    // Picking needs the page on screen, where the overlay lies over it.
    if (this.picker.picking) {
      if (visible) this.picker.setBounds(bounds)
      else void this.setSelecting(false)
    } else if (this.picker.guiding) {
      if (visible) this.picker.setBounds(bounds)
      else this.endGuide()
    }
    this.emulation.set(live ? live.emulation : emulation)
    // Guides follow the app's own page, at rest: not mid-morph, nor under a website or a sheet.
    const guided = visible && !live && !website && !this.resources.board
    this.guides.place(this.host.win.contentView, guided ? bounds : null, this.host.canvas)
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
   * preview is on screen and nothing's being picked or walked through, whose overlay is placed
   * at the final layout), rather than jumping there.
   */
  morphLayout(kind: MorphKind) {
    const { win } = this.host
    // A website over the app would morph the app's page, out of sight: it simply resizes.
    const eligible =
      !this.disposed &&
      this.website === null &&
      this.host.isActive(this) &&
      this.state.preview.visible &&
      !this.state.preview.selecting &&
      !this.picker.guiding &&
      !this.host.sheetShown &&
      win.isVisible() &&
      !win.isMinimized()
    this.morph.request(kind, eligible)
    this.panel.holdFloat()
    // Mid-move a request only retargets, so `moving` won't come again: fly now.
    if (this.morph.moving) this.panel.flyHeld()
  }

  /**
   * The canvas: the chrome already leaves room for the sidebar (`sidebarWidth`). With the
   * rulers on, a project's page moves over for them, along the canvas's top and left edges.
   */
  private previewArea(): Rect {
    const canvas = this.host.canvas
    if (!this.rulersShown) return canvas
    return {
      x: canvas.x + RULER_SIZE,
      y: canvas.y + RULER_SIZE,
      width: Math.max(0, canvas.width - RULER_SIZE),
      height: Math.max(0, canvas.height - RULER_SIZE),
    }
  }

  /** The rulers are on, and this is a project's preview (a canvas has none). */
  private get rulersShown() {
    return this.guides.on && this.state.project !== null && !this.resources.board
  }

  rulerDrag(axis: 'x' | 'y', phase: 'move' | 'end' | 'cancel', at: Point) {
    this.guides.rulerDrag(axis, phase, at)
  }

  guidePointer(id: string, phase: GuidePointerPhase, at: Point) {
    this.guides.stripPointer(id, phase, at)
  }

  /** The preview's page scrolled to `x`, `y` (its preload says). */
  previewScrolled(x: number, y: number) {
    this.guides.setScroll(x, y)
  }

  // Native menus

  showDevServerMenu() {
    const { status, url } = this.state.devServer
    const running = status === 'running' || status === 'starting'
    const showingLogs = this.state.drawer.open && this.state.drawer.tab === 'server'
    const template: MenuItemConstructorOptions[] = [
      running
        ? { label: 'Restart Dev Server', click: () => this.restartDevServer() }
        : {
            label: 'Start Dev Server',
            enabled: !!this.state.project?.devCommand,
            click: () => this.startDevServer(),
          },
      { label: 'Stop Dev Server', enabled: running, click: () => this.stopDevServer() },
      { type: 'separator' },
      {
        label: showingLogs ? 'Hide Logs' : 'Show Logs',
        click: () => (showingLogs ? this.setDrawerOpen(false) : this.showLogs()),
      },
      {
        label: 'Open in Browser',
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
      { label: 'New Chat', enabled: this.hasProject, click: () => this.newChat() },
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
  showChatMenu(at: { x: number; y: number }) {
    if (!this.hasProject) return
    const choose = (choice: ChatMenuChoice) => this.sendChat(Events.chatMenuChoice, choice)
    const template: MenuItemConstructorOptions[] = [
      { label: 'Versions…', click: () => choose('versions') },
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

  /**
   * A frame's context menu on the board; acts on every selected frame when it's one of them.
   * `at` is where the keyboard opened it, in the window; without it, at the pointer.
   */
  showFrameMenu(id: string, promote: (id: string) => void, at?: Point) {
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
    Menu.buildFromTemplate(template).popup({
      window: this.host.win,
      ...(at && this.inWindow(null, at)),
    })
  }

  /** A new section around frames, then naming it in place on the board. */
  async boardAddSection(ids: string[]) {
    const board = this.resources.board
    const section = await board?.addSection(ids)
    if (section && this.resources.board === board)
      this.send(Events.board, { type: 'renameSection', id: section.id })
  }

  /** A section's context menu on the board: its name, its frames, exporting, deleting. */
  showSectionMenu(id: string, at?: Point) {
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
    Menu.buildFromTemplate(template).popup({
      window: this.host.win,
      ...(at && this.inWindow(null, at)),
    })
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
    openCanvas: () => void,
    openClone: () => void,
    openRecent: (root: string) => void,
  ) {
    const recent = (this.state.recent ?? []).filter((p) => p.root !== this.state.project?.root)
    const template: MenuItemConstructorOptions[] = [
      { label: 'Open Project…', click: openPicker },
      { label: 'New Project…', click: openNew },
      // Opens at once, so no ellipsis (as in the File menu).
      { label: 'New Canvas', click: openCanvas },
      { label: 'Clone…', click: openClone },
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
              label: 'Switch Project…',
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
    const { visible, selectable, website } = this.state.preview
    return visible && selectable && website === null
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

  sendChrome(channel: string, payload: unknown) {
    this.send(channel, payload)
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
    this.stopListeningToChrome()
    this.clearFrameCheck()
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
    this.guides.dispose()
    this.inspector.dispose()
    if (!this.preview.webContents.isDestroyed()) this.preview.webContents.close()
    if (!this.chatView.webContents.isDestroyed()) this.chatView.webContents.close()
  }
}
