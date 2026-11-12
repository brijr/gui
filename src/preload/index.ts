import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron'
import { Events, type GuiApi, Invoke, Send } from '../shared/ipc'
import {
  type AllRequestArgs,
  createLegacyInvoker,
  createRequestInvoker,
  type LegacyErrorChannel,
} from '../shared/ipc-requests'

const legacyInvoke = createLegacyInvoker((channel, ...args) => ipcRenderer.invoke(channel, ...args))
const request = createRequestInvoker((channel, ...args) => ipcRenderer.invoke(channel, ...args))

function subscribe<T>(channel: string, cb: (payload: T) => void) {
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const send =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.send(channel, ...args)

/** Main reports failures as `{ error }`; turn them back into a rejection with a clean message. */
async function invokeOrThrow<C extends LegacyErrorChannel>(channel: C, ...args: AllRequestArgs<C>) {
  const result = await legacyInvoke(channel, ...args)
  if (result?.error) throw new Error(result.error)
}

const api: GuiApi = {
  getSymbols: () => legacyInvoke(Invoke.getSymbols),
  getState: () => legacyInvoke(Invoke.getState),
  onState: (cb) => subscribe(Events.state, cb),
  getLogs: () => legacyInvoke(Invoke.getLogs),
  onLogs: (cb) => subscribe(Events.logs, cb),
  onCommand: (cb) => subscribe(Events.command, cb),
  onFind: (cb) => subscribe(Events.find, cb),
  findInPage: send(Send.findInPage),
  stopFindInPage: send(Send.stopFindInPage),
  onFindResult: (cb) => subscribe(Events.findResult, cb),

  openProject: () => legacyInvoke(Invoke.openProject),
  openRecent: (root) => legacyInvoke(Invoke.openRecent, root),
  removeRecent: (root) => legacyInvoke(Invoke.removeRecent, root),
  archiveRecentChat: (root) => invokeOrThrow(Invoke.archiveRecentChat, root),
  cloneProject: (repo) => invokeOrThrow(Invoke.cloneProject, repo),
  getAccount: () => request(Invoke.accountState),
  onAccount: (cb) => subscribe(Events.account, cb),
  getAccountProfile: () => request(Invoke.accountProfile),
  accountSignIn: () => request(Invoke.accountSignIn),
  cancelAccountSignIn: () => request(Invoke.accountCancel),
  signOutAccount: () => request(Invoke.accountSignOut),
  setAccountUpdates: (updates) => request(Invoke.accountUpdates, updates),
  getGitHub: (refresh) =>
    refresh === undefined ? request(Invoke.githubState) : request(Invoke.githubState, refresh),
  connectGitHub: () => request(Invoke.githubConnect),
  disconnectGitHub: () => request(Invoke.githubDisconnect),
  manageGitHub: () => request(Invoke.githubManage),
  cloneGitHub: (id) => request(Invoke.githubClone, id),
  newProject: (name, template) => invokeOrThrow(Invoke.newProject, name, template),
  startDevServer: send(Send.devServerStart),
  stopDevServer: send(Send.devServerStop),
  restartDevServer: send(Send.devServerRestart),
  showDevServerMenu: send(Send.showDevServerMenu),
  openAgentSettings: send(Send.openAgentSettings),
  showChatMenu: send(Send.showChatMenu),
  showProjectMenu: send(Send.showProjectMenu),
  newBoard: send(Send.newBoard),
  openBoard: send(Send.openBoard),
  showRecentBoardMenu: send(Send.showRecentBoardMenu),
  showBoardMenu: send(Send.showBoardMenu),
  showFrameMenu: send(Send.showFrameMenu),
  showAddFrameMenu: send(Send.showAddFrameMenu),
  boardSelect: send(Send.boardSelect),
  boardPressed: send(Send.boardPressed),
  boardArrange: send(Send.boardArrange),
  boardAddFrame: send(Send.boardAddFrame),
  boardDuplicate: send(Send.boardDuplicate),
  boardCopy: send(Send.boardCopy),
  boardCut: send(Send.boardCut),
  boardPaste: send(Send.boardPaste),
  boardDelete: send(Send.boardDelete),
  boardExport: send(Send.boardExport),
  boardAddSection: send(Send.boardAddSection),
  boardRenameSection: send(Send.boardRenameSection),
  boardDeleteSection: send(Send.boardDeleteSection),
  showSectionMenu: send(Send.showSectionMenu),
  boardRenameFrame: send(Send.boardRenameFrame),
  renameBoard: send(Send.renameBoard),
  boardCamera: send(Send.boardCamera),
  boardChatCover: () => legacyInvoke(Invoke.boardChatCover),
  boardOpenFrame: send(Send.boardOpenFrame),
  onBoardCommand: (cb) => subscribe(Events.board, cb),
  setAgent: send(Send.setAgent),
  checkAgents: send(Send.checkAgents),
  installNode: send(Send.installNode),
  installDeveloperTools: send(Send.installDeveloperTools),
  restartToUpdate: send(Send.restartToUpdate),
  signIn: (agentId) => legacyInvoke(Invoke.signIn, agentId),
  installAgent: (agentId) => legacyInvoke(Invoke.installAgent, agentId),
  connectAgent: (agentId) => legacyInvoke(Invoke.connectAgent, agentId),
  newTab: send(Send.newTab),
  selectTab: send(Send.selectTab),
  closeTab: send(Send.closeTab),
  moveTab: send(Send.moveTab),
  showTabMenu: send(Send.showTabMenu),
  chooseApp: send(Send.chooseApp),
  installDependencies: send(Send.installDependencies),
  agreeToStart: send(Send.agreeToStart),
  createEnvFile: send(Send.createEnvFile),
  openEnvFile: send(Send.openEnvFile),

  navigate: send(Send.navigate),
  backToApp: send(Send.backToApp),
  back: send(Send.back),
  forward: send(Send.forward),
  reload: send(Send.reload),
  setViewport: send(Send.setViewport),
  zoomPreview: send(Send.zoomPreview),
  toggleSelect: send(Send.toggleSelect),
  stopSelecting: send(Send.stopSelecting),
  pickHover: send(Send.pickHover),
  pickElement: send(Send.pickElement),
  pickArea: send(Send.pickArea),
  editPreviewText: send(Send.editPreviewText),
  pickWheel: send(Send.pickWheel),
  endGuide: send(Send.endGuide),
  variations: send(Send.variations),
  variationsSize: send(Send.variationsSize),
  onPickState: (cb) => subscribe(Events.pickState, cb),
  toggleRulers: send(Send.toggleRulers),
  rulerDrag: send(Send.rulerDrag),
  onRulers: (cb) => subscribe(Events.rulers, cb),
  getRulers: () => legacyInvoke(Invoke.getRulers),
  guidePointer: send(Send.guidePointer),
  onGuideStrips: (cb) => subscribe(Events.guideStrips, cb),
  setCanvasRect: send(Send.setCanvasRect),
  onMorph: (cb) => subscribe(Events.morph, cb),
  onSidebarSlide: (cb) => subscribe(Events.sidebarSlide, cb),
  setFocusMode: send(Send.setFocusMode),
  setShortcutsOpen: send(Send.setShortcutsOpen),
  toggleChat: send(Send.toggleChat),
  setDrawerOpen: send(Send.setDrawerOpen),
  focusPreview: send(Send.focusPreview),
  showLogs: send(Send.showLogs),
  selectDrawerTab: send(Send.selectDrawerTab),
  onDrawerFocus: (cb) => subscribe(Events.drawerFocus, cb),
  resizeLogs: send(Send.resizeLogs),
  newTerminal: send(Send.newTerminal),
  closeTerminal: send(Send.closeTerminal),
  restartTerminal: send(Send.restartTerminal),
  getTerminal: (id) => legacyInvoke(Invoke.getTerminal, id),
  onTerminalData: (cb) => subscribe(Events.terminalData, cb),
  writeTerminal: send(Send.writeTerminal),
  resizeTerminal: send(Send.resizeTerminal),
  clearTerminal: send(Send.clearTerminal),
  ackOutput: send(Send.ackOutput),

  getChat: () => legacyInvoke(Invoke.getChat),
  onChatMeta: (cb) => subscribe(Events.chatMeta, cb),
  onChatTurn: (cb) => subscribe(Events.chatTurn, cb),
  onChatReset: (cb) => subscribe(Events.chatReset, cb),
  onChatFocus: (cb) => subscribe(Events.chatFocus, cb),
  onChatMenuChoice: (cb) => subscribe(Events.chatMenuChoice, cb),
  onChatFloat: (cb) => subscribe(Events.chatFloat, cb),
  onChatShape: (cb) => subscribe(Events.chatShape, cb),
  onChatSeen: (cb) => subscribe(Events.chatSeen, cb),
  chatMorphed: send(Send.chatMorphed),
  chatCollapsed: send(Send.chatCollapsed),
  chatBoxHeight: send(Send.chatBoxHeight),
  holdChat: send(Send.holdChat),
  chatDrafted: send(Send.chatDrafted),
  send: (text, images, recordings, followUp, steer) =>
    legacyInvoke(Invoke.send, text, images, recordings, followUp, steer),
  cancel: send(Send.cancel),
  respondPermission: send(Send.respondPermission),
  stopSubagent: send(Send.stopSubagent),
  restoreTurn: (turnId) => legacyInvoke(Invoke.restoreTurn, turnId),
  redo: () => legacyInvoke(Invoke.redo),
  newSession: send(Send.newSession),
  listChats: () => request(Invoke.listChats),
  openChat: (id) => request(Invoke.openChat, id),
  renameChat: (id, title) => request(Invoke.renameChat, id, title),
  deleteChat: (id) => request(Invoke.deleteChat, id),
  clearSelection: send(Send.clearSelection),
  removeSelection: send(Send.removeSelection),
  hoverSelection: send(Send.hoverSelection),
  expandChat: send(Send.expandChat),
  togglePopOut: send(Send.togglePopOut),
  toggleDock: send(Send.toggleDock),
  fixProblems: () => legacyInvoke(Invoke.fixProblems),
  fixStartup: () => legacyInvoke(Invoke.fixStartup),
  setStartCommand: (start) => invokeOrThrow(Invoke.setStartCommand, start),
  setUpChatAgent: () => legacyInvoke(Invoke.chatSetUpAgent),
  grabChat: send(Send.grabChat),
  dragChat: send(Send.dragChat),
  endDragChat: send(Send.endDragChat),
  removeQueued: send(Send.removeQueued),
  clearQueued: send(Send.clearQueued),
  editQueued: send(Send.editQueued),
  moveQueued: send(Send.moveQueued),
  sendQueuedNow: send(Send.sendQueuedNow),
  retry: send(Send.retry),
  sendQueued: send(Send.sendQueued),
  setAutoApprove: send(Send.setAutoApprove),
  setAgentSetting: send(Send.setAgentSetting),
  loadCommands: () => legacyInvoke(Invoke.loadCommands),
  startRecording: (narrate) => legacyInvoke(Invoke.startRecording, narrate === true),
  saveRecordingFrame: (id, at, jpeg) => legacyInvoke(Invoke.recordingFrame, id, at, jpeg),
  saveRecordingVideo: (id, chunk) => legacyInvoke(Invoke.recordingVideo, id, chunk),
  finishRecording: (id, duration, startedAt, audio) =>
    legacyInvoke(Invoke.finishRecording, id, duration, startedAt, audio ?? null),
  prepareNarration: () => legacyInvoke(Invoke.prepareNarration),
  discardRecording: (id) => legacyInvoke(Invoke.discardRecording, id),
  onRecordingCursor: (cb) => subscribe(Events.recordingCursor, cb),
  onRecordingAttach: (cb) => subscribe(Events.recordingAttach, cb),
  onRecordingUpdate: (cb) => subscribe(Events.recordingUpdate, cb),
  takeScreenshot: (at) => legacyInvoke(Invoke.takeScreenshot, at),
  showToolbarMenu: (items, at) => legacyInvoke(Invoke.showToolbarMenu, items, at),
  showRecordMenu: (at, narrate) => legacyInvoke(Invoke.showRecordMenu, at, narrate === true),
  resizeChat: send(Send.resizeChat),
  endResizeChat: send(Send.endResizeChat),
  onChatAttach: (cb) => subscribe(Events.chatAttach, cb),

  openSettings: send(Send.openSettings),
  getSettings: () => legacyInvoke(Invoke.getSettings),
  onSettings: (cb) => subscribe(Events.settings, cb),
  onSettingsSection: (cb) => subscribe(Events.settingsSection, cb),
  setAgentEnabled: send(Send.setAgentEnabled),
  setDefaultAgent: send(Send.setDefaultAgent),
  setChatDocked: send(Send.setChatDocked),
  setChatSidebarSide: send(Send.setChatSidebarSide),
  setCrashReports: send(Send.setCrashReports),
  setWhileWorking: send(Send.setWhileWorking),
  reportError: send(Send.reportError),
  saveCustomAgent: (originalName, entry) =>
    invokeOrThrow(Invoke.saveCustomAgent, originalName, entry),
  deleteCustomAgent: (name) => invokeOrThrow(Invoke.deleteCustomAgent, name),
  openCustomAgentsFile: send(Send.openCustomAgentsFile),
  untrustProject: (root) => legacyInvoke(Invoke.untrustProject, root),
  resetStartCommand: (root) => legacyInvoke(Invoke.resetStartCommand, root),
  clearRecent: () => legacyInvoke(Invoke.clearRecent),
  clearStorage: (kind) => legacyInvoke(Invoke.clearStorage, kind),
}

contextBridge.exposeInMainWorld('gui', api)

/*
 * Main's motion steps on this page's frames (main/panel-flight.ts `onDisplayFrames`): while it
 * asks, a message from every animation frame, so a view main moves stays in step with the
 * display.
 */
// The page's own, which the preload's (Node) types don't include.
declare function requestAnimationFrame(callback: (time: number) => void): number
declare function cancelAnimationFrame(handle: number): void
let displayFrame = 0
const sendDisplayFrame = () => {
  displayFrame = requestAnimationFrame(sendDisplayFrame)
  ipcRenderer.send(Send.displayFrame)
}
ipcRenderer.on(Events.displayFrames, (_event, on: boolean) => {
  cancelAnimationFrame(displayFrame)
  displayFrame = on ? requestAnimationFrame(sendDisplayFrame) : 0
})
