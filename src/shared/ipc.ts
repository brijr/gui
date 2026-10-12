import type { AccountProfile, AccountState } from './account'
import type { BoardCamera, FramePreset } from './board'
import type { ChatTurnUpdate } from './chat-transport'
import type { GitHubRepository, GitHubState } from './github'
import type { SymbolImages } from './symbols'
import type {
  AgentId,
  ChatFloat,
  ChatForm,
  ChatGrab,
  ChatMeta,
  ChatSnapshot,
  ChatSummary,
  CustomAgentEntry,
  DrawerTab,
  ImageAttachment,
  MorphEvent,
  PanelEdge,
  PickOverlayState,
  Point,
  ProjectTemplate,
  Proposal,
  RecordingAttachment,
  Rect,
  SettingsSection,
  SettingsState,
  ShipDraft,
  ShipInfo,
  ShipRequest,
  ShipResult,
  StartCommandInput,
  StorageKind,
  TerminalId,
  Version,
  Viewport,
  WindowState,
} from './types'

/** Renderer → main, request/response */
export const Invoke = {
  getSymbols: 'symbols:get',
  getState: 'state:get',
  getLogs: 'logs:get',
  getTerminal: 'terminal:get',
  getChat: 'chat:get',
  openProject: 'project:open',
  openRecent: 'project:open-recent',
  removeRecent: 'project:remove-recent',
  archiveRecentChat: 'project:archive-chat',
  cloneProject: 'project:clone',
  accountState: 'account:state',
  accountProfile: 'account:profile',
  accountSignIn: 'account:sign-in',
  accountCancel: 'account:cancel',
  accountSignOut: 'account:sign-out',
  accountUpdates: 'account:updates',
  githubState: 'github:state',
  githubConnect: 'github:connect',
  githubDisconnect: 'github:disconnect',
  githubManage: 'github:manage',
  githubClone: 'github:clone',
  githubCreate: 'github:create',
  newProject: 'project:new',
  send: 'chat:send',
  listVersions: 'versions:list',
  saveVersion: 'versions:save',
  restoreVersion: 'versions:restore',
  restoreTurn: 'chat:restore',
  redo: 'chat:redo',
  fixProblems: 'chat:fix-problems',
  fixStartup: 'chat:fix-startup',
  setStartCommand: 'project:set-start-command',
  chatSignIn: 'chat:sign-in',
  chatSetUpAgent: 'chat:set-up-agent',
  loadCommands: 'chat:load-commands',
  listChats: 'chat:list',
  openChat: 'chat:open',
  renameChat: 'chat:rename',
  deleteChat: 'chat:delete',
  signIn: 'agents:sign-in',
  installAgent: 'agents:install',
  connectAgent: 'agents:connect',
  shipInfo: 'ship:info',
  takeScreenshot: 'preview:screenshot',
  startRecording: 'recording:start',
  recordingFrame: 'recording:frame',
  finishRecording: 'recording:finish',
  discardRecording: 'recording:discard',
  ship: 'ship:run',
  getProposal: 'proposal:get',
  startFresh: 'proposal:start-fresh',
  bringInLatest: 'proposal:bring-in-latest',
  finishMerge: 'proposal:finish-merge',
  cancelMerge: 'proposal:cancel-merge',
  resolveConflicts: 'proposal:resolve-conflicts',
  getSettings: 'settings:get',
  saveCustomAgent: 'settings:save-custom-agent',
  deleteCustomAgent: 'settings:delete-custom-agent',
  untrustProject: 'settings:untrust-project',
  resetStartCommand: 'settings:reset-start-command',
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
  showChatMenu: 'menu:chat',
  showProjectMenu: 'menu:project',
  setAgent: 'agent:set',
  checkAgents: 'agents:check',
  installNode: 'node:install',
  installDeveloperTools: 'developer-tools:install',
  navigate: 'preview:navigate',
  back: 'preview:back',
  forward: 'preview:forward',
  reload: 'preview:reload',
  setViewport: 'preview:viewport',
  zoomPreview: 'preview:zoom',
  toggleSelect: 'preview:select',
  stopSelecting: 'preview:select-stop',
  pickHover: 'pick:hover',
  pickElement: 'pick:element',
  pickArea: 'pick:area',
  pickWheel: 'pick:wheel',
  endGuide: 'pick:end-guide',
  setCanvasRect: 'layout:canvas',
  /** One of the page's animation frames, while main asks for them (main/panel-flight.ts) */
  displayFrame: 'motion:frame',
  setFocusMode: 'layout:focus-mode',
  setShortcutsOpen: 'layout:shortcuts',
  toggleChat: 'chat:toggle',
  setDrawerOpen: 'drawer:open',
  showLogs: 'drawer:logs',
  selectDrawerTab: 'drawer:select',
  resizeLogs: 'logs:resize',
  newTerminal: 'terminal:new',
  closeTerminal: 'terminal:close',
  restartTerminal: 'terminal:restart',
  writeTerminal: 'terminal:write',
  resizeTerminal: 'terminal:resize',
  clearTerminal: 'terminal:clear',
  ackOutput: 'output:ack',
  cancel: 'chat:cancel',
  respondPermission: 'chat:permission',
  newSession: 'chat:new',
  clearSelection: 'chat:clear-selection',
  removeSelection: 'chat:remove-selection',
  hoverSelection: 'chat:hover-selection',
  setMinimized: 'chat:minimize',
  expandChat: 'chat:expand',
  togglePopOut: 'chat:pop-out',
  toggleDock: 'chat:dock',
  grabChat: 'chat:grab',
  dragChat: 'chat:drag',
  resizeChat: 'chat:resize',
  endResizeChat: 'chat:resize-end',
  endDragChat: 'chat:drag-end',
  chatMorphed: 'chat:morphed',
  removeQueued: 'chat:queue-remove',
  editQueued: 'chat:queue-edit',
  moveQueued: 'chat:queue-move',
  sendQueuedNow: 'chat:queue-send',
  sendQueued: 'chat:queue-send-one',
  clearQueued: 'chat:queue-clear',
  setAutoApprove: 'chat:auto-approve',
  setShipSheetOpen: 'chat:ship-sheet',
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
  setChatSidebarSide: 'settings:chat-sidebar-side',
  openCustomAgentsFile: 'settings:open-agents-file',
  newBoard: 'board:new',
  openBoard: 'board:open',
  showRecentBoardMenu: 'board:recent-menu',
  showBoardMenu: 'board:menu',
  showFrameMenu: 'board:frame-menu',
  showAddFrameMenu: 'board:add-frame-menu',
  boardSelect: 'board:select',
  boardArrange: 'board:arrange',
  boardAddFrame: 'board:add-frame',
  boardDuplicate: 'board:duplicate',
  boardDelete: 'board:delete',
  boardRenameFrame: 'board:rename-frame',
  renameBoard: 'board:rename',
  boardCamera: 'board:camera',
  boardOpenFrame: 'board:open-frame',
} as const

