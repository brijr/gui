import type { BoardCamera, BoardFrameLayout, BoardSection } from './board'
import type { ShortcutId } from './shortcuts'

/** A built-in agent's id, or `custom:<name>` for one the user added in agents.json */
export type AgentId = string

export interface AgentInfo {
  id: AgentId
  name: string
}

/** Built-in agents, in menu order. */
export const AGENTS: readonly AgentInfo[] = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
  { id: 'grok', name: 'Grok Build' },
  { id: 'kiro', name: 'Kiro' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'pi', name: 'Pi' },
  { id: 'muse', name: 'Muse Code' },
  { id: 'amp', name: 'Amp' },
  { id: 'devin', name: 'Devin' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'fx', name: 'fx' },
  { id: 'jcode', name: 'jcode' },
  { id: 'gemini', name: 'Gemini CLI' },
]

export const DEFAULT_AGENT_ID: AgentId = 'claude'
export const CUSTOM_AGENT_PREFIX = 'custom:'

/** Built-in ids, or a custom id (which may no longer exist in agents.json). */
export function isAgentId(value: unknown): value is AgentId {
  if (typeof value !== 'string') return false
  if (value.startsWith(CUSTOM_AGENT_PREFIX)) return value.length > CUSTOM_AGENT_PREFIX.length
  return AGENTS.some((agent) => agent.id === value)
}

export function agentName(id: AgentId) {
  if (id.startsWith(CUSTOM_AGENT_PREFIX)) return id.slice(CUSTOM_AGENT_PREFIX.length)
  return AGENTS.find((agent) => agent.id === id)?.name ?? id
}

/** Where an agent's CLI comes from: the user's own install, Gui's download, or dev's node_modules */
export type AgentBinarySource = 'yours' | 'gui' | 'bundled'

export interface AgentHealth {
  id: AgentId
  name: string
  status:
    | 'unknown'
    | 'checking'
    | 'not-installed'
    | 'installing'
    | 'signing-in'
    | 'ready'
    | 'signed-out'
    | 'error'
  message: string | null
  /** Technical detail behind `message` (exit code, stderr), shown on request */
  detail: string | null
  /** The CLI this agent needs on PATH; null when Gui bundles everything it needs */
  command: string | null
  /** The agent's official install page, for agents the user installs themselves */
  installUrl: string | null
  /** Switched on in Settings; disabled agents are hidden from menus and not checked */
  enabled: boolean
  /** A sign-in flow Gui can start for this agent, when it offers one */
  signIn: { methodId: string; label: string } | null
  /** Gui can download the agent's CLI: `update` when the user's own is incompatible */
  install: 'install' | 'update' | null
  /** Download progress while installing: bytes so far and total (null when unknown) */
  progress: { received: number; total: number | null } | null
  /** The CLI Gui runs for this agent, once found */
  binary: { source: AgentBinarySource; version: string } | null
  /** Its models and effort levels, as its last check reported them (before the user's choice) */
  models: ModelSettings | null
}

/**
 * The agent can't take a message until the user sets it up: it isn't installed or signed in,
 * or it's being installed or signed in to right now. A chat holds messages until it's ready.
 */
export function needsSetup(health: AgentHealth | null) {
  const status = health?.status
  return (
    status === 'not-installed' ||
    status === 'installing' ||
    status === 'signed-out' ||
    status === 'signing-in'
  )
}

/**
 * What a new project starts from: an empty folder, or a small app that already runs (Vite,
 * React and Tailwind) so the preview shows something to point at right away.
 */
export type ProjectTemplate = 'blank' | 'website' | 'dashboard'

export const PROJECT_TEMPLATES: readonly { id: ProjectTemplate; name: string }[] = [
  { id: 'website', name: 'Website' },
  { id: 'dashboard', name: 'Dashboard' },
  { id: 'blank', name: 'Blank' },
]

export function isProjectTemplate(value: unknown): value is ProjectTemplate {
  return PROJECT_TEMPLATES.some((template) => template.id === value)
}

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'

export interface ProjectInfo {
  root: string
  name: string
  packageManager: PackageManager
  devCommand: string | null
  /** Body of the package.json script devCommand runs */
  devScript: string | null
  /** In a monorepo, the app the dev server runs in (POSIX path relative to root); null for the root */
  appDir: string | null
  /** The start command set in Gui, in place of what it found; null when it runs what it found */
  custom: StartCommand | null
  /**
   * With no dev script: the `start` (or `serve`) script Gui passed over because it serves a
   * production build (`next start`), to say why nothing starts. Null otherwise.
   */
  productionScript: string | null
}

/**
 * How Gui starts a project when what it detects isn't right: set by the user, or by their
 * agent with the user's approval. Kept in Gui's own data, never in the project.
 */
export interface StartCommand {
  /** Run in the user's login shell, like a package.json script */
  command: string
  /** The folder it runs in (POSIX path relative to the root); null for the root */
  dir: string | null
  /** The app's address, for a server that doesn't print one; null to read it from the output */
  url: string | null
}

/** A start command as the user or agent gives it, before Gui checks it (`validateStartCommand`) */
export interface StartCommandInput {
  command: string
  dir?: string | null
  url?: string | null
}

/** An app inside a monorepo that Gui can preview */
export interface WorkspaceApp {
  /** POSIX path relative to the project root */
  dir: string
  name: string
}

/**
 * What a project needs before its dev server can run, shown in the canvas until the
 * preview is up. Null when there's nothing to do.
 */
/**
 * Node.js that Gui sets up for a Mac without it (`installNode`): needed before the project
 * can install or run, offered with its download's progress, or why it failed
 */
export interface NodeSetup {
  status: 'missing' | 'installing' | 'failed' | 'ready'
  /** Bytes so far and total (null when unknown) while downloading */
  progress: { received: number; total: number | null } | null
  error: string | null
}

