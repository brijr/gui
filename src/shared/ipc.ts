import type {
  AgentId,
  ChatMeta,
  ChatSnapshot,
  ImageAttachment,
  Rect,
  ShipInfo,
  ShipRequest,
  ShipResult,
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
  ship: 'ship:run',
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
  chooseApp: 'setup:choose-app',
  installDependencies: 'setup:install',
  createEnvFile: 'setup:create-env',
  openEnvFile: 'setup:open-env',
} as const

/** Main → renderer */
export const Events = {
  state: 'state',
  logs: 'logs',
  chatMeta: 'chat:meta',
  chatTurn: 'chat:turn',
  chatReset: 'chat:reset',
  chatFocus: 'chat:focus',
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
  /** Downloads the agent's CLI; progress and errors arrive through `WindowState.agents` */
  installAgent(agentId: AgentId): Promise<void>

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
  send(text: string, images?: ImageAttachment[]): Promise<boolean>
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

  /** Null without a project */
  getShipInfo(): Promise<ShipInfo | null>
  /** Commits, pushes and opens the PR; rejects with a readable message */
  ship(request: ShipRequest): Promise<ShipResult>
}