/** The most a single `writeTerminal` carries; the drawer sends longer pastes in pieces. */
export const MAX_TERMINAL_INPUT = 64 * 1024

/** Main → renderer */
/** What the chat's More menu hands back to the chat page to do. */
export type ChatMenuChoice = 'pullRequest' | 'archive' | 'versions'

export const Events = {
  state: 'state',
  command: 'command',
  logs: 'logs',
  terminalData: 'terminal:data',
  drawerFocus: 'drawer:focus',
  chatMeta: 'chat:meta',
  chatTurn: 'chat:turn',
  chatReset: 'chat:reset',
  chatFocus: 'chat:focus',
  chatMenuChoice: 'chat:menu-choice',
  /** The agent proposed a commit or pull request: open Source Control filled in with it */
  chatShipDraft: 'chat:ship-draft',
  chatAttach: 'chat:attach',
  recordingAttach: 'recording:attach',
  chatFloat: 'chat:float',
  morph: 'layout:morph',
  /** Main's motion needs the page's frames (true) or is done with them (false) */
  displayFrames: 'motion:frames',
  pickState: 'pick:state',
  settings: 'settings',
  settingsSection: 'settings:section',
  account: 'account',
  /** Something for the board to do that a menu asked for (`BoardCommand`) */
  board: 'board',
} as const

