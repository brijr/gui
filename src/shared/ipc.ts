import type { AgentId, ChatMeta, ChatSnapshot, Rect, Turn, Viewport, WindowState } from './types'

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
  dragChat: 'chat:drag',
  endDragChat: 'chat:drag-end',
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
  dragChat(dx: number, dy: number): void
  endDragChat(): void
}