export interface ProjectSetup {
  /** Set when a monorepo has several apps and none is chosen yet (see `chooseApp`) */
  apps: WorkspaceApp[] | null
  /** The project needs Node.js and this Mac has none yet; null when it has (or needs none) */
  node?: NodeSetup | null
  /** `installing` streams into the logs; `failed` offers a retry */
  dependencies: 'ok' | 'missing' | 'installing' | 'failed'
  /**
   * Nothing runs until the user agrees on the setup card: an untrusted project, or one whose
   * scripts changed since they agreed. Agreeing (`agreeToStart`) also lets the agent work in it.
   */
  consent?: SetupConsent | null
  /**
   * An env example file exists but no local env file does. `target` is the file
   * `createEnvFile` writes (gitignored), `created` once it has.
   */
  env: { example: string; target: string; created: boolean } | null
}

/** What the setup card asks the user to agree to (`ProjectSetup.consent`). */
export interface SetupConsent {
  /** Sent back by the card's button, so it agrees to exactly what the card showed */
  id: string
  /** Install then start; start; or with nothing to start yet, let the agent work here */
  action: 'install' | 'start' | 'trust'
  /** A trusted project whose scripts changed since the user agreed to them */
  changed: boolean
  /** What runs, cleaned up and cut short (`promptText`), behind the card's disclosure */
  details: string
}

export interface RecentProject {
  root: string
  name: string
  openedAt: number
  /** Its chat's last message and when it was sent; absent with no chat (or in the saved list) */
  chat?: { prompt: string; at: number } | null
}

/** The branch a project is on, read from Git's HEAD file. */
export interface BranchStatus {
  /** Null when no branch is checked out */
  branch: string | null
}

/** An archived chat, as a project's list of them shows it */
export interface ChatSummary {
  id: string
  /** The user's name for it; null shows `prompt` */
  title: string | null
  /** Its first message, on one line and cut short ("Image" for images alone) */
  prompt: string
  agentId: AgentId
  turns: number
  startedAt: number
  /** When its last turn ended */
  lastAt: number
}

export type DevServerStatus = 'idle' | 'starting' | 'running' | 'exited'

export interface DevServerState {
  status: DevServerStatus
  command: string | null
  url: string | null
  exitCode: number | null
  lastLine: string
  /**
   * After a failed run or install: the first line of its output that reads like the cause
   * ("Error: Cannot find module './config'"), else its last line that isn't the package
   * manager's own; empty otherwise
   */
  errorLine: string
  /** Still starting well after most apps are up (no reachable address yet) */
  slow: boolean
}

/** One of a project's terminals: the user's own shell, in the drawer under the canvas */
export type TerminalId = `terminal-${number}`

export function isTerminalId(value: unknown): value is TerminalId {
  return typeof value === 'string' && /^terminal-\d{1,9}$/.test(value)
}

/** A tab of the drawer: the dev server's output, or a terminal */
export type DrawerTab = 'server' | TerminalId

export function isDrawerTab(value: unknown): value is DrawerTab {
  return value === 'server' || isTerminalId(value)
}

export interface TerminalInfo {
  id: TerminalId
  /** "Terminal", "Terminal 2"… */
  title: string
  /** Its shell has exited; the drawer offers to start a new one in its place */
  exited: boolean
}

/** What the drawer shows once terminal `id` closes: the next one, the one before, or the logs. */
export function drawerNeighbor(terminals: readonly TerminalInfo[], id: TerminalId): DrawerTab {
  const index = terminals.findIndex((terminal) => terminal.id === id)
  return terminals[index + 1]?.id ?? terminals[index - 1]?.id ?? 'server'
}

/** The drawer under the canvas (⌘J): the dev server's output and the project's terminals */
export interface DrawerState {
  open: boolean
  /** The tab it shows, or showed when last open; null until the first time it opens */
  tab: DrawerTab | null
  /** In tab order; a terminal only exists once the user has opened it */
  terminals: TerminalInfo[]
}

/**
 * The preview's viewports, in toolbar and View menu order (⌘1…⌘4). Desktop fills the canvas;
 * the others are device frames: the page lays out at exactly `size` (CSS pixels), drawn
 * smaller when the canvas can't fit it.
 */
export const VIEWPORTS = [
  { id: 'desktop', name: 'Desktop', size: null, mobile: false },
  { id: 'laptop', name: 'Laptop', size: { width: 1440, height: 900 }, mobile: false },
  { id: 'tablet', name: 'Tablet', size: { width: 820, height: 1180 }, mobile: true },
  { id: 'mobile', name: 'Mobile', size: { width: 390, height: 844 }, mobile: true },
] as const satisfies readonly ViewportSpec[]

export interface ViewportSpec {
  id: string
  name: string
  /** The page's size in CSS pixels; null to fill the canvas */
  size: { width: number; height: number } | null
  /** Emulated as a touch device: `<meta name=viewport>` applies and scrollbars overlay */
  mobile: boolean
}

/** One of VIEWPORTS: what a project's preview can be, and ⌘1…⌘4 choose */
export type DeviceViewport = (typeof VIEWPORTS)[number]['id']
/**
 * A canvas frame's own size, `1080x1080`, when it opens live and no device's width is its own
 * (`frameViewport`): a frame like a device's at exactly that size.
 */
export type CustomViewport = `${number}x${number}`
export type Viewport = DeviceViewport | CustomViewport

export function isViewport(value: unknown): value is DeviceViewport {
  return VIEWPORTS.some((viewport) => viewport.id === value)
}

const CUSTOM = /^(\d+)x(\d+)$/

export function customSize(value: unknown): { width: number; height: number } | null {
  const match = typeof value === 'string' ? CUSTOM.exec(value) : null
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null
}