/** What a menu in main asks the board to do: rename a frame or the canvas in place, zoom to fit. */
export type BoardCommand =
  | { type: 'renameFrame'; id: string }
  | { type: 'renameBoard' }
  | { type: 'fit' }
  /** View → Zoom In (1), Zoom Out (-1) or Actual Size (0), which on the board fits it */
  | { type: 'zoom'; step: 1 | -1 | 0 }

/** A frame moved or resized on the board (`boardArrange`) */
export interface FrameArrangement {
  id: string
  x: number
  y: number
  width?: number
  height?: number
}

export type Unsubscribe = () => void

/**
 * Output for one of the drawer's views, from what main keeps of it: the dev server's (`id`
 * "logs-…", one per project opened) or a terminal's. Main sends it a frame's worth at a time,
 * and only while the view is on screen (main/output.ts). Each chunk follows on from what main
 * sent before, unless main no longer has all the view missed: then it's all main has, and
 * starts later than what the view has drawn, so the view starts over with it.
 */
export interface OutputChunk {
  id: string
  /** What was printed just before `end` */
  data: string
  /** Where `data` ends, in characters printed since the output began */
  end: number
}

/** Output from one of the active tab's terminals */
export interface TerminalOutput extends OutputChunk {
  id: TerminalId
}

/**
 * A menu command main hands to a page because the page owns what it acts on: the chrome's
 * address field and screenshot button, the chat's model picker.
 */
export type UiCommand = 'focusAddress' | 'screenshot' | 'chooseModel' | StartForm
/** The start screen's fields that stand in for its buttons: a new project's name, a repo. */
export type StartForm = 'newProject' | 'cloneRepo'

export interface GuiApi {
  getSymbols(): Promise<SymbolImages>
  getState(): Promise<WindowState>
  onState(cb: (state: WindowState) => void): Unsubscribe
  /** All main keeps of the dev server's output, to draw it from */
  getLogs(): Promise<OutputChunk>
  onLogs(cb: (chunk: OutputChunk) => void): Unsubscribe
  /** A shortcut for something on this page (see `UiCommand`) */
  onCommand(cb: (command: UiCommand) => void): Unsubscribe

  openProject(): Promise<void>
  openRecent(root: string): Promise<void>
  /** Removes a startup history entry, keeping project files and saved chats. */
  removeRecent(root: string): Promise<void>
  /** Archives a recent chat, so its project shows under recent projects; it can be reopened. */
  archiveRecentChat(root: string): Promise<void>
  /**
   * Clones a GitHub repo (`owner/repo`, its address, or an SSH remote) into a folder the user
   * picks, then opens it. Rejects with a message to show; resolves if they cancel the picker.
   */
  cloneProject(repo: string): Promise<void>
  /** Whether Gui needs an account and has one, read without the network. */
  getAccount(): Promise<AccountState>
  onAccount(cb: (state: AccountState) => void): Unsubscribe
  /** The signed-in account from the service; null when signed out. */
  getAccountProfile(): Promise<AccountProfile | null>
  /**
   * Opens sign-in (WorkOS AuthKit: Google, GitHub, or email) in the browser and
   * resolves once Gui is signed in. Rejects with a message to show, or "Sign-in was
   * cancelled." after cancelAccountSignIn.
   */
  accountSignIn(): Promise<void>
  cancelAccountSignIn(): Promise<void>
  signOutAccount(): Promise<void>
  setAccountUpdates(updates: boolean): Promise<void>
  getGitHub(): Promise<GitHubState>
  /** Adds GitHub to the signed-in account through the browser; resolves once connected. */
  connectGitHub(): Promise<void>
  disconnectGitHub(): Promise<void>
  manageGitHub(): Promise<void>
  cloneGitHub(id: number): Promise<void>
  createGitHub(name: string): Promise<GitHubRepository>
  /**
   * Makes a folder named `name` (with a git repo) where the user picks, with `template`'s
   * files in it, then opens it. Rejects with a message to show; resolves if they cancel the
   * picker.
   */
  newProject(name: string, template: ProjectTemplate): Promise<void>
  startDevServer(): void
  stopDevServer(): void
  restartDevServer(): void
  showDevServerMenu(): void
  /**
   * The agent menu, at the pointer, or with its top-left corner at `at` (CSS pixels in the
   * calling page) to open under the control that asked for it.
   */
  showAgentMenu(at?: { x: number; y: number }): void
  /**
   * The chat header's More menu, under the button: Source Control, Archived Chats, Pop
   * Out. Main does Pop Out itself; the rest come back as `onChatMenuChoice`.
   */
  showChatMenu(at: { x: number; y: number }, ship: { open: boolean; busy: boolean }): void
  showProjectMenu(): void

