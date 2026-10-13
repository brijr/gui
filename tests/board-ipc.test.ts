import { expect, test } from 'bun:test'
import { registerBoardIpc } from '../src/main/board-ipc'
import { createWindowMessageRegistrar } from '../src/main/ipc-handler'
import type { ProjectTab } from '../src/main/tab'
import type { ProjectWindow } from '../src/main/window'
import { Send } from '../src/shared/ipc'

test('board messages only act from their owning chrome and validate before changing a board', () => {
  const calls: unknown[] = []
  const chrome = {}
  const other = {}
  let board: object | null = {}
  const tab = {
    get boardSession() {
      return board
    },
    boardAddFrame: (...args: unknown[]) => {
      calls.push(args)
    },
    boardSetCamera: (...args: unknown[]) => {
      calls.push(args)
    },
  } as unknown as ProjectTab
  const win = { win: { webContents: chrome }, activeTab: tab } as ProjectWindow
  type Event = { sender: object; window: boolean }
  const listeners = new Map<string, (event: Event, ...args: unknown[]) => void>()
  const onWindow = createWindowMessageRegistrar<Event, ProjectWindow>(
    (channel, handler) => {
      listeners.set(channel, handler)
    },
    (event) => (event.window ? win : undefined),
  )
  registerBoardIpc(onWindow, {
    create: async () => {},
    open: async () => {},
    recentMenu: () => {},
    promote: async () => {},
  })
  const add = listeners.get(Send.boardAddFrame)
  if (!add) throw new Error('Frame handler missing')
  add({ sender: other, window: true }, 'desktop', null)
  add({ sender: chrome, window: false }, 'desktop', null)
  add({ sender: chrome, window: true }, 'invalid', null)
  add({ sender: chrome, window: true }, 'desktop', { x: Number.NaN, y: 0 })
  expect(calls).toEqual([])
  add({ sender: chrome, window: true }, 'desktop', null)
  expect(calls).toEqual([['desktop', null]])
  board = null
  add({ sender: chrome, window: true }, 'mobile', null)
  expect(calls).toHaveLength(1)
  board = {}
  const camera = listeners.get(Send.boardCamera)
  if (!camera) throw new Error('Camera handler missing')
  camera({ sender: chrome, window: true }, { x: 0, y: 0, zoom: 0 })
  camera({ sender: chrome, window: true }, { x: 0, y: 0, zoom: 1 })
  expect(calls).toHaveLength(2)
})