export function isCustomViewport(value: unknown): value is CustomViewport {
  return customSize(value) !== null
}

export function viewportSpec(id: Viewport): ViewportSpec {
  const size = customSize(id)
  if (size) return { id, name: `${size.width} × ${size.height}`, size, mobile: false }
  return VIEWPORTS.find((viewport) => viewport.id === id) ?? VIEWPORTS[0]
}

/** The window height a long page at a non-device width opens at (Laptop's). */
const LONG_PAGE_HEIGHT = 900

/**
 * The viewport a canvas frame opens live in: the device it's the size of, or the one its width
 * is (a long page scrolls in it); otherwise its own size. A frame taller than 9:16 is a long
 * page, not a poster, so it opens laptop-high and scrolls.
 */
export function frameViewport(frame: { width: number; height: number }): Viewport {
  const device =
    VIEWPORTS.find(({ size }) => size?.width === frame.width && size?.height === frame.height) ??
    VIEWPORTS.find(({ size }) => size?.width === frame.width)
  if (device) return device.id
  const long = frame.height > (frame.width * 16) / 9
  return `${Math.round(frame.width)}x${Math.round(long ? LONG_PAGE_HEIGHT : frame.height)}`
}

/**
 * The line above a device frame: its name, then "· 1440 × 900", and "· 80%" when it's drawn
 * smaller (floored, so a frame drawn even slightly smaller never reads 100%).
 */
export function frameLabel(id: Viewport, scale: number) {
  const { name, size } = viewportSpec(id)
  const percent = Math.floor(scale * 100)
  // A frame's own size is named by its size alone.
  const dimensions = size && !customSize(id) ? ` · ${size.width} × ${size.height}` : ''
  const detail = `${dimensions}${percent < 100 ? ` · ${percent}%` : ''}`
  return { name, detail }
}

/** Its key with ⌘ (the View menu's shortcut): 1 for the first viewport, and so on. */
export function viewportKey(id: DeviceViewport) {
  return String(VIEWPORTS.findIndex((viewport) => viewport.id === id) + 1)
}

/** A fixed viewport's frame on the canvas, for the chrome to draw around the preview */
export interface ViewportFrame {
  /** The device, which the label names (the viewport it was drawn for, mid-change) */
  viewport: Viewport
  /** Where the preview is, in the canvas's own coordinates */
  rect: Rect
  /** How large the page is drawn: 1 at its CSS size, less when scaled down to fit */
  scale: number
}

/**
 * A ruler guide: a line across the preview at `at`, in the page's CSS pixels (the units of
 * its CSS). An `x` guide is a vertical line at that x; a `y` guide a horizontal one at that y,
 * which scrolls with the page's content.
 */
export interface RulerGuide {
  axis: 'x' | 'y'
  at: number
}

/** What the rulers beside the preview show (main/guides.ts → the chrome's canvas). */
export interface RulersView {
  /** Where the page is, in the canvas's own coordinates */
  page: Rect
  /** How large the page is drawn: the preview view's pixels per CSS pixel */
  scale: number
  /** How far the page is scrolled, in its CSS pixels */
  scroll: Point
  guides: RulerGuide[]
  /**
   * The guide under the pointer or being dragged, where it is now; its ruler shows that.
   * `removing`: it's over its ruler, and letting go deletes it.
   */
  active: (RulerGuide & { removing: boolean }) | null
}

/** The guides' own overlay (src/renderer/src/guides-main.ts): one grab strip per guide. */
export interface GuideStrips {
  strips: { id: string; axis: RulerGuide['axis'] }[]
  /** The guide being dragged: its own strip hides while the `drag` strip shows where it goes */
  dragging: string | null
  /** --accent for the appearance */
  color: string
}

/** Why the preview couldn't show a page: plain words, and the raw code behind Details */
export interface PreviewError {
  message: string
  detail: string
}

export interface PreviewState {
  url: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: PreviewError | null
  viewport: Viewport
  /** The device frame the preview is shown in; null for Desktop, which fills the canvas */
  frame: ViewportFrame | null
  /**
   * Desktop's page zoom, 1 at 100% (View → Zoom In, Zoom Out, Actual Size). A device frame's
   * zoom is its `frame.scale`.
   */
  zoom: number
  selecting: boolean
  /** The rulers are on (⇧R, View → Rulers): Gui's pref, the same in every tab */
  rulers: boolean
  /** Element picking is only allowed on the local app, not off-site pages */
  selectable: boolean
  visible: boolean
  /**
   * The app's server stopped (Stop, or it quit): the page is hidden, since it no longer
   * updates, and this picture of it (a JPEG data URL) is drawn dimmed under the card that
   * says so. Null otherwise.
   */
  still: string | null
  /**
   * The address of the website the agent opened in the preview, shown over the app in a
   * separate, signed-out session (main/website.ts); null while the preview shows the app
   */
  website: string | null
}

/**
 * A change that moves or resizes the preview, which resizes the live page into its new layout
 * rather than jumping there (main/preview-morph.ts, renderer app/layout-morph.ts): another
 * viewport, a zoom step, the drawer opening or closing, the chat docking (or a docked chat
 * showing or hiding), focus mode.
 */
export type MorphKind = 'viewport' | 'zoom' | 'drawer' | 'dock' | 'focus'

/** Where the preview is, or is going, in a morph. */
export interface MorphPlacement {
  /** The preview view, in window coordinates */
  rect: Rect
  /** How large the page is drawn: a device frame's scale, or Desktop's zoom */
  scale: number
  /** The device frame around it, drawn with its label; null for Desktop */
  frame: Viewport | null
}

/**
 * Main → the chrome, one morph (`id`) at a time: a change is coming (`pending`), where the
 * live view is on each frame of its motion (`frame`), and the view resting in its new layout
 * (`end`, which also comes for a change that moved nothing).
 */