  /** A new canvas, opened in this tab if it's a start screen, otherwise in a new one */
  newBoard(): void
  /** One of the start screen's canvases */
  openBoard(id: string): void
  /** The start screen's menu for one of its canvases: open, reveal, delete */
  showRecentBoardMenu(id: string): void
  /** The canvas's menu under its name in the toolbar */
  showBoardMenu(): void
  /** A frame's context menu on the board */
  showFrameMenu(id: string): void
  /** The sizes a new frame can be, under the toolbar's Frame button at `at` */
  showAddFrameMenu(at: { x: number; y: number }): void
  /** The frames selected on the board, in the order they were selected */
  boardSelect(ids: string[]): void
  /** Frames dragged or resized on the board: one undo step */
  boardArrange(frames: FrameArrangement[]): void
  /** A new frame at `at` on the board, or beside what's selected */
  boardAddFrame(preset: FramePreset, at: { x: number; y: number } | null): void
  boardDuplicate(ids: string[]): void
  boardDelete(ids: string[]): void
  boardRenameFrame(id: string, name: string): void
  renameBoard(name: string): void
  /** Where the board is looking, saved for next time */
  boardCamera(camera: BoardCamera): void
  /** Shows a frame live in the preview; null goes back to the board */
  boardOpenFrame(id: string | null): void
  onBoardCommand(cb: (command: BoardCommand) => void): Unsubscribe

  setAgent(agentId: AgentId): void
  /** Checks one agent, or every enabled one when no id is given */
  checkAgents(agentId?: AgentId): void
  /** Runs the agent's sign-in flow (opens the browser) and re-checks it */
  signIn(agentId: AgentId): Promise<void>
  /**
   * Claude Code and Codex: downloads the CLI (progress and errors arrive through
   * `WindowState.agents`). Other agents: opens their official install page.
   */
  installAgent(agentId: AgentId): Promise<void>
  /**
   * Downloads Gui's own Node.js for a Mac without it (`ProjectSetup.node` follows it). Every
   * project waiting on it goes on to install and start once it's in.
   */
  installNode(): void
  /** Opens macOS's installer for Apple's developer tools, which git needs (`WindowState.developerTools`) */
  installDeveloperTools(): void
  /**
   * Gets the agent working in one step: downloads it if Gui can (or opens its install
   * page), then runs its sign-in. Progress and the outcome arrive through `WindowState.agents`.
   */
  connectAgent(agentId: AgentId): Promise<void>

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
  /** Zooms the viewport shown in (`step` 1), out (-1), or back to 100% or fitting (0) */
  zoomPreview(step: 1 | -1 | 0): void
  toggleSelect(): void
  /** Ends element picking (the chat bubble's click, Esc over the preview) */
  stopSelecting(): void
  /**
   * The pick overlay, in its own coordinates (the preview view's, CSS pixels): the pointer
   * is over `at` (null: it left), so main finds the element there to outline.
   */
  pickHover(at: Point | null): void
  /**
   * A click at `at` picks the element there: on its own, in place of what was picked, which
   * ends picking; with `add` (⇧), along with it, or out of it if it was already picked.
   */
  pickElement(at: Point, add: boolean): void
  /** A drag picks the area `rect` as a screenshot; `add` as for `pickElement` */
  pickArea(rect: Rect, add: boolean): void
  /** The wheel over the overlay scrolls the page under it */
  pickWheel(at: Point, deltaX: number, deltaY: number): void
  /** The user clicked the agent's walkthrough away */
  endGuide(): void
  /** What the overlay draws (see `PickOverlayState`) */
  onPickState(cb: (state: PickOverlayState) => void): Unsubscribe
  setCanvasRect(rect: Rect): void
  /**
   * The preview's layout morphs (`MorphEvent`): the chrome draws the device frame around the
   * live view as it resizes, under the toolbar and the drawer.
   */
  onMorph(cb: (event: MorphEvent) => void): Unsubscribe
  /** Focus mode on or off (see `WindowState.focusMode`) */
  setFocusMode(on: boolean): void
  /** Shows or closes the Keyboard Shortcuts sheet (`WindowState.shortcutsOpen`) */
  setShortcutsOpen(open: boolean): void
  /** Shows or hides the chat panel, as the toolbar's button does */
  toggleChat(): void

