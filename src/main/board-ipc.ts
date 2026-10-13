import { type BoardCamera, isFramePreset } from '../shared/board'
import { type FrameArrangement, Send } from '../shared/ipc'
import type { Point } from '../shared/types'
import type { ProjectTab } from './tab'
import type { ProjectWindow } from './window'

type OnWindow = (channel: string, handler: (win: ProjectWindow, ...args: unknown[]) => void) => void
const string = (value: unknown): value is string => typeof value === 'string'
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const point = (value: unknown): value is Point => {
  if (!value || typeof value !== 'object') return false
  const { x, y } = value as Record<string, unknown>
  return number(x) && number(y)
}
const ids = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 100 && value.every(string)

function arrangement(value: unknown): value is FrameArrangement {
  if (!value || typeof value !== 'object') return false
  const { id, x, y, width, height } = value as Record<string, unknown>
  const edge = (value: unknown) => value === undefined || number(value)
  return string(id) && number(x) && number(y) && edge(width) && edge(height)
}
function camera(value: unknown): value is BoardCamera {
  if (!point(value)) return false
  const { zoom } = value as unknown as Record<string, unknown>
  return number(zoom) && zoom > 0
}

/** Canvas messages retain the owning window's chrome-only authorization boundary. */
export function registerBoardIpc(
  onWindow: OnWindow,
  actions: {
    create: (win: ProjectWindow) => Promise<void>
    open: (win: ProjectWindow, id: string) => Promise<void>
    recentMenu: (win: ProjectWindow, id: string) => void
    promote: (win: ProjectWindow, tab: ProjectTab, id: string) => Promise<void>
  },
) {
  onWindow(Send.newBoard, (win) => void actions.create(win))
  onWindow(Send.openBoard, (win, id) => string(id) && void actions.open(win, id))
  onWindow(Send.showRecentBoardMenu, (win, id) => string(id) && actions.recentMenu(win, id))
  onWindow(Send.showBoardMenu, (win) => win.activeTab.showBoardMenu(() => void actions.create(win)))
  onWindow(Send.showFrameMenu, (win, id) => {
    const tab = win.activeTab
    if (string(id)) tab.showFrameMenu(id, (frame) => void actions.promote(win, tab, frame))
  })
  onWindow(Send.showAddFrameMenu, (win, at) => {
    if (point(at)) win.activeTab.showAddFrameMenu(at)
  })
  const onBoard = (channel: string, handler: (tab: ProjectTab, ...args: unknown[]) => void) =>
    onWindow(channel, (win, ...args) => {
      if (win.activeTab.boardSession) handler(win.activeTab, ...args)
    })
  onBoard(Send.boardSelect, (tab, value) => ids(value) && tab.boardSelect(value))
  onBoard(Send.boardArrange, (tab, frames) => {
    if (Array.isArray(frames) && frames.length <= 100 && frames.every(arrangement))
      void tab.boardArrange(frames)
  })
  onBoard(Send.boardAddFrame, (tab, preset, at) => {
    if (isFramePreset(preset) && (at === null || point(at))) void tab.boardAddFrame(preset, at)
  })
  onBoard(Send.boardDuplicate, (tab, value) => ids(value) && void tab.boardDuplicate(value))
  onBoard(Send.boardDelete, (tab, value) => ids(value) && void tab.boardDelete(value))
  onBoard(Send.boardExport, (tab, value) => ids(value) && void tab.exportFrames(value))
  onBoard(Send.boardAddSection, (tab, value) => ids(value) && void tab.boardAddSection(value))
  onBoard(Send.boardRenameSection, (tab, id, name) => {
    if (string(id) && string(name)) void tab.boardSession?.updateSection(id, { name })
  })
  onBoard(
    Send.boardDeleteSection,
    (tab, id) => string(id) && void tab.boardSession?.removeSection(id),
  )
  onBoard(Send.showSectionMenu, (tab, id) => string(id) && tab.showSectionMenu(id))
  onBoard(Send.boardRenameFrame, (tab, id, name) => {
    if (string(id) && string(name)) void tab.boardRenameFrame(id, name)
  })
  onBoard(Send.renameBoard, (tab, name) => string(name) && void tab.renameBoard(name))
  onBoard(Send.boardCamera, (tab, value) => camera(value) && tab.boardSetCamera(value))
  onBoard(Send.boardOpenFrame, (tab, id) => {
    if (id === null || string(id)) void tab.openFrame(id)
  })
}