export type MorphEvent =
  | { type: 'pending'; id: number; kind: MorphKind }
  | {
      type: 'frame'
      id: number
      kind: MorphKind
      /** The preview view, in window coordinates */
      rect: Rect
      scale: number
      /** The device the frame's label names; null for Desktop at both ends */
      viewport: Viewport | null
      /** The device frame's edge and label: 1 around a device, 0 around Desktop */
      opacity: number
    }
  | { type: 'end'; id: number }

/**
 * Main → the chrome, while the chat sidebar slides in or out: how much of it is in the window
 * on each side now, in px, as main last placed it. Null once it rests where `sidebarWidth`
 * says. The bars beside it follow this rather than a spring of their own, so they can't drift.
 */
export type SidebarSlide = { left: number; right: number } | null

/**
 * An item in the toolbar's overflow ("…") menu: a tool that gave up its place in the toolbar
 * for want of room. Main shows them as a native menu and answers with the chosen `id`.
 */
export type ToolbarMenuItem =
  | { type: 'separator' }
  | {
      type?: 'normal' | 'checkbox' | 'radio'
      id: string
      /** Title Case, as in every native menu */
      label: string
      /** Its keys, shown at the item's end (they work from the app menu already) */
      shortcut?: ShortcutId
      enabled?: boolean
      checked?: boolean
    }

/**
 * What a tab shows next to its name: its agent working, a permission card waiting for the
 * user, or something that failed (the agent, the install or the dev server).
 */
export type TabStatus = 'idle' | 'working' | 'attention' | 'error'

/** A tab in a window's tab strip: one project with its own preview, chat and dev server */
export interface TabInfo {
  id: string
  /** The project's name; null for a start-screen tab */
  title: string | null
  status: TabStatus
}

/** The window's active tab: its project, preview and chat, and the window's tab strip */
export interface WindowState {
  project: ProjectInfo | null
  devServer: DevServerState
  /** The dev server's current errors (from its output), counted on the drawer's Dev server tab */
  serverErrors: number
  preview: PreviewState
  agentId: AgentId
  chatVisible: boolean
  /**
   * The chat sidebar's width while it shows; the chrome leaves this much room on
   * sidebarSide for the chat. 0 otherwise.
   */
  sidebarWidth: number
  sidebarSide: 'left' | 'right'
  drawer: DrawerState
  /** Null until read, so the start screen doesn't draw without it and then jump */
  recent: RecentProject[] | null
  /** The user's home folder, so paths can show it as ~ */
  home: string
  agents: AgentHealth[]
  setup: ProjectSetup | null
  /** The open project's branch; null outside a repository */
  branch: BranchStatus | null
  /**
   * Git can't run until Apple's developer tools are installed ('missing'), or the user is
   * installing them; null when it can (or hasn't been needed yet). Undo and sharing need git.
   */
  developerTools: 'missing' | 'installing' | null
  /** A new version of Gui is downloaded: Restart to Update installs it. Null with none */
  updateReady: string | null
  /** The window's tabs, in order; the strip shows once there are two or more */
  tabs: TabInfo[]
  /** The canvas this tab shows, when it's a canvas rather than a project; null otherwise */
  board: BoardState | null
  /** Canvases for the start screen, last edited first; null until read */
  recentBoards: RecentBoard[] | null
  /** Id of the tab this state is for, the one the window shows */
  activeTab: string
  /**
   * Focus mode (View → Focus Mode): the preview alone under a slim title bar. The toolbar,
   * tab strip, chat and drawer keep their state, and show again as they were when it ends.
   */
  focusMode: boolean
  /** Help → Keyboard Shortcuts is open over the window */
  shortcutsOpen: boolean
  /** The window is in macOS full screen, which hides its traffic lights */
  fullScreen: boolean
}

/** A frame on a canvas, as the board draws it. */
export interface BoardFrame extends BoardFrameLayout {
  /** Changes whenever its page or thumbnail does, so the board loads the new thumbnail */
  version: number
  /** A thumbnail has been captured for it */
  captured: boolean
  /** Its page was rewritten (by the agent) and its new thumbnail is being made */
  rendering: boolean
}

/** A canvas open in a tab: its frames, what's selected, and the frame open in the preview. */
export interface BoardState {
  id: string
  name: string
  frames: BoardFrame[]
  /** Named areas holding frames, drawn behind them */
  sections: BoardSection[]
  /** Frame ids, in the order they were selected */
  selection: string[]
  /** The frame shown in the preview, live; null on the board */
  open: string | null
  /** Where the board was looking when it was last left; null to fit its frames */
  camera: BoardCamera | null
  /** Where the board loads thumbnails from: `${thumbs}/<frame id>?v=<version>` */
  thumbs: string
  /** The board's own changes ⌘Z can undo */
  canUndo: boolean
  /** The board's own changes ⌘Z undid, which ⇧⌘Z can put back */
  canRedo: boolean
}

