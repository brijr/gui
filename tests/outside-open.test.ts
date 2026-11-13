import { expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OutsideTarget } from '../src/main/outside-mcp'
import {
  declined,
  OPEN_ASK_MS,
  type OpenDeps,
  type OpenRequest,
  openForOutside,
} from '../src/main/outside-open'

// gui_open (main/outside-open.ts): an agent outside Gui opens a project or canvas in the front
// window, without a chat, in the start-screen tab or a new tab there; a folder Gui has never
// opened is the user's to agree to first, on that start screen.

const CANVASES = '/data/canvases'

class FakeTab {
  root: string | null = null
  answer = true
  asked: { folder: string; ms: number }[] = []
  constructor(readonly name: string) {}
  get hasProject() {
    return this.root !== null
  }
  get projectRoot() {
    return this.root
  }
  outsideTarget(): OutsideTarget | null {
    if (!this.root) return null
    return {
      kind: this.root.startsWith(CANVASES) ? 'canvas' : 'project',
      name: this.root.split('/').at(-1) ?? '',
      root: this.root,
      preview: () => '',
      live: () => true,
      closed: new AbortController().signal,
      backends: { tools: {} as never, recordings: {} as never, board: null },
    }
  }
  async askToOpenFolder(folder: string, ms: number) {
    this.asked.push({ folder, ms })
    return this.answer
  }
}

class FakeWindow {
  tabs: FakeTab[]
  activeTab: FakeTab
  shownInactive = 0
  constructor(
    readonly name: string,
    tab = new FakeTab(`${name}:1`),
  ) {
    this.tabs = [tab]
    this.activeTab = tab
  }
  newTab() {
    const tab = new FakeTab(`${this.name}:${this.tabs.length + 1}`)
    this.tabs.push(tab)
    this.activeTab = tab
    return tab
  }
  showTab(tab: FakeTab) {
    if (this.tabs.includes(tab)) this.activeTab = tab
  }
}

/** Folders that exist, and those Gui knows (recent or trusted). */
function world({
  windows = [new FakeWindow('front')],
  folders = ['/work/shop', '/work/new-app', `${CANVASES}/abcdefabcdef`],
  known = ['/work/shop'],
}: {
  windows?: FakeWindow[]
  folders?: string[]
  known?: string[]
} = {}) {
  const opened: { tab: string; kind: string; path: string }[] = []
  const closed: string[] = []
  const deps: OpenDeps<FakeTab, FakeWindow> = {
    windows: () => windows,
    front: () => windows[0],
    newWindow: () => {
      const win = new FakeWindow(`new${windows.length}`)
      windows.push(win)
      return win
    },
    reveal: (win) => {
      win.shownInactive++
    },
    closeTab: (win, tab) => {
      win.tabs = win.tabs.filter((each) => each !== tab)
      win.activeTab = win.tabs[0]
      closed.push(tab.name)
    },
    isDirectory: async (path) => folders.includes(path),
    boardRoot: (id) => (/^[a-z0-9]{12}$/.test(id) ? `${CANVASES}/${id}` : null),
    boardIdOf: (path) => (path.startsWith(`${CANVASES}/`) ? path.slice(CANVASES.length + 1) : null),
    projectRoot: async (folder) => folder,
    known: async (root) => known.includes(root),
    opening: () => false,
    open: async (tab, kind, path) => {
      opened.push({ tab: tab.name, kind, path })
      tab.root = path
    },
  }
  const open = (request: OpenRequest) => openForOutside(request, deps)
  return { windows, deps, opened, closed, open }
}

test('from the start screen, a canvas opens in that tab, which shows without taking focus', async () => {
  const { windows, opened, open } = world()
  const target = await open({ canvas: 'abcdefabcdef' })
  expect(target.kind).toBe('canvas')
  expect(target.root).toBe(`${CANVASES}/abcdefabcdef`)
  expect(opened).toEqual([{ tab: 'front:1', kind: 'canvas', path: `${CANVASES}/abcdefabcdef` }])
  expect(windows[0].tabs).toHaveLength(1)
  expect(windows[0].shownInactive).toBeGreaterThan(0)
})

