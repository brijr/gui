import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron'
import { Events, type GratApi, Invoke, Send } from '../shared/ipc'

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

const api: GratApi = {
  getState: () => ipcRenderer.invoke(Invoke.getState),
  onState: (cb) => subscribe(Events.state, cb),
  getLogs: () => ipcRenderer.invoke(Invoke.getLogs),
  onLogs: (cb) => subscribe(Events.logs, cb),

  openProject: () => ipcRenderer.invoke(Invoke.openProject),
  openRecent: (root) => ipcRenderer.invoke(Invoke.openRecent, root),
  startDevServer: send(Send.devServerStart),
  stopDevServer: send(Send.devServerStop),
  restartDevServer: send(Send.devServerRestart),
  showDevServerMenu: send(Send.showDevServerMenu),
  showAgentMenu: send(Send.showAgentMenu),
  showProjectMenu: send(Send.showProjectMenu),
  setAgent: send(Send.setAgent),

  navigate: send(Send.navigate),
  back: send(Send.back),
  forward: send(Send.forward),
  reload: send(Send.reload),
  setViewport: send(Send.setViewport),
  toggleSelect: send(Send.toggleSelect),
  setCanvasRect: send(Send.setCanvasRect),
  toggleChat: send(Send.toggleChat),
  setLogsOpen: send(Send.setLogsOpen),
  resizeLogs: send(Send.resizeLogs),

  getChat: () => ipcRenderer.invoke(Invoke.getChat),
  onChatMeta: (cb) => subscribe(Events.chatMeta, cb),
  onChatTurn: (cb) => subscribe(Events.chatTurn, cb),
  onChatReset: (cb) => subscribe(Events.chatReset, cb),
  onChatFocus: (cb) => subscribe(Events.chatFocus, cb),
  send: (text) => ipcRenderer.invoke(Invoke.send, text),
  cancel: send(Send.cancel),
  respondPermission: send(Send.respondPermission),
  restoreTurn: (turnId) => ipcRenderer.invoke(Invoke.restoreTurn, turnId),
  redo: () => ipcRenderer.invoke(Invoke.redo),
  newSession: send(Send.newSession),
  clearSelection: send(Send.clearSelection),
  setMinimized: send(Send.setMinimized),
  dragChat: send(Send.dragChat),
  endDragChat: send(Send.endDragChat),
}

contextBridge.exposeInMainWorld('grat', api)
