import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { OutsideTarget } from './outside-mcp'

// gui_open: an agent outside Gui opens a project or canvas itself, without a chat (no agent
// of Gui's starts for it until the user shows the chat). It goes where the user would put it,
// in the front window, which shows without taking the keyboard from the app they're typing in.
// A folder Gui has never opened asks the user first, on that tab's start screen: opening a
// project is how its dev server comes to run. The Electron side is index.ts's.

/** How long the start screen waits for the user to answer before it counts as no. */
export const OPEN_ASK_MS = 120_000

/** What gui_open is asked to open: a canvas by id, or a folder (a canvas's, or a project). */
export type OpenRequest = { canvas: string } | { folder: string }

export interface OpenableTab {
  readonly hasProject: boolean
  readonly projectRoot: string | null
  outsideTarget(): OutsideTarget | null
  askToOpenFolder(folder: string, timeoutMs: number): Promise<boolean>
}

export interface OpenableWindow<T extends OpenableTab> {
  readonly tabs: readonly T[]
  readonly activeTab: T
  /** A start-screen tab at the end of the strip, shown */
  newTab(): T
  showTab(tab: T): void
}

export interface OpenDeps<T extends OpenableTab, W extends OpenableWindow<T>> {
  windows(): readonly W[]
  /** The focused window, or the one focused last */
  front(): W | undefined
  /** A new window, shown without taking the keyboard */
  newWindow(): W
  /** Shows the window, without taking the keyboard or bringing Gui to the front */
  reveal(win: W): void
  closeTab(win: W, tab: T): void
  isDirectory(path: string): Promise<boolean>
  /** A canvas's folder by its id; null for an id that isn't one */
  boardRoot(id: string): string | null
  /** The canvas id of a canvas's folder; null for any other folder */
  boardIdOf(path: string): string | null
  /** The folder a project opens at: its real path, or its monorepo's root */
  projectRoot(folder: string): Promise<string>
  /** Gui has opened this project before (it's recent, or trusted) */
  known(root: string): Promise<boolean>
  /** It's on its way into a tab already */
  opening(root: string): boolean
  /** Opens it in `tab` without a chat; `path` is the folder asked for (a monorepo's app) */
  open(tab: T, kind: 'canvas' | 'project', path: string): Promise<void>
}

export const declined = (folder: string) =>
  `The user declined to open ${folder} in Gui. Don't open it another way; ask them about it.`

/** The tab it goes in: the front window's start screen, or a new tab there, or a new window. */
export function tabForOpening<T extends OpenableTab, W extends OpenableWindow<T>>(
  deps: Pick<OpenDeps<T, W>, 'front' | 'newWindow'>,
): { win: W; tab: T; fresh: boolean } {
  const front = deps.front()
  if (!front) {
    const win = deps.newWindow()
    return { win, tab: win.activeTab, fresh: false }
  }
  if (!front.activeTab.hasProject) return { win: front, tab: front.activeTab, fresh: false }
  return { win: front, tab: front.newTab(), fresh: true }
}

/** A folder the agent named: absolute, or under ~/. */
function folderPath(folder: string) {
  const path = folder === '~' || folder.startsWith('~/') ? join(homedir(), folder.slice(1)) : folder
  if (!isAbsolute(path)) throw new Error(`Give the folder's full path, not ${folder}.`)
  return resolve(path)
}

/** Opens `request` for an agent outside Gui and says what the calls now act on. */
export async function openForOutside<T extends OpenableTab, W extends OpenableWindow<T>>(
  request: OpenRequest,
  deps: OpenDeps<T, W>,
): Promise<OutsideTarget> {
  let kind: 'canvas' | 'project'
  let root: string
  let path: string
  if ('canvas' in request) {
    const board = deps.boardRoot(request.canvas)
    if (!board || !(await deps.isDirectory(board)))
      throw new Error(`Gui has no canvas ${request.canvas}. gui_list lists them.`)
    kind = 'canvas'
    root = path = board
  } else {
    path = folderPath(request.folder)
    if (!(await deps.isDirectory(path))) throw new Error(`${path} is not a folder.`)
    const id = deps.boardIdOf(path)
    const board = id && deps.boardRoot(id)
    kind = board ? 'canvas' : 'project'
    root = board || (await deps.projectRoot(path))
  }

  // Open in a tab already: that tab shows, as it is.
  for (const win of deps.windows()) {
    const tab = win.tabs.find((each) => each.projectRoot === root)
    if (!tab) continue
    win.showTab(tab)
    deps.reveal(win)
    const target = tab.outsideTarget()
    if (target) return target
    throw new Error(`Gui is still opening ${root}. Call gui_status in a moment.`)
  }
  if (deps.opening(root)) throw new Error(`Gui is opening ${root}. Call gui_status in a moment.`)

  let { win, tab, fresh } = tabForOpening<T, W>(deps)
  deps.reveal(win)
  if (kind === 'project' && !(await deps.known(root))) {
    const yes = await tab.askToOpenFolder(root, OPEN_ASK_MS)
    if (!yes) {
      if (fresh && !tab.hasProject && win.tabs.includes(tab)) deps.closeTab(win, tab)
      throw new Error(declined(root))
    }
    // The user opened something else there meanwhile, or closed it: it goes where it would now.
    if (tab.hasProject || !win.tabs.includes(tab)) ({ win, tab } = tabForOpening<T, W>(deps))
    win.showTab(tab)
    deps.reveal(win)
  }
  await deps.open(tab, kind, path)
  const target = tab.outsideTarget()
  if (!target || target.root !== root) throw new Error(`Gui couldn't open ${root}.`)
  return target
}