  /**
   * The drawer under the canvas (`WindowState.drawer`), from the chrome only: the dev server's
   * output and the project's terminals. Opening it shows the tab it showed last.
   */
  setDrawerOpen(open: boolean): void
  /** Opens the drawer on the dev server's output: "Show logs" */
  showLogs(): void
  selectDrawerTab(tab: DrawerTab): void
  /** Main asks the drawer to put the keyboard in a tab (⌘J, a new terminal) */
  onDrawerFocus(cb: (tab: DrawerTab) => void): Unsubscribe
  resizeLogs(cols: number, rows: number): void

  /** Starts the user's login shell in a new terminal at the project root, and shows it */
  newTerminal(): void
  /** Ends the terminal's shell and everything it started, and removes its tab */
  closeTerminal(id: TerminalId): void
  /** A new shell in place of one that exited */
  restartTerminal(id: TerminalId): void
  /** What the terminal has shown recently, to draw it again after switching tabs */
  getTerminal(id: TerminalId): Promise<TerminalOutput>
  onTerminalData(cb: (output: TerminalOutput) => void): Unsubscribe
  /**
   * The drawer has drawn a view's output up to `end`: main sends it more, and a terminal's
   * shell waits for it while it's far behind.
   */
  ackOutput(id: string, end: number): void
  /** Keystrokes and pastes, up to `MAX_TERMINAL_INPUT` characters at a time */
  writeTerminal(id: TerminalId, data: string): void
  resizeTerminal(id: TerminalId, cols: number, rows: number): void
  /** Forgets the terminal's output so far (⌘K); the shell isn't told */
  clearTerminal(id: TerminalId): void