/** A canvas as the start screen lists it. */
export interface RecentBoard {
  id: string
  name: string
  frames: number
  editedAt: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** The floating chat panel's edges and corners, which resize it; docked, only `left` does */
export const PANEL_EDGES = [
  'top',
  'right',
  'bottom',
  'left',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const

export type PanelEdge = (typeof PANEL_EDGES)[number]

export function isPanelEdge(value: unknown): value is PanelEdge {
  return PANEL_EDGES.some((edge) => edge === value)
}

/** The floating chat panel's anchored corner, which stays put; its bubble sits there too */
export interface PanelCorner {
  x: 'left' | 'right'
  y: 'top' | 'bottom'
}

/**
 * What the floating chat is drawn as: the panel, or the bubble while the user picks an element
 * or uses the page. Each sits at the anchored corner.
 */
export type ChatForm = 'panel' | 'bubble'

export const CHAT_FORMS: readonly ChatForm[] = ['panel', 'bubble']

export function isChatForm(value: unknown): value is ChatForm {
  return CHAT_FORMS.some((form) => form === value)
}

/** The floating chat's form and the corner it's anchored by, as main lays its view out. */
export interface ChatFloat {
  form: ChatForm
  corner: PanelCorner
  /**
   * Counts changes of form and of `collapsed`; the chat names it when it reports a morph done
   * (`chatMorphed`, `chatCollapsed`)
   */
  seq: number
  /**
   * The panel is just its message box, at the panel's bottom: there's no conversation yet, or
   * the user went back to their app once the agent was done. It grows to the full panel for a
   * reply, for anything waiting on the user, and when asked (`expandChat`).
   */
  collapsed: boolean
  /** The full panel's height, which the panel grows to from its message box */
  panelHeight: number
}

/**
 * Main → the chat page, on every frame while the chat turns from the floating card into the
 * sidebar or back (main/dock-morph.ts); null once it rests. Main moves and sizes the view, and
 * this says how to draw the chat in it for that frame: the view's size it's for (CSS px), the
 * margin on each side left for the shadow, how much of the card it still is (1 the card, 0 the
 * sidebar), and its corners.
 */
export interface ChatShape {
  width: number
  height: number
  inset: { top: number; right: number; bottom: number; left: number }
  /** 1 the floating card, 0 the sidebar: the shadow, the outer borders */
  card: number
  radius: number
  /** The sidebar's edge, whose border stays */
  side: 'left' | 'right'
  /** The sidebar's header holds the traffic lights (docked on the left, not full screen) */
  trafficLights: boolean
  /** The tab row shows beside the sidebar, so its header is that tall */
  tabRow: boolean
  /** From the message box alone: what's in it fades in as it grows */
  reveal: boolean
}

/**
 * Where the pointer pressed the floating chat to drag it: on screen, and in the chat view's
 * page. Together they say where the view was at that moment, even while it moves.
 */
export interface ChatGrab {
  screenX: number
  screenY: number
  clientX: number
  clientY: number
}

export function isChatGrab(value: unknown): value is ChatGrab {
  if (!value || typeof value !== 'object') return false
  const grab = value as Record<string, unknown>
  return ['screenX', 'screenY', 'clientX', 'clientY'].every(
    (key) => typeof grab[key] === 'number' && Number.isFinite(grab[key]),
  )
}

export interface SourceLocation {
  /** POSIX path relative to the project root */
  file: string
  line: number
  column?: number
  approximate: boolean
}

export interface ElementContext {
  /** Missing in history saved before areas could be picked */
  kind?: 'element'
  id: string
  url: string
  viewport: { width: number; height: number }
  tag: string
  selector: string
  text: string
  attributes: Record<string, string>
  outerHTML: string
  rect: Rect
  styles: Record<string, string>
  /** Innermost component first */
  componentStack: string[]
  source: SourceLocation | null
  /** PNG data URL of the element crop; stripped from turns to keep IPC payloads small */
  screenshot: string | null
  /**
   * Where `screenshot` was cropped and where the element was, in page coordinates (CSS
   * pixels), so a later image of the element can be framed the same way. Null without one.
   */
  crop?: { area: Rect; element: Rect } | null
}

/**
 * An area of the page the user dragged out in the preview: a screenshot of it, and the
 * element around all of it, to say where it is in the code.
 */
export interface RegionContext {
  kind: 'region'
  id: string
  url: string
  viewport: { width: number; height: number }
  /** The area in the viewport when it was captured (CSS pixels) */
  rect: Rect
  /** PNG data URL of the area; stripped from turns to keep IPC payloads small */
  screenshot: string | null
  /** The area in page coordinates (CSS pixels), as `area` and `element` alike */
  crop?: { area: Rect; element: Rect } | null
  /** The smallest element that contains the whole area; null when only the page does */
  container: {
    tag: string
    selector: string
    componentStack: string[]
    source: SourceLocation | null
  } | null
}

/** Something the user picked in the preview to talk about: an element, or an area. */
export type Picked = ElementContext | RegionContext

export const isRegion = (picked: Picked): picked is RegionContext => picked.kind === 'region'

/**
 * The pick a turn shows before and after its change: the first one with a crop to compare
 * against. The rest go to the agent the same way, they just aren't shown side by side.
 */
export const primaryPick = (selection: Picked[]) => selection.find((picked) => picked.crop)

/**
 * What the pick overlay draws over the preview while the user picks, in its own coordinates
 * (the preview view's): the element under the pointer and what's been picked so far.
 */
export interface PickOverlayState {
  /** The element under the pointer: what it is (`name`, h1), its component, and its size */
  hover: { rect: Rect; name: string; component: string | null; size: string } | null
  picked: { id: string; rect: Rect; kind: 'element' | 'region' }[]
  /** A pick is being read */
  busy: boolean
  /** How large the page is drawn: its CSS pixels times this are the overlay's */
  scale: number
  /** Counts the times picking started, so the overlay can greet each one */
  run: number
  /** The agent walking the user through the page (preview_point); never while picking */
  guide?: GuideOverlay | null
  /** The versions of an element to flip through (preview_variations); never while picking */
  variations?: VariationsBar | null
  /**
   * Picking just ended on a click: the overlay stays a moment, drawing nothing, for a second
   * click there, which makes it a double-click (an edit of the text) rather than a pick.
   */
  linger?: boolean
}

/** One version in a variation set (docs/variations.md); `original` is the code as it was. */
export interface Variant {
  id: string
  name: string
}

/** The variations bar, as the overlay draws it. */
export interface VariationsBar {
  /** Its top-left corner, in the overlay's coordinates */
  at: Point
  /** The widest it may be, to fit the preview: the name shortens first */
  room: number
  /** What each version is called, the original first: "Original", "1 of 3 · Bold", … */
  labels: string[]
  /** The one showing */
  index: number
  /** Asking before Discard undoes later messages too: how many */
  confirm: number | null
  /** Discarding */
  busy: boolean
  /** Why the last action didn't happen */
  error: string | null
}

/** What the user did in the variations bar. */
export const VARIATION_ACTIONS = [
  'previous',
  'next',
  'use',
  'discard',
  'confirm',
  'cancel',
] as const
export type VariationAction = (typeof VARIATION_ACTIONS)[number]

/** One step of the agent's walkthrough, as the overlay draws it (its coordinates). */
export interface GuideOverlay {
  /** The element pointed at; null for a caption on its own, or once the element is gone */
  rect: Rect | null
  caption: string | null
  /** Where the agent's pointer is; null before it first moves */
  cursor: Point | null
  /** How long the pointer's move there takes, in ms (main waits as long before the input) */
  glide: number
  /** Bumped by each click the agent makes, so the pointer shows it */
  clicks: number
  /** The last key the agent pressed, and how many it has, so the pointer shows each */
  key: { label: string; presses: number } | null
  /** Bumped by each step, so its caption comes in afresh */
  step: number
  /** The agent's turn is using this website: a click says so rather than reach the page */
  held: boolean
}

export interface Problem {
  id: string
  source: 'console' | 'server'
  message: string
  at: number
}

export type AgentStatus = 'idle' | 'starting' | 'ready' | 'working' | 'error'

/** One of an agent's selectable session settings (ACP `configOptions`, type `select`) */
export interface AgentSetting {
  /** The agent's own id for it, e.g. `model` or `reasoning_effort` */
  id: string
  /** The selected value */
  value: string
  /** Choices in the agent's order; `group` is set when the agent groups them (e.g. by provider) */
  options: { value: string; name: string; group: string | null }[]
}

/** The agent's model, and its effort (reasoning) level when it has one */
export interface ModelSettings {
  model: AgentSetting
  effort: AgentSetting | null
}

/** A slash command the agent offers (ACP `available_commands_update`), e.g. `compact` */
export interface AgentCommand {
  /** Without the slash. Codex's skills keep their `$` (`$name`), as Codex expects them typed. */
  name: string
  description: string
  /** What to type after the name, when it takes input */
  hint: string | null
  /**
   * A skill the agent loads when it's named in plain words (OpenCode, fx), found on disk by
   * Gui rather than offered by the agent: choosing it writes "Use the <name> skill".
   */
  skill?: true
}

/** A message sent while the agent was busy, waiting for its turn */
export interface QueuedMessage {
  id: string
  prompt: string
  /** What was picked when it was queued */
  context: Picked[]
  attachments: { name: string; thumbnail: string }[]
  recordings?: RecordingAttachment[]
  followUp?: FollowUp | null
  /** The text edit it asks for; editing the message's text leaves this as it is */
  textEdit?: TextEdit
}

/**
 * What a message sent while the agent works does: `steer` adds it to the reply under way
 * (the agent reads it at its next step), `queue` holds it for a turn of its own afterwards.
 */
export type FollowUpBehavior = 'steer' | 'queue'

/**
 * Text edited in place in the preview, which the agent is asked to change in the source.
 * Both were read from the page, so they are page data: shown to the user, and sent to the
 * agent fenced (`describeTextEdit`), never as part of a message's own text.
 */
export interface TextEdit {
  /** What the page said */
  before: string
  /** What it says now */
  after: string
}

/** An earlier turn a message follows up on, so the agent can pick that edit up again. */
export interface FollowUp {
  turnId: string
  /** The turn's number in the chat, from 1 */
  number: number
  /** What the user asked in it */
  prompt: string
}

/**
 * What paused the queue: Stop, an error, the agent declining or hitting its output limit,
 * the user not trusting the project, or the agent waiting to be set up (installed, signed in)
 */
export type QueuePauseReason =
  | 'stopped'
  | 'error'
  | 'refused'
  | 'limit'
  | 'untrusted'
  | 'setup'
  /** Left waiting when Gui last closed */
  | 'restored'

export interface ChatMeta {
  agentId: AgentId
  agentName: string
  /**
   * Messages waiting to run, oldest first. The next one starts when a turn finishes well;
   * otherwise the queue pauses until `sendQueuedNow`.
   */
  queue: QueuedMessage[]
  /** The queue has messages but won't start the next on its own (see `queuePauseReason`) */
  queuePaused: boolean
  /** Why the queue is paused; null when it isn't */
  queuePauseReason: QueuePauseReason | null
  /**
   * A message can go into the reply under way now: the agent takes messages mid-turn (ACP
   * `_session/steering`) and is working on a prompt. Otherwise a message sent while it
   * works waits in the queue.
   */
  canSteer: boolean
  /** What Enter does while the agent works (Settings); ⌘↩ does the other */
  followUp: FollowUpBehavior
  /**
   * Auto mode: Gui answers the agent's permission requests itself, so the agent edits
   * files and runs commands without asking. Commands aren't confined to the project. It
   * still asks when a request names a file outside the project, changes a sensitive file
   * (config, dependencies, scripts, dotfiles), or the agent flags it. On unless the user
   * turned it off for the project, which is remembered. Ask and Auto also set the agent's
   * own permission mode, for agents Gui knows it for (AgentDefinition.permissions).
   */
  autoApprove: boolean
  /**
   * Gui can't make this agent ask first (it offers no such mode Gui can switch to), so its
   * own settings decide what it asks, whatever `autoApprove` says. The Ask or Auto control
   * says so and can't be switched; whatever the agent does ask about, the user answers.
   */
  ownPermissions: boolean
  /**
   * What Auto mode lets the agent do has been said in full once, under the message box (it
   * shows until the first message sent with Auto on); since then, the Auto control's tooltip
   * says it.
   */
  autoNoteSeen: boolean
  /**
   * The model the next turn uses: the running session's, or before it starts, the agent's
   * list (from its last check) with the user's choice applied. Null when the agent has none.
   */
  models: ModelSettings | null
  status: AgentStatus
  error: string | null
  /** Technical detail behind `error` (exit code, stderr), shown on request */
  errorDetail: string | null
  /**
   * The agent's install and sign-in state, so the chat can set it up in place: while it
   * `needsSetup`, messages wait in the queue (paused for 'setup') and go out once it's ready
   */
  agent: AgentHealth | null
  /** The running session's own mode as the agent reports it (shown in the chat header) */
  modeName: string | null
  /**
   * The mode goes without saying, so the header leaves it out: the one Gui set for Ask or
   * Auto, which the composer's chip already says, or the agent's default (OpenCode's Build)
   */
  modeIsUsual: boolean
  /**
   * The slash commands the agent offers in this project: its running session's, else the
   * ones it reported last time (it only reports them once a session starts). A message
   * that starts with one of them is sent to the agent as just that command.
   */
  commands: AgentCommand[]
  /** What the user picked for the next message, in the order they picked it */
  selection: Picked[]
  /** Why the last element pick failed, shown until the next pick */
  selectionError: string | null
  /** The user is picking an element in the preview (the composer's Select is on) */
  selecting: boolean
  /** The preview shows the local app, so there's an element to pick */
  canSelect: boolean
  /** The chat is a canvas's: the agent makes frames rather than editing an app */
  canvas: boolean
  /** The canvas has no frames yet, so the canvas itself says what to ask for */
  canvasEmpty: boolean
  /** The window's sidebar, top to bottom, instead of floating over the preview */
  docked: boolean
  sidebarSide: 'left' | 'right'
  /** The window's traffic lights sit in the chat's header (the sidebar, outside full screen) */
  trafficLights: boolean
  /**
   * Docked beside the window's tab row: the header is as tall as the tab row and the bar
   * under it as tall as the toolbar, so their edges line up across the window
   */
  tabRow: boolean
  /** Popped out into a window of its own, which it fills */
  popped: boolean
  /** Turns the pending redo would bring back; empty when there's nothing to redo */
  redoTurnIds: string[]
  /** The latest turn, failed, which Retry sends again with what it carried; null otherwise */
  retryTurnId: string | null
  /**
   * The chat a new chat just took the place of, archived, so the empty chat can offer it
   * back; null once a message is sent, or when nothing was archived
   */
  archived: { id: string; agentName: string } | null
  /** Current errors in the preview and dev server */
  problems: Problem[]
}

export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export interface PermissionChoice {
  optionId: string
  name: string
  kind: string
}

/**
 * Where a subagent's work stands: working, waiting on a question to the user, or ended (its
 * work done, failed, or stopped). A parent can hand it more work, so an ended one can run again.
 */
export type SubagentStatus = 'running' | 'waiting' | 'done' | 'failed' | 'stopped'

/**
 * Items of a turn. `subagent` is the session id of the subagent an item belongs to (its own
 * words and steps, a subagent it started, a question it asks); absent for the agent's own.
 * The list stays flat: the transcript groups a subagent's items under its `subagent` item.
 */
export type TurnItem = (
  | { kind: 'text'; id: string; text: string }
  | { kind: 'thought'; id: string; text: string }
  | {
      kind: 'tool'
      id: string
      title: string
      toolKind: string
      status: ToolStatus
      locations: string[]
      /** When Gui first heard of it, and when it completed or failed; missing in older history */
      startedAt?: number
      endedAt?: number | null
    }
  | { kind: 'plan'; id: string; entries: { content: string; status: string }[] }
  | {
      /** A subagent the agent started, where it started it; `id` is its session id */
      kind: 'subagent'
      id: string
      /** The agent's name for it ("Explore", "Check the styles") */
      title: string
      /** Its role, when the agent says more than the title */
      description: string | null
      status: SubagentStatus
      /** Why it failed, in the agent's words */
      error: string | null
      /** What the agent asked of it, and what it answered */
      prompt: string | null
      answer: string | null
      /** The agent lets the user stop it alone */
      canStop: boolean
      startedAt: number
      endedAt: number | null
    }
  | {
      kind: 'permission'
      id: string
      /** The step it asks about, when the agent said which; missing in older history */
      toolCallId?: string
      /** The agent's own description of the action, paths relative to the project */
      title: string
      /** ACP tool kind (edit, delete, move, execute, fetch, read, …) */
      toolKind: string
      /** Files the action touches, relative to the project */
      locations: string[]
      /** It touches files that change how the project builds or runs (config, deps, scripts) */
      sensitive: boolean
      /** The edit it would make, when the agent sent it (shared/edit-diff.ts) */
      diff?: EditDiff[]
      options: PermissionChoice[]
      resolved: string | null
    }
  | {
      kind: 'notice'
      id: string
      text: string
      tone: 'info' | 'error'
      /** Technical detail, shown on request */
      detail?: string
    }
  | {
      /**
       * A message the user sent into the reply under way ("Send now"): the agent read it
       * between steps and went on with it, in the same turn.
       */
      kind: 'steer'
      id: string
      prompt: string
      /** What was picked when it was sent */
      context: Picked[]
      attachments?: { name: string; thumbnail: string }[]
      followUp?: FollowUp
      textEdit?: TextEdit
    }
) & { subagent?: string }

export type SubagentItem = Extract<TurnItem, { kind: 'subagent' }>

/** One file of an edit an agent asks to make: the lines it removes and adds, in order. */
export interface EditDiff {
  /** Relative to the project, or in full outside it */
  path: string
  lines: { sign: '+' | '-'; text: string }[]
  /** Changed lines past the card's cap, not kept */
  more: number
}

export interface FileChange {
  path: string
  status: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
}

export type TurnStatus = 'running' | 'done' | 'cancelled' | 'error'

/**
 * How a turn's before and after images line up when the element changed size: the after
 * image shows this whole area (CSS pixels) and the before image covers `before` inside
 * it. Without one, both images frame the element the same way and show at the same size.
 */
export interface PreviewFrame {
  width: number
  height: number
  before: Rect
}

export interface Turn {
  id: string
  index: number
  prompt: string
  /** What the user picked for it, in the order they picked it */
  context: Picked[]
  items: TurnItem[]
  status: TurnStatus
  error: string | null
  /** Technical detail behind `error`, shown on request */
  errorDetail?: string | null
  /**
   * Small JPEG data URLs of the picked element before the turn and after hot reload.
   * Kept in memory only (not in saved history); either may be missing.
   */
  preview?: {
    before: string | null
    after: string | null
    size?: { width: number; height: number }
    frame?: PreviewFrame | null
    /** The page's color around the element, behind the images where they leave their frames */
    fill?: string | null
  } | null
  startedAt: number
  endedAt: number | null
  changes: FileChange[] | null
  /** The turn was interrupted (e.g. the app quit) before its changes were recorded, but it can still be undone */
  changesUnknown?: boolean
  /** Reference images the user attached; thumbnails only (the full images went to the agent) */
  attachments?: { name: string; thumbnail: string }[]
  recordings?: RecordingAttachment[]
  /** The earlier turn this message follows up on */
  followUp?: FollowUp | null
  /** The text edit from the preview this message asks for; `prompt` is Gui's own words then */
  textEdit?: TextEdit
  /**
   * Gui wrote `textEdit` into this file itself (relative to the project): the user's own
   * edit, with no agent behind it. The chat shows it in one line, with Undo.
   */
  editedFile?: string
  reverted: boolean
}

export interface ChatSnapshot {
  /** Last ordered update included for each turn; absent IDs have not emitted yet. */
  revisions?: Record<string, number>
  meta: ChatMeta
  turns: Turn[]
  /** How the floating chat is drawn; from the window, when it asks (`getChat`) */
  float?: ChatFloat
  /** Whether anyone can see the chat page now (`onChatSeen`); when it asks (`getChat`) */
  seen?: boolean
}

/** A preview clip saved locally, attached to a draft or kept with a turn. */
export interface RecordingAttachment {
  id: string
  name: string
  url: string
  thumbnail: string
  durationMs: number
  width: number
  height: number
  frameCount: number
  /** The user talked over the clip; absent on silent ones */
  narration?: RecordingNarration
}

/** Where the pointer is over the preview as it's recorded, for the recorder to draw. */
export interface RecordingCursor {
  /** The recording it's for */
  id: string
  /** Fractions of the preview's width and height */
  x: number
  y: number
  down: boolean
  /** Over the preview, rather than where it was last seen there */
  inside: boolean
}

/** A narrated clip's transcript: being made, made, or why there isn't one. */
export interface RecordingNarration {
  status: 'transcribing' | 'done' | 'failed'
  /** What was said, as plain text (done) */
  text?: string
  /** Why there's no transcript (failed); the clip still has its sound */
  error?: string
  /** WebVTT captions for the player (done) */
  captions?: string
}

/** An image the user pasted or dropped into the composer, already downscaled */
export interface ImageAttachment {
  name: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  /** Base64, no data: prefix */
  data: string
  /** Small data URL shown in the transcript and kept in history */
  thumbnail: string
}

/**
 * A state of the project's files saved in the Versions sheet Gui used to have: one the user
 * named, or the one saved just before restoring a version. Nothing offers them now; chats
 * keep them as saved, so pruning keeps their checkpoints.
 */
export interface Version {
  id: string
  /** Checkpoint commit in the shadow repo */
  sha: string
  kind: 'named' | 'safety'
  /** The user's name, or what the restore was making way for */
  name: string
  createdAt: number
  /** Files this version changed from the one before it; null when that isn't known */
  changes: FileChange[] | null
}

/** An agent the user added in Settings (stored in agents.json). */
export interface CustomAgentEntry {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

export type StorageKind = 'chats' | 'checkpoints' | 'previewData'

/** Bytes on disk per kind; null while it's being measured. */
export type StorageUsage = Record<StorageKind, number | null>

export type SettingsSection = 'agents' | 'projects' | 'github' | 'storage' | 'account'

export interface SettingsState {
  /** Section requested when this Settings window opened. */
  initialSection?: SettingsSection

  /** Every known agent, enabled or not */
  agents: AgentHealth[]
  /** The agent new windows start with */
  defaultAgentId: AgentId
  /** Whether new chats start docked to the side */
  chatSidebar: boolean
  chatSidebarSide: 'left' | 'right'
  customAgents: CustomAgentEntry[]
  /** Why agents.json can't be read; custom agents can't be edited in Settings while set */
  customAgentsError: string | null
  /** Projects whose dev script runs without asking */
  trustedProjects: string[]
  /** Projects started with a command set in Gui rather than the one it detected */
  startCommands: { root: string; start: StartCommand }[]
  recentProjects: RecentProject[]
  storage: StorageUsage
  /** Project roots open in a tab of any window; clearing storage keeps their data */
  openProjects: string[]
  /** The user's home folder, so paths can show it as ~ */
  home: string
  /** Gui sends a report when it fails */
  crashReports: boolean
  /** What a message sent while the agent works does (see ChatMeta.followUp) */
  followUp: FollowUpBehavior
}
