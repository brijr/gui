export type AgentId = 'claude' | 'codex'

export interface AgentInfo {
  id: AgentId
  name: string
}

export const AGENTS: readonly AgentInfo[] = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'codex', name: 'Codex' },
]

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

export type AgentStatus = 'idle' | 'starting' | 'ready' | 'working' | 'error'

export interface ChatMeta {
  agentId: AgentId
  agentName: string
  status: AgentStatus
  error: string | null
  modeName: string | null
  selection: ElementContext | null
  minimized: boolean
  canRedo: boolean
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
