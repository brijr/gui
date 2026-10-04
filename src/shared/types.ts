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
  { id: 'auggie', name: 'Auggie' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'gemini', name: 'Gemini CLI' },
  { id: 'copilot', name: 'GitHub Copilot' },
  { id: 'goose', name: 'goose' },
  { id: 'grok', name: 'Grok Build' },
  { id: 'kiro', name: 'Kiro' },
  { id: 'vibe', name: 'Mistral Vibe' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'qwen', name: 'Qwen Code' },
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

export interface AgentHealth {
  id: AgentId
  name: string
  status: 'unknown' | 'not-installed' | 'checking' | 'signing-in' | 'ready' | 'signed-out' | 'error'
  message: string | null
  /** The CLI Grat runs for this agent; null for the bundled adapters */
  command: string | null
  /** A sign-in flow Grat can start for this agent, when it offers one */
  signIn: { methodId: string; label: string } | null
}

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'

export interface ProjectInfo {
  root: string
  name: string
  packageManager: PackageManager
  devCommand: string | null
  /** Body of the package.json script devCommand runs */
  devScript: string | null
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

export interface WindowState {
  project: ProjectInfo | null
  devServer: DevServerState
  preview: PreviewState
  agentId: AgentId
  chatVisible: boolean
  logsOpen: boolean
  recent: RecentProject[]
  agents: AgentHealth[]
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
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
}

export interface Problem {
  id: string
  source: 'console' | 'server'
  message: string
  at: number
}

export type AgentStatus = 'idle' | 'starting' | 'ready' | 'working' | 'error'

export interface ChatMeta {
  agentId: AgentId
  agentName: string
  status: AgentStatus
  error: string | null
  modeName: string | null
  selection: ElementContext | null
  /** Why the last element pick failed, shown until the next pick */
  selectionError: string | null
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
    }
  | { kind: 'plan'; id: string; entries: { content: string; status: string }[] }
  | {
      kind: 'permission'
      id: string
      title: string
      options: PermissionChoice[]
      resolved: string | null
    }
  | { kind: 'notice'; id: string; text: string; tone: 'info' | 'error' }

export interface FileChange {
  path: string
  status: 'added' | 'modified' | 'deleted'
  additions: number
  deletions: number
}

export type TurnStatus = 'running' | 'done' | 'cancelled' | 'error'

export interface Turn {
  id: string
  index: number
  prompt: string
  context: ElementContext | null
  items: TurnItem[]
  status: TurnStatus
  error: string | null
  startedAt: number
  endedAt: number | null
  changes: FileChange[] | null
  reverted: boolean
}

export interface ChatSnapshot {
  meta: ChatMeta
  turns: Turn[]
}
