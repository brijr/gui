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
export interface ProjectSetup {
  /** Set when a monorepo has several apps and none is chosen yet (see `chooseApp`) */
  apps: WorkspaceApp[] | null
  /** `installing` streams into the logs; `failed` offers a retry */
  dependencies: 'ok' | 'missing' | 'installing' | 'failed'
  /**
   * An env example file exists but no local env file does. `target` is the file
   * `createEnvFile` writes (gitignored), `created` once it has.
   */
  env: { example: string; target: string; created: boolean } | null
}

export interface RecentProject {
  root: string
  name: string
  openedAt: number
  /** Its chat's last message and when it was sent; absent with no chat (or in the saved list) */
  chat?: { prompt: string; at: number } | null
}

export type DevServerStatus = 'idle' | 'starting' | 'running' | 'exited'

export interface DevServerState {
  status: DevServerStatus
  command: string | null
  url: string | null
  exitCode: number | null
  lastLine: string
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

export type Viewport = (typeof VIEWPORTS)[number]['id']

export function isViewport(value: unknown): value is Viewport {
  return VIEWPORTS.some((viewport) => viewport.id === value)
}

export function viewportSpec(id: Viewport): ViewportSpec {
  return VIEWPORTS.find((viewport) => viewport.id === id) ?? VIEWPORTS[0]
}

/**
 * The line above a device frame: its name, then "· 1440 × 900", and "· 80%" when it's drawn
 * smaller (floored, so a frame drawn even slightly smaller never reads 100%).
 */
export function frameLabel(id: Viewport, scale: number) {
  const { name, size } = viewportSpec(id)
  const percent = Math.floor(scale * 100)
  const detail = `${size ? ` · ${size.width} × ${size.height}` : ''}${percent < 100 ? ` · ${percent}%` : ''}`
  return { name, detail }
}

/** Its key with ⌘ (the View menu's shortcut): 1 for the first viewport, and so on. */
export function viewportKey(id: Viewport) {
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

export interface PreviewState {
  url: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
  viewport: Viewport
  /** The device frame the preview is shown in; null for Desktop, which fills the canvas */
  frame: ViewportFrame | null
  /**
   * Desktop's page zoom, 1 at 100% (View → Zoom In, Zoom Out, Actual Size). A device frame's
   * zoom is its `frame.scale`.
   */
  zoom: number
  selecting: boolean
  /** Element picking is only allowed on the local app, not off-site pages */
  selectable: boolean
  visible: boolean
}

/**
 * A change that moves or resizes the preview, which morphs into its new layout rather than
 * jumping there (main/preview-morph.ts, renderer app/layout-morph.ts): another viewport, a
 * zoom step, the drawer opening or closing, the chat docking (or a docked chat showing or
 * hiding), focus mode.
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
 * Main → the chrome, one morph (`id`) at a time: a change is coming (`pending`), the preview
 * as it was (`snapshot`, a JPEG of the view), where it's going (`target`, again for every
 * change before it lands, numbered `seq`), the preview as it will be there (`after`, null if
 * it couldn't be captured), and the live view back in its place (`end`).
 */
export type MorphEvent =
  | { type: 'pending'; id: number; kind: MorphKind }
  | {
      type: 'snapshot'
      id: number
      kind: MorphKind
      image: Uint8Array
      from: MorphPlacement
      /** Reduce motion: nothing moves; the snapshot fades out where the preview left */
      reduced: boolean
    }
  | { type: 'target'; id: number; seq: number; kind: MorphKind; to: MorphPlacement }
  | { type: 'after'; id: number; seq: number; image: Uint8Array | null }
  | { type: 'end'; id: number }

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
  preview: PreviewState
  agentId: AgentId
  chatVisible: boolean
  /**
   * The chat sidebar's width while it shows, down the window's left side from top to bottom;
   * the chrome (tab row, toolbar, canvas, drawer) starts to its right. 0 otherwise.
   */
  sidebarWidth: number
  drawer: DrawerState
  /** Null until read, so the start screen doesn't draw without it and then jump */
  recent: RecentProject[] | null
  /** The user's home folder, so paths can show it as ~ */
  home: string
  agents: AgentHealth[]
  setup: ProjectSetup | null
  /** The window's tabs, in order; the strip shows once there are two or more */
  tabs: TabInfo[]
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

/** The floating chat panel's anchored corner, which stays put; its bubble and pill sit there too */
export interface PanelCorner {
  x: 'left' | 'right'
  y: 'top' | 'bottom'
}

/**
 * What the floating chat is drawn as: the panel, the pill while minimized, or the bubble while
 * the user picks an element. Each sits at the anchored corner.
 */
export type ChatForm = 'panel' | 'pill' | 'bubble'

export const CHAT_FORMS: readonly ChatForm[] = ['panel', 'pill', 'bubble']

export function isChatForm(value: unknown): value is ChatForm {
  return CHAT_FORMS.some((form) => form === value)
}

/** The floating chat's form and the corner it's anchored by, as main lays its view out. */
export interface ChatFloat {
  form: ChatForm
  corner: PanelCorner
  /** Counts changes of form; the chat names it when it reports a morph done (`chatMorphed`) */
  seq: number
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
  hover: { rect: Rect; name: string; size: string } | null
  picked: { id: string; rect: Rect; kind: 'element' | 'region' }[]
  /** A pick is being read */
  busy: boolean
  /** How large the page is drawn: its CSS pixels times this are the overlay's */
  scale: number
  /** Counts the times picking started, so the overlay can greet each one */
  run: number
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
  /** Without the slash */
  name: string
  description: string
  /** What to type after the name, when it takes input */
  hint: string | null
}

/** A message sent while the agent was busy, waiting for its turn */
export interface QueuedMessage {
  id: string
  prompt: string
  /** What was picked when it was queued */
  context: Picked[]
  attachments: { name: string; thumbnail: string }[]
  recordings?: RecordingAttachment[]
}

/**
 * What paused the queue: Stop, an error, the agent declining or hitting its output limit,
 * or the user not trusting the project
 */
export type QueuePauseReason = 'stopped' | 'error' | 'refused' | 'limit' | 'untrusted'

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
   * Auto mode: Gui answers the agent's permission requests itself, so the agent edits
   * files and runs commands without asking. Commands aren't confined to the project. It
   * still asks when a request names a file outside the project, changes a sensitive file
   * (config, dependencies, scripts, dotfiles), or the agent flags it. On unless the user
   * turned it off for the project, which is remembered. Ask and Auto also set the agent's
   * own permission mode, for agents Gui knows it for (AgentDefinition.permissions).
   */
  autoApprove: boolean
  /**
   * The model the next turn uses: the running session's, or before it starts, the agent's
   * list (from its last check) with the user's choice applied. Null when the agent has none.
   */
  models: ModelSettings | null
  status: AgentStatus
  error: string | null
  /** Technical detail behind `error` (exit code, stderr), shown on request */
  errorDetail: string | null
  /** The running session's own mode as the agent reports it (shown in the chat header) */
  modeName: string | null
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
  minimized: boolean
  /** The window's left sidebar, top to bottom, instead of floating over the preview */
  docked: boolean
  /** The window's traffic lights sit in the chat's header (the sidebar, outside full screen) */
  trafficLights: boolean
  /** Popped out into a window of its own, which it fills */
  popped: boolean
  /** Turns the pending redo would bring back; empty when there's nothing to redo */
  redoTurnIds: string[]
  /** Current errors in the preview and dev server */
  problems: Problem[]
}

export type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export interface PermissionChoice {
  optionId: string
  name: string
  kind: string
}

export type TurnItem =
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
      kind: 'permission'
      id: string
      /** The agent's own description of the action, paths relative to the project */
      title: string
      /** ACP tool kind (edit, delete, move, execute, fetch, read, …) */
      toolKind: string
      /** Files the action touches, relative to the project */
      locations: string[]
      /** It touches files that change how the project builds or runs (config, deps, scripts) */
      sensitive: boolean
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
  reverted: boolean
}

