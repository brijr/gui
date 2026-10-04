import type {
  AgentId,
  ChatMeta,
  ChatSnapshot,
  CustomAgentEntry,
  ImageAttachment,
  PanelCorner,
  PanelEdge,
  Rect,
  SettingsSection,
  SettingsState,
  ShipInfo,
  ShipRequest,
  ShipResult,
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
  installAgent: 'agents:install',
  shipInfo: 'ship:info',
  takeScreenshot: 'preview:screenshot',
  ship: 'ship:run',
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
  stopSelecting: 'preview:select-stop',
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
  resizeChat: 'chat:resize',
  endResizeChat: 'chat:resize-end',
  endDragChat: 'chat:drag-end',
  removeQueued: 'chat:queue-remove',
  sendQueuedNow: 'chat:queue-send',
  setAutoApprove: 'chat:auto-approve',
  setAgentSetting: 'chat:agent-setting',
  newTab: 'tabs:new',
  selectTab: 'tabs:select',
  closeTab: 'tabs:close',
  moveTab: 'tabs:move',
  showTabMenu: 'tabs:menu',
  chooseApp: 'setup:choose-app',
  installDependencies: 'setup:install',
  createEnvFile: 'setup:create-env',
  openEnvFile: 'setup:open-env',
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
  chatAttach: 'chat:attach',
  chatBubble: 'chat:bubble',
  settings: 'settings',
  settingsSection: 'settings:section',
} as const

export type Unsubscribe = () => void

export interface GuiApi {
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
  /**
   * Claude Code and Codex: downloads the CLI (progress and errors arrive through
   * `WindowState.agents`). Other agents: opens their official install page.
   */
  installAgent(agentId: AgentId): Promise<void>

  /**
   * Opens a start-screen tab in this window and shows it. Each tab (`WindowState.tabs`) is a
   * project with its own preview, chat and dev server.
   */
  newTab(): void
  selectTab(id: string): void
  /** Closes the tab, stopping its agent and dev server; the last one closes the window */
  closeTab(id: string): void
  /** Moves the tab to `index` in the strip (drag to reorder) */
  moveTab(id: string, index: number): void
  /** The tab's context menu: close it, close the others, move it to a new window */
  showTabMenu(id: string): void

  /** Project setup (`WindowState.setup`): pick the monorepo app to preview */
  chooseApp(dir: string): void
  /** Installs (or retries installing) the project's dependencies */
  installDependencies(): void
  /** Copies the env example to `setup.env.target`, then opens it */
  createEnvFile(): void
  openEnvFile(): void

  navigate(url: string): void
  back(): void
  forward(): void
  reload(): void
  setViewport(viewport: Viewport): void
  toggleSelect(): void
  /** Ends element picking (the chat bubble's click) */
  stopSelecting(): void
  setCanvasRect(rect: Rect): void
  toggleChat(): void
  setLogsOpen(open: boolean): void
  resizeLogs(cols: number, rows: number): void

  getChat(): Promise<ChatSnapshot>
  onChatMeta(cb: (meta: ChatMeta) => void): Unsubscribe
  onChatTurn(cb: (turn: Turn) => void): Unsubscribe
  onChatReset(cb: (snapshot: ChatSnapshot) => void): Unsubscribe
  onChatFocus(cb: () => void): Unsubscribe
  /**
   * Where the floating panel is drawn as a bubble, its anchored corner, or null when it isn't:
   * while the user picks an element, the view shrinks to it so it doesn't cover the page.
   */
  onChatBubble(cb: (bubble: PanelCorner | null) => void): Unsubscribe
  /**
   * Starts a turn, or queues the message while the agent is busy (`meta.queue`). Resolves
   * false only when it wasn't accepted (e.g. empty, or no project).
   */
  send(text: string, images?: ImageAttachment[]): Promise<boolean>
  /** Drops a queued message */
  removeQueued(id: string): void
  /** Runs the next queued message now (when idle), resuming a paused queue */
  sendQueuedNow(): void
  /** Auto mode on or off (see `ChatMeta.autoApprove`) */
  setAutoApprove(on: boolean): void
  /**
   * The user's pick for one of `ChatMeta.models` (its `model` or `effort` setting, by id).
   * Ignored unless `value` is one of that setting's current options.
   */
  setAgentSetting(settingId: string, value: string): void
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

  /**
   * Shows the screenshot menu (copy, copy full page, save, attach to chat) for the
   * preview; resolves with what was done, or null when dismissed or nothing is loaded.
   */
  takeScreenshot(): Promise<'copied' | 'saved' | 'attached' | null>
  /**
   * Resizes the chat panel by a pointer delta from one of its edges or corners: the dragged
   * edges move and the opposite ones stay put. Docked, only its left edge resizes it.
   */
  resizeChat(edge: PanelEdge, dx: number, dy: number): void
  endResizeChat(): void
  /** An image main wants added to the composer (e.g. a screenshot of the preview) */
  onChatAttach(cb: (image: ImageAttachment) => void): Unsubscribe

  /** Null without a project */
  getShipInfo(): Promise<ShipInfo | null>
  /** Commits, pushes and opens the PR; rejects with a readable message */
  ship(request: ShipRequest): Promise<ShipResult>
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