test('with a project in the front tab, it opens in a new tab there, which becomes the front one', async () => {
  const front = new FakeWindow('front')
  front.activeTab.root = '/work/other'
  const { opened, open } = world({ windows: [front], folders: ['/work/shop', '/work/other'] })
  await open({ folder: '/work/shop' })
  expect(opened).toEqual([{ tab: 'front:2', kind: 'project', path: '/work/shop' }])
  expect(front.activeTab.name).toBe('front:2')
  expect(front.tabs[0].root).toBe('/work/other')
})

test('with no window, a new one opens for it', async () => {
  const { windows, opened, open } = world({ windows: [] })
  await open({ canvas: 'abcdefabcdef' })
  expect(windows).toHaveLength(1)
  expect(opened[0].tab).toBe('new0:1')
})

test('a canvas folder opens as a canvas; one already open shows its tab instead', async () => {
  const front = new FakeWindow('front')
  front.activeTab.root = `${CANVASES}/abcdefabcdef`
  front.newTab()
  const { opened, open } = world({ windows: [front] })
  const target = await open({ folder: `${CANVASES}/abcdefabcdef` })
  expect(target.kind).toBe('canvas')
  expect(opened).toEqual([])
  expect(front.activeTab.name).toBe('front:1')
})

test('a recent project opens without asking', async () => {
  const { windows, open } = world()
  await open({ folder: '/work/shop' })
  expect(windows[0].activeTab.asked).toEqual([])
})

test('a folder Gui has never opened asks the user first, naming it, then opens', async () => {
  const { windows, opened, open } = world()
  const tab = windows[0].activeTab
  const target = await open({ folder: '/work/new-app' })
  expect(tab.asked).toEqual([{ folder: '/work/new-app', ms: OPEN_ASK_MS }])
  expect(target.root).toBe('/work/new-app')
  expect(opened).toEqual([{ tab: 'front:1', kind: 'project', path: '/work/new-app' }])
})

test('declined, nothing opens, the tab made to ask goes, and the agent is told', async () => {
  const front = new FakeWindow('front')
  front.activeTab.root = '/work/shop'
  const { opened, closed, open } = world({ windows: [front] })
  // The new tab is the one that asks; it says no.
  const newTab = front.newTab.bind(front)
  front.newTab = () => {
    const tab = newTab()
    tab.answer = false
    return tab
  }
  await expect(open({ folder: '/work/new-app' })).rejects.toThrow(declined('/work/new-app'))
  expect(opened).toEqual([])
  expect(closed).toEqual(['front:2'])
  expect(front.tabs.map((tab) => tab.name)).toEqual(['front:1'])

  // Declined on the start screen: the tab stays, as it was.
  const start = world()
  start.windows[0].activeTab.answer = false
  await expect(start.open({ folder: '/work/new-app' })).rejects.toThrow('declined')
  expect(start.closed).toEqual([])
  expect(start.windows[0].tabs).toHaveLength(1)
})

test("a path that isn't an existing folder, or isn't a full path, is refused before anything", async () => {
  const { windows, opened, open } = world({ folders: ['/work/shop', '/work/package.json'] })
  await expect(open({ folder: '/work/missing' })).rejects.toThrow('/work/missing is not a folder.')
  await expect(open({ folder: 'work/shop' })).rejects.toThrow("Give the folder's full path")
  await expect(open({ canvas: 'nope' })).rejects.toThrow('Gui has no canvas nope')
  await expect(open({ canvas: 'zzzzzzzzzzzz' })).rejects.toThrow('Gui has no canvas')
  expect(opened).toEqual([])
  expect(windows[0].activeTab.asked).toEqual([])
})

test('~ is the home folder', async () => {
  const shop = join(homedir(), 'shop')
  const { opened, open } = world({ folders: [shop], known: [shop] })
  await open({ folder: '~/shop' })
  expect(opened[0].path).toBe(shop)
})
