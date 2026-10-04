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

export type Viewport = 'desktop' | 'tablet' | 'mobile'

export interface PreviewState {
  url: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error: string | null
  viewport: Viewport
  selecting: boolean
  /** Element picking is only allowed on the local app, not off-site pages */
  selectable: boolean
  visible: boolean
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
  preview: PreviewState
  agentId: AgentId
  chatVisible: boolean
  logsOpen: boolean
  recent: RecentProject[]
  /** The user's home folder, so paths can show it as ~ */
  home: string
  agents: AgentHealth[]
  setup: ProjectSetup | null
  /** The window's tabs, in order; the strip shows once there are two or more */
  tabs: TabInfo[]
  /** Id of the tab this state is for, the one the window shows */
  activeTab: string
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
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

export interface SourceLocation {
  /** POSIX path relative to the project root */
  file: string
  line: number
  column?: number
  approximate: boolean
}

export interface ElementContext {
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

/** A message sent while the agent was busy, waiting for its turn */
export interface QueuedMessage {
  id: string
  prompt: string
  /** The element that was picked when it was queued */
  context: ElementContext | null
  attachments: { name: string; thumbnail: string }[]
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
  selection: ElementContext | null
  /** Why the last element pick failed, shown until the next pick */
  selectionError: string | null
  /** The user is picking an element in the preview (the composer's Select is on) */
  selecting: boolean
  minimized: boolean
  /** Docked to the right edge of the canvas instead of floating over the preview */
  docked: boolean
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
  context: ElementContext | null
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
  reverted: boolean
}

export interface ChatSnapshot {
  meta: ChatMeta
  turns: Turn[]
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
  chatDocked: boolean
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