  getChat(): Promise<ChatSnapshot>
  onChatMeta(cb: (meta: ChatMeta) => void): Unsubscribe
  onChatTurn(cb: (turn: ChatTurnUpdate) => void): Unsubscribe
  onChatReset(cb: (snapshot: ChatSnapshot) => void): Unsubscribe
  onChatFocus(cb: () => void): Unsubscribe
  /** A choice from the More menu that the chat page carries out */
  onChatMenuChoice(cb: (choice: ChatMenuChoice) => void): Unsubscribe
  /** The agent's proposed commit or pull request, once its turn ended */
  onShipDraft(cb: (draft: ShipDraft) => void): Unsubscribe
  /**
   * What the floating chat is drawn as, and the corner it's anchored by: the panel, the pill
   * while minimized, or the bubble while the user picks an element. The view grows to a larger
   * form at once; to a smaller one only once the chat has morphed into it (`chatMorphed`).
   */
  onChatFloat(cb: (float: ChatFloat) => void): Unsubscribe
  /**
   * The chat has finished morphing into `form` (the float numbered `seq`), so main can shrink
   * the view to it. Without this main shrinks it after a short while anyway.
   */
  chatMorphed(form: ChatForm, seq: number): void
  /**
   * Starts a turn, or queues the message while the agent is busy (`meta.queue`). Resolves
   * false only when it wasn't accepted (e.g. empty, or no project). `followUp` is the id of
   * an earlier turn the message is about.
   */
  send(
    text: string,
    images?: ImageAttachment[],
    recordings?: string[],
    followUp?: string | null,
  ): Promise<boolean>
  /** Drops a queued message */
  removeQueued(id: string): void
  /** Drops every queued message */
  clearQueued(): void
  /**
   * Rewrites a queued message's text, keeping what it carries (the pick, images, clips).
   * Text that leaves nothing to ask changes nothing.
   */
  editQueued(id: string, text: string): void
  /** Moves a queued message to `index` in the queue (0 runs next) */
  moveQueued(id: string, index: number): void
  /** Runs the next queued message now (when idle), resuming a paused queue */
  sendQueuedNow(): void
  /**
   * Sends one queued message ahead of the rest: now when idle (a paused queue's others
   * stay held), or next — moved to the front — while the agent works
   */
  sendQueued(id: string): void
  /** Auto mode on or off (see `ChatMeta.autoApprove`) */
  setAutoApprove(on: boolean): void
  /**
   * The user's pick for one of `ChatMeta.models` (its `model` or `effort` setting, by id).
   * Ignored unless `value` is one of that setting's current options.
   */
  setAgentSetting(settingId: string, value: string): void
  /**
   * Starts the agent without sending anything, so `ChatMeta.commands` fills in before the
   * first message. Resolves once they're there, or there are none to wait for (the agent
   * couldn't start, or offers none); never rejects. Repeated calls start nothing more.
   */
  loadCommands(): Promise<void>
  cancel(): void
  respondPermission(turnId: string, itemId: string, optionId: string | null): void
  /**
   * "Create pull request" took over the chat, or gave it back: its ⌘↩ wins over the Agent
   * menu's Allow meanwhile.
   */
  setShipSheetOpen(open: boolean): void
  restoreTurn(turnId: string): Promise<void>
  redo(): Promise<void>
  /** This chat's versions of the project's files, newest first; null without a project */
  getVersions(): Promise<Version[] | null>
  /** Saves the files as they are now as a named version; rejects with a readable message */
  saveVersion(name: string): Promise<Version>
  /** Puts the files back to a version, saving how they are now first */
  restoreVersion(id: string): Promise<void>
  /** Archives this chat and starts an empty one (`ChatMeta.archived` offers it back) */
  newSession(): void
  /** The project's archived chats, newest first */
  listChats(): Promise<ChatSummary[]>
  /** Reopens an archived chat, archiving this one; rejects with a message to show */
  openChat(id: string): Promise<void>
  /** Names an archived chat; an empty title goes back to its first message */
  renameChat(id: string, title: string): Promise<void>
  /** Deletes an archived chat for good */
  deleteChat(id: string): Promise<void>
  clearSelection(): void
  /** Drops one picked element or area from the selection */
  removeSelection(id: string): void
  /** The pointer is over a picked element's chip (null: it left), so the page outlines it */
  hoverSelection(id: string | null): void
  setMinimized(minimized: boolean): void
  /** Brings the floating panel back out of the bubble it tucked into */
  expandChat(): void
  /** Moves the chat into a window of its own, or back into the project's window */
  togglePopOut(): void
  toggleDock(): void
  /** Sends the current preview errors to the agent; false if busy or nothing to fix */
  fixProblems(): Promise<boolean>
  /**
   * Asks the agent to get the app running, with why it isn't; it waits behind a turn in
   * progress. False when there's no chat to ask
   */
  fixStartup(): Promise<boolean>
  /**
   * Starts the project with this command from now on, or with null, with what Gui detects
   * again; rejects with what's wrong with it
   */
  setStartCommand(start: StartCommandInput | null): Promise<void>
  /** Runs the chat's agent's sign-in after its login expired; true once it's signed in */
  signInAgain(): Promise<boolean>
  /**
   * Sets up the chat's own agent (`ChatMeta.agent`): downloads it, signs in, or checks it
   * again, whichever it needs next. Held messages go out once it's ready.
   */
  setUpChatAgent(): Promise<void>
  /**
   * The pointer pressed the floating panel's header or the pill, to drag it. A panel still
   * landing from a throw stops where it was under the pointer, and the drag goes on from there.
   */
  grabChat(at: ChatGrab): void
  dragChat(dx: number, dy: number): void
  /**
   * Lets go of the floating panel: it springs into a corner of the canvas, the one nearest to
   * where a throw at `velocity` (px/s, the pointer's as it let go) would come to rest.
   */
  endDragChat(velocity?: { x: number; y: number }): void

