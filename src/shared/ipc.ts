import type {
  AgentId,
  ChatMeta,
  ChatSnapshot,
  CustomAgentEntry,
  Rect,
  SettingsSection,
  SettingsState,
  StorageKind,
  Turn,
  Viewport,
  WindowState,
} from './types'

/** Renderer → main, request/response */
export const Invoke = {
  getState: 'state:get',
  getLogs: 'logs:get',
  getChat: 'chat:get',
  openProject: 'project:open',
  openRecent: 'project:open-recent',
  send: 'chat:send',
  restoreTurn: 'chat:restore',
  redo: 'chat:redo',
  fixProblems: 'chat:fix-problems',
  signIn: 'agents:sign-in',
  getSettings: 'settings:get',
  saveCustomAgent: 'settings:save-custom-agent',
  deleteCustomAgent: 'settings:delete-custom-agent',
  untrustProject: 'settings:untrust-project',
  clearRecent: 'settings:clear-recent',
  clearStorage: 'settings:clear-storage',
} as const

/** Renderer → main, fire and forget */
export const Send = {
  devServerStart: 'devserver:start',
  devServerStop: 'devserver:stop',
  devServerRestart: 'devserver:restart',
  showDevServerMenu: 'menu:devserver',
  showAgentMenu: 'menu:agent',
  showProjectMenu: 'menu:project',
  setAgent: 'agent:set',
  checkAgents: 'agents:check',
  navigate: 'preview:navigate',
  back: 'preview:back',
  forward: 'preview:forward',
  reload: 'preview:reload',
  setViewport: 'preview:viewport',
  toggleSelect: 'preview:select',
  setCanvasRect: 'layout:canvas',
  toggleChat: 'chat:toggle',
  setLogsOpen: 'logs:open',
  resizeLogs: 'logs:resize',
  cancel: 'chat:cancel',
  respondPermission: 'chat:permission',
  newSession: 'chat:new',
  clearSelection: 'chat:clear-selection',
  setMinimized: 'chat:minimize',
  toggleDock: 'chat:dock',
  dragChat: 'chat:drag',
  endDragChat: 'chat:drag-end',
  openSettings: 'settings:open',
  setAgentEnabled: 'settings:agent-enabled',
  setDefaultAgent: 'settings:default-agent',
  setChatDocked: 'settings:chat-docked',
  openCustomAgentsFile: 'settings:open-agents-file',
} as const

/** Main → renderer */
export const Events = {
  state: 'state',
  logs: 'logs',
  chatMeta: 'chat:meta',
  chatTurn: 'chat:turn',
  chatReset: 'chat:reset',
  chatFocus: 'chat:focus',
  settings: 'settings',
  settingsSection: 'settings:section',
} as const

export type Unsubscribe = () => void

export interface GratApi {
  getState(): Promise<WindowState>
  onState(cb: (state: WindowState) => void): Unsubscribe
  getLogs(): Promise<string>
  onLogs(cb: (chunk: string) => void): Unsubscribe

  openProject(): Promise<void>
  openRecent(root: string): Promise<void>
  startDevServer(): void
  stopDevServer(): void
  restartDevServer(): void
  showDevServerMenu(): void
  showAgentMenu(): void
  showProjectMenu(): void
  setAgent(agentId: AgentId): void
  checkAgents(): void
  /** Runs the agent's sign-in flow (opens the browser) and re-checks it */
  signIn(agentId: AgentId): Promise<void>

  navigate(url: string): void
  back(): void
  forward(): void
  reload(): void
  setViewport(viewport: Viewport): void
  toggleSelect(): void
  setCanvasRect(rect: Rect): void
  toggleChat(): void
  setLogsOpen(open: boolean): void
  resizeLogs(cols: number, rows: number): void

  getChat(): Promise<ChatSnapshot>
  onChatMeta(cb: (meta: ChatMeta) => void): Unsubscribe
  onChatTurn(cb: (turn: Turn) => void): Unsubscribe
  onChatReset(cb: (snapshot: ChatSnapshot) => void): Unsubscribe
  onChatFocus(cb: () => void): Unsubscribe
  /** Resolves false when the chat is busy and the message wasn't accepted */
  send(text: string): Promise<boolean>
  cancel(): void
  respondPermission(turnId: string, itemId: string, optionId: string | null): void
  restoreTurn(turnId: string): Promise<void>
  redo(): Promise<void>
  newSession(): void
  clearSelection(): void
  setMinimized(minimized: boolean): void
  toggleDock(): void
  /** Sends the current preview errors to the agent; false if busy or nothing to fix */
  fixProblems(): Promise<boolean>
  dragChat(dx: number, dy: number): void
  endDragChat(): void

  /** Opens (or focuses) the Settings window, optionally at a section */
  openSettings(section?: SettingsSection): void
  getSettings(): Promise<SettingsState>
  onSettings(cb: (settings: SettingsState) => void): Unsubscribe
  /** Settings was asked to show a section (e.g. opened from the agent menu) */
  onSettingsSection(cb: (section: SettingsSection) => void): Unsubscribe
  setAgentEnabled(agentId: AgentId, enabled: boolean): void
  setDefaultAgent(agentId: AgentId): void
  setChatDocked(docked: boolean): void
  /** Adds or replaces a custom agent; rejects with a message when the entry is invalid */
  saveCustomAgent(originalName: string | null, entry: CustomAgentEntry): Promise<void>
  deleteCustomAgent(name: string): Promise<void>
  /** Opens agents.json in the user's editor */
  openCustomAgentsFile(): void
  /** The project's dev script will ask before running again */
  untrustProject(root: string): Promise<void>
  clearRecent(): Promise<void>
  /** Asks to confirm, then clears; false when the user cancelled */
  clearStorage(kind: StorageKind): Promise<boolean>
}