export interface ChatSnapshot {
  meta: ChatMeta
  turns: Turn[]
  /** How the floating chat is drawn; from the window, when it asks (`getChat`) */
  float?: ChatFloat
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

export interface ShipFile {
  /** POSIX path relative to the repository root */
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
}

/** What "Create pull request" would do with the project's uncommitted changes */
export interface ShipInfo {
  /** Why it can't ship (not a git repo, nothing changed, agent busy); null when it can */
  blocked: string | null
  /** Current branch; null when detached */
  branch: string | null
  /** On the repository's default branch, so shipping starts a new branch */
  onDefaultBranch: boolean
  files: ShipFile[]
  /** Changed files left out because they may hold secrets (e.g. `.env.local`) */
  skipped: string[]
  /** Where the branch is pushed; null without a remote (the commit stays local) */
  remote: { host: 'github' | 'gitlab' | 'other'; repo: string } | null
  suggestion: { branch: string; title: string; body: string }
}

export interface ShipRequest {
  /** Branch to commit on; created from the current one when it differs */
  branch: string
  title: string
  body: string
}

export interface ShipResult {
  branch: string
  /** Short commit sha */
  commit: string
  /**
   * `created`: the PR exists (`url`). `compare`: pushed, and `url` opens the host's
   * new-PR page to finish in the browser. `pushed`: pushed to a host Gui can't link.
   * `committed`: no remote, committed locally only.
   */
  outcome: 'created' | 'compare' | 'pushed' | 'committed'
  url: string | null
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

export type SettingsSection = 'agents' | 'chat' | 'projects' | 'storage'

export interface SettingsState {
  /** Every known agent, enabled or not */
  agents: AgentHealth[]
  /** The agent new windows start with */
  defaultAgentId: AgentId
  /** Whether new chats start docked to the side */
  chatSidebar: boolean
  customAgents: CustomAgentEntry[]
  /** Why agents.json can't be read; custom agents can't be edited in Settings while set */
  customAgentsError: string | null
  /** Projects whose dev script runs without asking */
  trustedProjects: string[]
  recentProjects: RecentProject[]
  storage: StorageUsage
  /** Project roots open in a tab of any window; clearing storage keeps their data */
  openProjects: string[]
  /** The user's home folder, so paths can show it as ~ */
  home: string
}