  /**
   * Shows the screenshot menu (copy, copy full page, save, attach to chat) for the
   * preview, at the pointer or with its top-left corner at `at` (CSS pixels in the calling
   * page); resolves with what was done, or null when dismissed or nothing is loaded.
   */
  startRecording(): Promise<string>
  saveRecordingFrame(id: string, timestampMs: number, jpeg: Uint8Array): Promise<boolean>
  /** `startedAt` is when the clip's time 0 was, in epoch ms (`timeOrigin + now`) */
  finishRecording(
    id: string,
    durationMs: number,
    video: Uint8Array,
    startedAt: number,
  ): Promise<void>
  discardRecording(id: string): Promise<void>
  onRecordingAttach(cb: (recording: RecordingAttachment) => void): Unsubscribe
  takeScreenshot(at?: { x: number; y: number }): Promise<'copied' | 'saved' | 'attached' | null>
  /**
   * Resizes the chat panel by a pointer delta from one of its edges or corners: the dragged
   * edges move and the opposite ones stay put. Docked, only its edge facing the preview resizes it.
   */
  resizeChat(edge: PanelEdge, dx: number, dy: number): void
  endResizeChat(): void
  /** An image main wants added to the composer (e.g. a screenshot of the preview) */
  onChatAttach(cb: (image: ImageAttachment) => void): Unsubscribe

  /** Null without a project */
  getShipInfo(): Promise<ShipInfo | null>
  /** Commits, pushes and opens the PR; rejects with a readable message */
  ship(request: ShipRequest): Promise<ShipResult>
  /**
   * Where the work stands as a pull request; null without a project or before Gui may run
   * Git there. `refresh` also gets the latest from the remote (at most every few minutes).
   */
  getProposal(refresh?: boolean): Promise<Proposal | null>
  /** Archives this chat and starts the next idea from the latest; rejects with a message */
  startFresh(): Promise<void>
  /** Merges the latest in; stopping on conflicts resolves, with `Proposal.merge` set */
  bringInLatest(): Promise<void>
  /** Commits the merge once the conflicts are resolved */
  finishMerge(): Promise<void>
  cancelMerge(): Promise<void>
  /** Sends the agent a message to resolve the conflicts */
  resolveConflicts(): Promise<void>
  /** Opens (or focuses) the Settings window, optionally at a section */
  openSettings(section?: SettingsSection): void
  getSettings(): Promise<SettingsState>
  onSettings(cb: (settings: SettingsState) => void): Unsubscribe
  /** Settings was asked to show a section (e.g. opened from the agent menu) */
  onSettingsSection(cb: (section: SettingsSection) => void): Unsubscribe
  setAgentEnabled(agentId: AgentId, enabled: boolean): void
  setDefaultAgent(agentId: AgentId): void
  setChatDocked(docked: boolean): void
  setChatSidebarSide(side: 'left' | 'right'): void
  /** Adds or replaces a custom agent; rejects with a message when the entry is invalid */
  saveCustomAgent(originalName: string | null, entry: CustomAgentEntry): Promise<void>
  deleteCustomAgent(name: string): Promise<void>
  /** Opens agents.json in the user's editor */
  openCustomAgentsFile(): void
  /** The project's dev script will ask before running again */
  untrustProject(root: string): Promise<void>
  /** The project starts with the command Gui detects again */
  resetStartCommand(root: string): Promise<void>
  clearRecent(): Promise<void>
  /** Asks to confirm, then clears; false when the user cancelled */
  clearStorage(kind: StorageKind): Promise<boolean>
}
