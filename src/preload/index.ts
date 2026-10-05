import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron'
import { Events, type GuiApi, Invoke, Send } from '../shared/ipc'

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
async function invokeOrThrow(channel: string, ...args: unknown[]) {
  const result: { error: string | null } | undefined = await ipcRenderer.invoke(channel, ...args)
  if (result?.error) throw new Error(result.error)
}

const api: GuiApi = {
  getState: () => ipcRenderer.invoke(Invoke.getState),
  onState: (cb) => subscribe(Events.state, cb),
  getLogs: () => ipcRenderer.invoke(Invoke.getLogs),
  onLogs: (cb) => subscribe(Events.logs, cb),
  onCommand: (cb) => subscribe(Events.command, cb),

  openProject: () => ipcRenderer.invoke(Invoke.openProject),
  openRecent: (root) => ipcRenderer.invoke(Invoke.openRecent, root),
  cloneProject: (repo) => invokeOrThrow(Invoke.cloneProject, repo),
  newProject: (name) => invokeOrThrow(Invoke.newProject, name),
  startDevServer: send(Send.devServerStart),
  stopDevServer: send(Send.devServerStop),
  restartDevServer: send(Send.devServerRestart),
  showDevServerMenu: send(Send.showDevServerMenu),
  showAgentMenu: send(Send.showAgentMenu),
  showProjectMenu: send(Send.showProjectMenu),
  setAgent: send(Send.setAgent),
  checkAgents: send(Send.checkAgents),
  signIn: (agentId) => ipcRenderer.invoke(Invoke.signIn, agentId),
  installAgent: (agentId) => ipcRenderer.invoke(Invoke.installAgent, agentId),
  newTab: send(Send.newTab),
  selectTab: send(Send.selectTab),
  closeTab: send(Send.closeTab),
  moveTab: send(Send.moveTab),
  showTabMenu: send(Send.showTabMenu),
  chooseApp: send(Send.chooseApp),
  installDependencies: send(Send.installDependencies),
  createEnvFile: send(Send.createEnvFile),
  openEnvFile: send(Send.openEnvFile),

  navigate: send(Send.navigate),
  back: send(Send.back),
  forward: send(Send.forward),
  reload: send(Send.reload),
  setViewport: send(Send.setViewport),
  zoomPreview: send(Send.zoomPreview),
  toggleSelect: send(Send.toggleSelect),
  stopSelecting: send(Send.stopSelecting),
  setCanvasRect: send(Send.setCanvasRect),
  onMorph: (cb) => subscribe(Events.morph, cb),
  morphShown: send(Send.morphShown),
  morphLanded: send(Send.morphLanded),
  cancelMorph: send(Send.cancelMorph),
  setFocusMode: send(Send.setFocusMode),
  setShortcutsOpen: send(Send.setShortcutsOpen),
  toggleChat: send(Send.toggleChat),
  setDrawerOpen: send(Send.setDrawerOpen),
  showLogs: send(Send.showLogs),
  selectDrawerTab: send(Send.selectDrawerTab),
  onDrawerFocus: (cb) => subscribe(Events.drawerFocus, cb),
  resizeLogs: send(Send.resizeLogs),
  newTerminal: send(Send.newTerminal),
  closeTerminal: send(Send.closeTerminal),
  restartTerminal: send(Send.restartTerminal),
  getTerminal: (id) => ipcRenderer.invoke(Invoke.getTerminal, id),
  onTerminalData: (cb) => subscribe(Events.terminalData, cb),
  writeTerminal: send(Send.writeTerminal),
  resizeTerminal: send(Send.resizeTerminal),
  clearTerminal: send(Send.clearTerminal),
  ackOutput: send(Send.ackOutput),

  getChat: () => ipcRenderer.invoke(Invoke.getChat),
  onChatMeta: (cb) => subscribe(Events.chatMeta, cb),
  onChatTurn: (cb) => subscribe(Events.chatTurn, cb),
  onChatReset: (cb) => subscribe(Events.chatReset, cb),
  onChatFocus: (cb) => subscribe(Events.chatFocus, cb),
  onChatFloat: (cb) => subscribe(Events.chatFloat, cb),
  chatMorphed: send(Send.chatMorphed),
  send: (text, images) => ipcRenderer.invoke(Invoke.send, text, images),
  cancel: send(Send.cancel),
  respondPermission: send(Send.respondPermission),
  setShipSheetOpen: send(Send.setShipSheetOpen),
  restoreTurn: (turnId) => ipcRenderer.invoke(Invoke.restoreTurn, turnId),
  redo: () => ipcRenderer.invoke(Invoke.redo),
  newSession: send(Send.newSession),
  clearSelection: send(Send.clearSelection),
  setMinimized: send(Send.setMinimized),
  toggleDock: send(Send.toggleDock),
  fixProblems: () => ipcRenderer.invoke(Invoke.fixProblems),
  grabChat: send(Send.grabChat),
  dragChat: send(Send.dragChat),
  endDragChat: send(Send.endDragChat),
  removeQueued: send(Send.removeQueued),
  sendQueuedNow: send(Send.sendQueuedNow),
  setAutoApprove: send(Send.setAutoApprove),
  setAgentSetting: send(Send.setAgentSetting),
  takeScreenshot: (at) => ipcRenderer.invoke(Invoke.takeScreenshot, at),
  resizeChat: send(Send.resizeChat),
  endResizeChat: send(Send.endResizeChat),
  onChatAttach: (cb) => subscribe(Events.chatAttach, cb),
  getShipInfo: () => ipcRenderer.invoke(Invoke.shipInfo),
  ship: (request) => ipcRenderer.invoke(Invoke.ship, request),

  openSettings: send(Send.openSettings),
  getSettings: () => ipcRenderer.invoke(Invoke.getSettings),
  onSettings: (cb) => subscribe(Events.settings, cb),
  onSettingsSection: (cb) => subscribe(Events.settingsSection, cb),
  setAgentEnabled: send(Send.setAgentEnabled),
  setDefaultAgent: send(Send.setDefaultAgent),
  setChatDocked: send(Send.setChatDocked),
  saveCustomAgent: (originalName, entry) =>
    invokeOrThrow(Invoke.saveCustomAgent, originalName, entry),
  deleteCustomAgent: (name) => invokeOrThrow(Invoke.deleteCustomAgent, name),
  openCustomAgentsFile: send(Send.openCustomAgentsFile),
  untrustProject: (root) => ipcRenderer.invoke(Invoke.untrustProject, root),
  clearRecent: () => ipcRenderer.invoke(Invoke.clearRecent),
  clearStorage: (kind) => ipcRenderer.invoke(Invoke.clearStorage, kind),
}

contextBridge.exposeInMainWorld('gui', api)
