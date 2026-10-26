import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { ZOOM_LEVELS } from '../src/main/viewport'
import {
  acceleratorKeys,
  allShortcuts,
  ariaShortcut,
  SHORTCUT_GROUPS,
  type ShortcutId,
  shortcut,
  shortcutText,
} from '../src/shared/shortcuts'
import {
  type AgentId,
  CUSTOM_AGENT_PREFIX,
  type ElementContext,
  isRegion,
  type TurnItem,
  viewportSpec,
} from '../src/shared/types'
import { electronExecutable, sleep, waitFor } from './helpers/env'
import { chooseFromChatMenu } from './helpers/menus'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// Keyboard shortcuts come from one registry (src/shared/shortcuts.ts): the app menu, the
// Keyboard Shortcuts sheet (⌘/) and the controls' tooltips all read it. Menu items are
// chosen from the main process, as other specs do: no test can press keys in the menu bar.
// Keys the chat panel handles itself (⌘↩, ⌘⌫) are pressed in its page. A stand-in ACP agent
// offers models, asks for permissions and takes screenshots, so no agent login is needed.

/** What Playwright passes to `app.evaluate` callbacks. */
type ElectronModule = typeof import('electron/main')

interface Size {
  width: number
  height: number
}

interface Point {
  x: number
  y: number
}

/** The preview's document requests, and the Cache-Control each was sent with, by id. */
interface CacheStore {
  guiDocuments?: string[]
  guiSent?: Record<string, string>
}

/**
 * The terminal's shell: zsh, which every Mac has, from an empty config folder, so the
 * developer's own ~/.zshrc doesn't run (as in terminal.spec.ts).
 */
const ZDOTDIR = mkdtempSync(join(tmpdir(), 'gui-e2e-zsh-'))
const SHELL = { SHELL: '/bin/zsh', ZDOTDIR }
test.afterAll(() => rmSync(ZDOTDIR, { recursive: true, force: true }))

/** Set explicitly: CI's screen is short, and expectations follow the canvas Gui gets. */
const WINDOW = { width: 1280, height: 820 }
/** Focus mode's title bar (FOCUS_BAR_HEIGHT) and its traffic lights (FOCUS_TRAFFIC_LIGHTS). */
const FOCUS_BAR = 28
const FOCUS_LIGHTS = { x: 16, y: 7 }

function setContentSize({ BrowserWindow }: ElectronModule, size: Size) {
  BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height)
}

/** Clicks a visible item of the app menu by label, as the user would in the menu bar. */
function clickMenu(session: GuiSession, label: string) {
  return session.app.evaluate(({ Menu }, name) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (item.label === name && item.visible) return item
        const inner = item.submenu && find(item.submenu.items)
        if (inner) return inner
      }
      return undefined
    }
    const item = find(Menu.getApplicationMenu()?.items ?? [])
    if (!item) throw new Error(`No menu item "${name}"`)
    item.click()
  }, label)
}

interface MenuEntry {
  id: string
  label: string
  accelerator: string | null
  visible: boolean
  enabled: boolean
  checked: boolean
  worksHidden: boolean
  role: string | null
  menu: string
}

/** Runs in main: every item of the app menu, with the top-level menu it's in. */
function menuEntries({ Menu }: ElectronModule): MenuEntry[] {
  const out: MenuEntry[] = []
  const walk = (items: Electron.MenuItem[], menu: string) => {
    for (const item of items) {
      out.push({
        id: item.id,
        label: item.label,
        accelerator: item.accelerator ?? null,
        visible: item.visible,
        enabled: item.enabled,
        checked: item.checked,
        worksHidden:
          (item as { acceleratorWorksWhenHidden?: boolean }).acceleratorWorksWhenHidden ?? false,
        role: item.role ?? null,
        menu,
      })
      if (item.submenu) walk(item.submenu.items, menu || item.label)
    }
  }
  walk(Menu.getApplicationMenu()?.items ?? [], '')
  return out
}

/** Runs in main: an app menu item by id, as it is now. */
function menuItem({ Menu }: ElectronModule, id: string) {
  const item = Menu.getApplicationMenu()?.getMenuItemById(id)
  return item ? { enabled: item.enabled, checked: item.checked } : null
}

interface Views {
  preview: Electron.Rectangle & { visible: boolean }
  chat: (Electron.Rectangle & { visible: boolean }) | null
  content: Size
  lights: Point | null
}

/** Runs in main, in a task of its own: the first window's preview and chat views. */
async function views({ BrowserWindow, WebContentsView }: ElectronModule): Promise<Views | null> {
  await new Promise<void>((resolve) => setImmediate(() => resolve()))
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return null
  const children = win.contentView.children.filter(
    (child): child is InstanceType<typeof WebContentsView> => child instanceof WebContentsView,
  )
  const preview = children.find((view) => /^https?:\/\//.test(view.webContents.getURL()))
  const chat = children.find((view) => view.webContents.getURL().endsWith('/chat.html'))
  if (!preview) return null
  const [width = 0, height = 0] = win.getContentSize()
  return {
    preview: { ...preview.getBounds(), visible: preview.getVisible() },
    chat: chat ? { ...chat.getBounds(), visible: chat.getVisible() } : null,
    content: { width, height },
    lights: win.getWindowButtonPosition(),
  }
}

/** Runs in main: the size the preview's page lays itself out at. */
async function pageSize({ webContents }: ElectronModule): Promise<Size | null> {
  const preview = webContents.getAllWebContents().find((wc) => /^https?:\/\//.test(wc.getURL()))
  if (!preview || preview.isCrashed()) return null
  return preview.executeJavaScript('({ width: innerWidth, height: innerHeight })')
}

/** Picks what's at `point` (view coordinates) with real input, as the user's click would. */
async function pickAt(session: GuiSession, point: Point): Promise<ElementContext> {
  const picked = await session.pickAt(point)
  if (isRegion(picked)) throw new Error('The click picked an area')
  return picked
}

/** The counter button's box in page coordinates (CSS pixels). */
async function counterBox(session: GuiSession) {
  const box = await (await session.previewPage()).locator('button.counter').boundingBox()
  if (!box) throw new Error('The counter has no layout box')
  return box
}

/** Waits for the device frame's scale (or Desktop's page zoom) to be `scale`. */
function zoomIs(session: GuiSession, scale: number, label: string) {
  return waitFor(async () => {
    const { preview } = await session.state()
    const now = preview.frame ? preview.frame.scale : preview.zoom
    return Math.abs(now - scale) < 0.0011 ? preview : null
  }, label)
}

const frameLabel = (session: GuiSession) => session.chrome.locator('main p').first()

/** The canvas's height as the chrome lays it out: where the preview goes. */
const canvasHeight = (session: GuiSession) =>
  session.chrome.evaluate(() => Math.round(document.querySelector('main')?.clientHeight ?? 0))

// A stand-in ACP agent: it offers a model setting (a list long enough to search), asks
// "ASK n" permission questions one after the other, each offering Always allow, Allow and
// Don't allow, and calls Gui's preview_screenshot tool for "SHOT {...}". Every answer goes
// into a log, the moment it arrives.

const AGENT: AgentId = `${CUSTOM_AGENT_PREFIX}Shortcuts`

const AGENT_SCRIPT = String.raw`
const { appendFileSync } = require('node:fs')
const [log] = process.argv.slice(2)
const MODELS = ['Swift', 'Sage', 'Atlas', 'Nova', 'Orbit', 'Pulse', 'Quill', 'Ridge', 'Spark', 'Tide']
const state = { llm: 'swift' }
const configOptions = () => [
  { id: 'llm', name: 'Model', category: 'model', type: 'select', currentValue: state.llm,
    options: MODELS.map((name) => ({ value: name.toLowerCase(), name })) },
]
const OPTIONS = [
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
]
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const say = (sessionId, text) =>
  write({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
const pending = new Map()
let lastId = 1000
let mcp = null
const ask = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++lastId
    pending.set(id, { resolve, reject })
    write({ id, method, params })
  })

const callTool = async (name, args) => {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  for (const header of mcp.headers) headers[header.name] = header.value
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  const response = await fetch(mcp.url, { method: 'POST', headers, body })
  const reply = await response.json()
  if (reply.error) throw new Error(reply.error.message)
  return reply.result
}

const prompt = async ({ sessionId, prompt }) => {
  const text = prompt.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  const asks = /ASK (\d+)/.exec(text)
  const shot = /SHOT (\{[^\n]*\})/.exec(text)
  if (asks) {
    for (let i = 1; i <= Number(asks[1]); i++) {
      const toolCall = { toolCallId: 'run-' + i, title: 'npm run step-' + i, kind: 'execute', status: 'pending' }
      write({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', ...toolCall } } })
      const { outcome } = await ask('session/request_permission', { sessionId, toolCall, options: OPTIONS })
      appendFileSync(log, JSON.stringify({ toolCallId: toolCall.toolCallId, outcome }) + '\n')
    }
  } else if (shot) {
    const result = await callTool('preview_screenshot', JSON.parse(shot[1]))
    const image = result.content.find((item) => item.type === 'image')
    const png = Buffer.from(image ? image.data : '', 'base64')
    const size = png.length > 24 ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } : null
    say(sessionId, JSON.stringify(size))
  } else {
    say(sessionId, 'OK')
  }
  return { stopReason: 'end_turn' }
}

const handle = (message) => {
  const { id, method, params } = message
  if (method === undefined) {
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
    return
  }
  if (id === undefined) return
  if (method === 'initialize') {
    const agentCapabilities = { mcpCapabilities: { http: true } }
    return write({ id, result: { protocolVersion: 1, agentCapabilities, authMethods: [] } })
  }
  if (method === 'session/new') {
    mcp = (params.mcpServers || []).find((server) => server.url) || null
    return write({ id, result: { sessionId: 'session-' + process.pid, configOptions: configOptions() } })
  }
  if (method === 'session/set_config_option') {
    state[params.configId] = params.value
    return write({ id, result: { configOptions: configOptions() } })
  }
  if (method === 'session/prompt') {
    prompt(params).then(
      (result) => write({ id, result }),
      (error) => write({ id, error: { code: -32603, message: error.message } }),
    )
    return
  }
  write({ id, error: { code: -32601, message: 'Method not found' } })
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    if (line) handle(JSON.parse(line))
  }
})
`

interface Outcome {
  toolCallId: string
  outcome: { outcome: string; optionId?: string }
}

/**
 * Adds the stand-in to agents.json, waits for Gui to list it, selects it once the project is
 * open, and waits for its models. Returns how it was answered so far.
 */
async function useStandIn(session: GuiSession) {
  const { base, userData } = session.fixture
  const log = join(base, 'shortcut-answers.ndjson')
  const script = join(base, 'shortcuts-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  const agents = {
    Shortcuts: {
      command: electronExecutable(),
      args: [script, log],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
  }
  writeFileSync(join(userData, 'agents.json'), JSON.stringify(agents))
  await session.chrome.evaluate(() => window.gui.checkAgents())
  const listed = async () => (await session.state()).agents.some((agent) => agent.id === AGENT)
  await waitFor(listed, 'the stand-in agent to be listed')
  await waitFor(async () => (await session.state()).project !== null, 'the project to open')
  await session.chrome.evaluate((id) => window.gui.setAgent(id), AGENT)
  await waitFor(
    async () => (await session.chatSnapshot()).meta.models?.model.id === 'llm',
    "the stand-in's models",
  )
  return (): Outcome[] => {
    if (!existsSync(log)) return []
    return readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Outcome)
  }
}

/** Sends `text` and returns what the stand-in answered once its turn ended. */
async function ask(session: GuiSession, text: string) {
  const index = (await session.chatSnapshot()).turns.length
  expect(await session.chat.evaluate((message) => window.gui.send(message), text)).toBe(true)
  const { turn } = await session.waitForTurn(index)
  expect(turn.status, turn.error ?? '').toBe('done')
  return turn.items.flatMap((item) => (item.kind === 'text' ? [item.text] : [])).join('')
}

type PermissionCard = Extract<TurnItem, { kind: 'permission' }>

/**
 * Waits for the unanswered card asking about `toolCallId`'s step, in the last turn, and for
 * the chat panel to show it: its keys answer only a card the panel has.
 */
async function waitingCard(session: GuiSession, title: string) {
  const waiting = await waitFor(async () => {
    const turn = (await session.chatSnapshot()).turns.at(-1)
    const card = turn?.items.find(
      (item): item is PermissionCard =>
        item.kind === 'permission' && item.title === title && item.resolved === null,
    )
    return turn && card ? { turnId: turn.id, card } : null
  }, `a card for "${title}"`)
  await expect(session.chat.getByRole('region', { name: 'Run a command?' })).toContainText(title)
  return waiting
}

/** Waits for the stand-in to have been answered `count` times, and returns the answers. */
function answered(outcomes: () => Outcome[], count: number) {
  return waitFor(() => {
    const all = outcomes()
    return all.length >= count ? all : null
  }, `${count} answers`)
}

test('every shortcut in the registry is in the app menu, and ⌘/ lists them all', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  await session.app.evaluate(setContentSize, WINDOW)
  const entries = await session.app.evaluate(menuEntries)

  // Each shortcut's item, with its keys; its other keys on hidden items that still work. (A
  // page's own key, like the terminal's ⌘K, has none.)
  for (const shortcut of allShortcuts()) {
    if (shortcut.menu === null) {
      expect(entries.filter((entry) => entry.label === shortcut.label)).toEqual([])
      continue
    }
    const shown = entries.filter(
      (entry) => entry.label === shortcut.label && entry.visible && entry.accelerator !== null,
    )
    expect(
      shown.map((entry) => entry.accelerator),
      shortcut.id,
    ).toEqual([shortcut.accelerator])
    for (const keys of shortcut.alternates ?? []) {
      const hidden = entries.find(
        (entry) => entry.label === shortcut.label && entry.accelerator === keys,
      )
      expect(hidden, `${shortcut.id} on ${keys}`).toMatchObject({
        visible: false,
        worksHidden: true,
      })
    }
  }
  // No two items share keys.
  const keys = entries.flatMap((entry) => entry.accelerator ?? [])
  expect(keys.filter((key, i) => keys.indexOf(key) !== i)).toEqual([])
  // The Help menu is macOS's (with its search field), and has the sheet.
  expect(entries.find((entry) => entry.label === 'Help' && entry.menu === '')?.role).toBe('help')
  expect(entries.find((entry) => entry.label === 'Keyboard Shortcuts')?.menu).toBe('Help')

  // Help → Keyboard Shortcuts: a modal sheet over the window, with every shortcut by group.
  await clickMenu(session, 'Keyboard Shortcuts')
  const sheet = session.chrome.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await expect(sheet).toBeVisible()
  // The preview and chat are views over the chrome: they step aside while it's open.
  await waitFor(async () => {
    const layout = await session.app.evaluate(views)
    return layout && !layout.preview.visible && !layout.chat?.visible
  }, 'the preview and chat hidden under the sheet')
  const headings = sheet.getByRole('heading', { level: 3 })
  await expect(headings).toHaveText(SHORTCUT_GROUPS.map((group) => group.name))
  const rows = sheet.getByRole('listitem')
  await expect(rows).toHaveCount(allShortcuts().length)
  for (const shortcut of allShortcuts()) {
    const description = session.chrome.getByText(shortcut.description, { exact: true })
    const row = rows.filter({ has: description })
    await expect(row, shortcut.id).toHaveCount(1)
    await expect(row.locator('kbd kbd').first()).toHaveText(
      acceleratorKeys(shortcut.accelerator)[0] ?? '',
    )
    await expect(row).toContainText(acceleratorKeys(shortcut.accelerator).join(''))
    for (const keys of shortcut.alternates ?? []) {
      await expect(row).toContainText(`or${acceleratorKeys(keys).join('')}`)
    }
  }
  await session.shot('shortcuts-light')
  // Its body scrolls, under its header, when the window's too short for it.
  const overflow = await sheet.evaluate((dialog) => ({
    fits: dialog.getBoundingClientRect().bottom <= window.innerHeight,
    scrolls: [...dialog.children].some((child) => child.scrollHeight > child.clientHeight),
    // Its scrolling body has the keyboard, so the arrow keys scroll it.
    focused: [...dialog.children].some(
      (child) => child === document.activeElement && child.scrollHeight > child.clientHeight,
    ),
  }))
  expect(overflow).toEqual({ fits: true, scrolls: true, focused: true })
  // The arrow keys scroll it, under its title.
  await session.chrome.keyboard.press('End')
  await waitFor(
    () => sheet.evaluate((dialog) => [...dialog.children].some((child) => child.scrollTop > 0)),
    'the sheet to scroll',
  )
  await expect(sheet.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeInViewport()
  await expect(sheet.getByText(shortcut('nextTab').description, { exact: true })).toBeInViewport()
  await session.shot('shortcuts-light-scrolled')
  await session.chrome.keyboard.press('Home')

  // Dark: the tokens switch with the appearance.
  await session.chrome.emulateMedia({ colorScheme: 'dark' })
  const background = await sheet.evaluate((dialog) => getComputedStyle(dialog).backgroundColor)
  expect(background).toBe('rgb(32, 32, 35)')
  await session.shot('shortcuts-dark')
  await session.chrome.emulateMedia({ colorScheme: 'light' })

  // Esc closes it, and the preview and chat come back.
  await session.chrome.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  expect((await session.state()).shortcutsOpen).toBe(false)
  await waitFor(async () => {
    const layout = await session.app.evaluate(views)
    return layout?.preview.visible && layout.chat?.visible
  }, 'the preview and chat back')
  // ⌘/ again closes it too.
  await clickMenu(session, 'Keyboard Shortcuts')
  await expect(sheet).toBeVisible()
  await clickMenu(session, 'Keyboard Shortcuts')
  await expect(sheet).toHaveCount(0)

  // Controls name their shortcut, from the same registry.
  const toolbar = session.chrome.getByRole('banner')
  const controls: [string, ShortcutId][] = [
    ['Back', 'back'],
    ['Reload preview', 'reload'],
    ['Screenshot', 'screenshot'],
    ['Toggle chat', 'toggleChat'],
  ]
  for (const [name, id] of controls) {
    const control = toolbar.getByRole('button', { name, exact: true })
    await expect(control).toHaveAttribute('title', `${name} (${shortcutText(id)})`)
    await expect(control).toHaveAttribute('aria-keyshortcuts', ariaShortcut(id))
  }
  await expect(toolbar.getByLabel('App address')).toHaveAttribute(
    'aria-keyshortcuts',
    'Shift+Meta+L',
  )
  const newChat = session.chat.getByRole('button', { name: 'New chat', exact: true })
  await expect(newChat).toHaveAttribute('aria-keyshortcuts', 'Shift+Meta+K')
  // Send is the message box's own ↩ (a page key, so no menu item), named on its button.
  const send = session.chat.getByRole('button', { name: 'Send', exact: true })
  await expect(send).toHaveAttribute('title', `Send (${shortcutText('send')})`)
  await expect(send).toHaveAttribute('aria-keyshortcuts', 'Enter')

  // Select Element is ⌘D, shown in the menu and tooltips; ⇧⌘C still works, as a hidden item.
  const select = entries.filter((entry) => entry.label === 'Select Element')
  expect(select.map(({ accelerator, visible }) => ({ accelerator, visible }))).toEqual([
    { accelerator: 'CmdOrCtrl+D', visible: true },
    { accelerator: 'Shift+CmdOrCtrl+C', visible: false },
  ])
  const selectToggle = toolbar.getByRole('button', { name: 'Select element', exact: true })
  await expect(selectToggle).toHaveAttribute('title', 'Select element (⌘D)')
  await expect(selectToggle).toHaveAttribute('aria-keyshortcuts', 'Meta+D Shift+Meta+C')
  // ⌘D is the app's even in a text field: nothing there uses it, so it goes on to the menu
  // (and ⇧⌘D, Dock Chat, is another key; the menu check above found no key used twice).
  const passesThrough = async (field: Locator, page: Page) => {
    await field.fill('keep this')
    await page.evaluate(() => {
      const record = (event: KeyboardEvent) => {
        Object.assign(window, { guiPrevented: event.defaultPrevented })
      }
      window.addEventListener('keydown', record, { once: true })
    })
    await field.press('Meta+d')
    await expect(field).toHaveValue('keep this')
    expect(
      await page.evaluate(() => (window as unknown as { guiPrevented?: boolean }).guiPrevented),
    ).toBe(false)
    await field.fill('')
  }
  await passesThrough(toolbar.getByLabel('App address'), session.chrome)
  await session.chrome.keyboard.press('Escape')
  await passesThrough(session.chat.getByRole('textbox', { name: /^Message / }), session.chat)
})

test('⇧⌘L focuses the address, ⇧⌘R reloads around the cache, ⇧⌘S opens the screenshot menu', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const { preview } = await session.waitForPreview()
  await session.app.evaluate(setContentSize, WINDOW)

  // View → Focus Address Bar: the field, its address selected, ready to type over.
  await session.chat.getByRole('textbox').focus()
  await clickMenu(session, 'Focus Address Bar')
  const address = session.chrome.getByLabel('App address')
  await expect(address).toBeFocused()
  const selection = await address.evaluate((field: HTMLInputElement) => ({
    start: field.selectionStart,
    end: field.selectionEnd,
    length: field.value.length,
  }))
  expect(selection).toEqual({ start: 0, end: preview.url?.length ?? 0, length: selection.end })
  await session.chrome.keyboard.press('Escape')

  // View → Hard Reload Preview: the page comes back without the cache; Reload revalidates.
  // The headers Chromium sends, read over the preview's DevTools session (the cache adds
  // them after anything Electron's webRequest sees).
  await session.app.evaluate(async ({ webContents }) => {
    const wc = webContents.getAllWebContents().find((w) => /^https?:\/\//.test(w.getURL()))
    if (!wc) throw new Error('No preview')
    const store = globalThis as unknown as CacheStore
    store.guiDocuments = []
    store.guiSent = {}
    wc.debugger.on('message', (_event, method, params) => {
      if (method === 'Network.requestWillBeSent' && params.type === 'Document') {
        store.guiDocuments?.push(params.requestId)
      } else if (method === 'Network.requestWillBeSentExtraInfo') {
        const headers = params.headers as Record<string, string>
        const name = Object.keys(headers).find((key) => key.toLowerCase() === 'cache-control')
        if (store.guiSent) store.guiSent[params.requestId] = name ? (headers[name] ?? '') : ''
      }
    })
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
    await wc.debugger.sendCommand('Network.enable')
  })
  const page = await session.previewPage()
  const reloaded = async (label: string) => {
    await page.evaluate(() => Object.assign(window, { guiMarker: true }))
    await clickMenu(session, label)
    await waitFor(
      () => page.evaluate(() => !('guiMarker' in window)).catch(() => false),
      `${label} to reload the page`,
    )
  }
  await reloaded('Hard Reload Preview')
  await reloaded('Reload Preview')
  const cacheControl = await session.app.evaluate(() => {
    const { guiDocuments = [], guiSent = {} } = globalThis as unknown as CacheStore
    return guiDocuments.map((id) => guiSent[id] ?? null)
  })
  expect(cacheControl).toEqual(['no-cache', 'max-age=0'])

  // View → Screenshot…: the toolbar's menu, under its button (answered here: no test can
  // click a native menu). Choosing Copy shows the button's check.
  await session.app.evaluate(({ Menu, clipboard }) => {
    const store = globalThis as unknown as { guiPopups?: { x?: number; y?: number }[] }
    store.guiPopups = []
    clipboard.write = async () => undefined
    const build = Menu.buildFromTemplate.bind(Menu)
    Menu.buildFromTemplate = (template) => {
      const menu = build(template)
      if (!menu.items.some((item) => item.label === 'Copy Screenshot')) return menu
      menu.popup = (options) => {
        store.guiPopups?.push({ x: options?.x, y: options?.y })
        menu.items.find((item) => item.label === 'Copy Screenshot')?.click()
        options?.callback?.()
      }
      return menu
    }
  })
  await clickMenu(session, 'Screenshot…')
  const button = session.chrome.getByRole('banner').getByRole('button', { name: 'Screenshot' })
  await expect(button).toHaveAttribute('title', 'Copied')
  const box = await button.boundingBox()
  if (!box) throw new Error('The screenshot button has no box')
  const popups = await session.app.evaluate(
    () => (globalThis as unknown as { guiPopups?: { x?: number; y?: number }[] }).guiPopups,
  )
  expect(popups).toEqual([{ x: Math.round(box.x), y: Math.round(box.y + box.height + 4) }])
})

test('⇧⌘M shows the chat and opens the model picker, searching', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await useStandIn(session)
  await session.app.evaluate(setContentSize, WINDOW)
  const { chat } = session
  const picker = chat.getByRole('dialog', { name: 'Choose a model' })
  const search = picker.getByRole('combobox', { name: 'Search models' })

  // From a hidden chat: it shows, the picker opens, and typing searches.
  await session.chrome.evaluate(() => window.gui.toggleChat())
  await waitFor(async () => !(await session.state()).chatVisible, 'the chat to hide')
  await clickMenu(session, 'Choose Model…')
  await waitFor(async () => (await session.state()).chatVisible, 'the chat to show')
  await expect(picker).toBeVisible()
  await expect(search).toBeFocused()
  await chat.keyboard.type('orb')
  await expect(picker.getByRole('option')).toHaveText(['Orbit'])
  await chat.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)

  // From the minimized pill, too.
  await chat.evaluate(() => window.gui.setMinimized(true))
  await waitFor(async () => (await session.chatSnapshot()).meta.minimized, 'the chat minimized')
  await clickMenu(session, 'Choose Model…')
  await expect(picker).toBeVisible()
  await expect(search).toBeFocused()
  expect((await session.chatSnapshot()).meta.minimized).toBe(false)
  const button = chat.getByRole('button', { name: /^Model: / })
  await expect(button).toHaveAttribute('aria-keyshortcuts', 'Shift+Meta+M')
})

test('⌘↩ and ⌘⌫ answer the waiting card once, never with Always, and not under the PR sheet', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  const outcomes = await useStandIn(session)
  await session.app.evaluate(setContentSize, WINDOW)
  const { chat } = session
  // Ask: every request waits for the user.
  await chat.evaluate(() => window.gui.setAutoApprove(false))
  await waitFor(async () => !(await session.chatSnapshot()).meta.autoApprove, 'Ask mode')
  const composer = chat.getByRole('textbox', { name: /^Message / })
  const keys = async () => ({
    allow: (await session.app.evaluate(menuItem, 'allow'))?.enabled,
    dontAllow: (await session.app.evaluate(menuItem, 'dont-allow'))?.enabled,
  })

  // No card: Agent → Allow and Don't Allow are off, and their keys do nothing.
  expect(await keys()).toEqual({ allow: false, dontAllow: false })
  await clickMenu(session, 'Allow')
  await composer.focus()
  await chat.keyboard.press('Meta+Backspace')
  expect((await session.chatSnapshot()).turns).toHaveLength(0)

  expect(await chat.evaluate(() => window.gui.send('ASK 4'))).toBe(true)
  const first = await waitingCard(session, 'npm run step-1')
  await waitFor(async () => (await keys()).allow && (await keys()).dontAllow, 'Allow on')
  // The card shows its keys; Always allow has none.
  const card = chat.getByRole('region', { name: 'Run a command?' })
  const allow = card.getByRole('button', { name: /^Allow/ })
  await expect(allow).toHaveAttribute('aria-keyshortcuts', 'Meta+Enter')
  await expect(allow).toContainText('⌘↩')
  await expect(card.getByRole('button', { name: /^Don't allow/ })).toContainText('⌘⌫')
  await expect(card.getByRole('button', { name: /^Always allow/ })).not.toHaveAttribute(
    'aria-keyshortcuts',
  )
  await session.shot('permission-keys')

  // The PR sheet has ⌘↩ while it's open: the card waits.
  await chooseFromChatMenu(session.app, chat, 'Source Control…')
  await expect(chat.getByRole('button', { name: 'Back to chat' }).first()).toBeVisible()
  await waitFor(async () => !(await keys()).allow, 'Allow off under the sheet')
  expect(await keys()).toEqual({ allow: false, dontAllow: false })
  await chat.keyboard.press('Meta+Enter')
  await chat.keyboard.press('Meta+Backspace')
  await clickMenu(session, 'Allow')
  await sleep(500)
  expect(outcomes()).toEqual([])
  await chat.getByRole('button', { name: 'Back to chat' }).first().click()
  await waitFor(async () => (await keys()).allow, 'Allow back on')

  // Agent → Allow: its Allow, not Always allow.
  await clickMenu(session, 'Allow')
  expect((await answered(outcomes, 1))[0]).toEqual({
    toolCallId: 'run-1',
    outcome: { outcome: 'selected', optionId: 'allow' },
  })
  const answeredFirst = (await session.chatSnapshot()).turns[0]?.items.find(
    (item) => item.id === first.card.id,
  )
  expect(answeredFirst).toMatchObject({ resolved: 'allow' })

  // ⌘⌫ in the composer with text deletes it; empty, it answers Don't allow.
  await waitingCard(session, 'npm run step-2')
  await composer.fill('scratch that')
  await composer.press('Meta+Backspace')
  await expect(composer).toHaveValue('')
  await sleep(300)
  expect(outcomes()).toHaveLength(1)
  await composer.press('Meta+Backspace')
  expect((await answered(outcomes, 2))[1]?.outcome).toEqual({
    outcome: 'selected',
    optionId: 'reject',
  })

  // ⌘↩ with a draft answers Allow, and the draft stays unsent.
  await waitingCard(session, 'npm run step-3')
  await composer.fill('next, the header')
  await composer.press('Meta+Enter')
  expect((await answered(outcomes, 3))[2]?.outcome.optionId).toBe('allow')
  await expect(composer).toHaveValue('next, the header')
  expect((await session.chatSnapshot()).meta.queue).toEqual([])

  // Agent → Don't Allow, from the menu (or the key outside the chat).
  await waitingCard(session, 'npm run step-4')
  await clickMenu(session, "Don't Allow")
  expect((await answered(outcomes, 4))[3]?.outcome.optionId).toBe('reject')
  await session.waitForTurn(0)
  await waitFor(async () => !(await keys()).allow, 'Allow off again')
  expect(outcomes()).toHaveLength(4)
})

test('in a terminal, ⌘D and ⌘↩ go on to the app, and ⌘⌫ deletes the line, never answering', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', env: SHELL })
  await session.declineConsentDialogs()
  const outcomes = await useStandIn(session)
  await session.app.evaluate(setContentSize, WINDOW)
  await session.chat.evaluate(() => window.gui.setAutoApprove(false))
  await waitFor(async () => !(await session.chatSnapshot()).meta.autoApprove, 'Ask mode')
  expect(await session.chat.evaluate(() => window.gui.send('ASK 1'))).toBe(true)
  await waitingCard(session, 'npm run step-1')

  // View → Show or Hide Terminal: a terminal, with the keyboard in it.
  await clickMenu(session, 'Show or Hide Terminal')
  const { drawer } = await waitFor(async () => {
    const state = await session.state()
    return state.drawer.terminals.length === 1 ? state : null
  }, 'a terminal')
  const id = drawer.terminals[0]?.id
  if (!id) throw new Error('No terminal')
  await waitFor(
    () =>
      session.chrome.evaluate(
        () => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false,
      ),
    'the keyboard in the terminal',
  )
  const output = () =>
    session.chrome.evaluate(async (terminal) => (await window.gui.getTerminal(terminal)).data, id)
  await session.chrome.keyboard.type(' echo ready-$((1+1))')
  await session.chrome.keyboard.press('Enter')
  await waitFor(async () => /ready-2/.test(await output()), 'the shell')

  // Which ⌘ keys the page handled: those it did never reach the app menu.
  await session.chrome.evaluate(() => {
    const keys: { key: string; handled: boolean }[] = []
    Object.assign(window, { guiKeys: keys })
    window.addEventListener('keydown', (event) => {
      if (event.metaKey && event.key !== 'Meta') {
        keys.push({ key: event.key, handled: event.defaultPrevented })
      }
    })
  })
  // A line typed, then ⌘D (Select Element), ⌘↩ (Allow) and ⌘⌫ (here, the line).
  await session.chrome.keyboard.type(' echo stray-$((3+4))')
  await session.chrome.keyboard.press('Meta+d')
  await session.chrome.keyboard.press('Meta+Enter')
  await session.chrome.keyboard.press('Meta+Backspace')
  const keys = await session.chrome.evaluate(
    () => (window as unknown as { guiKeys: { key: string; handled: boolean }[] }).guiKeys,
  )
  expect(keys).toEqual([
    { key: 'd', handled: false },
    { key: 'Enter', handled: false },
    { key: 'Backspace', handled: true },
  ])
  // ⌘↩ wasn't a Return for the shell, and ⌘⌫ deleted the line: only this runs.
  await session.chrome.keyboard.type(' echo kept-$((5+6))')
  await session.chrome.keyboard.press('Enter')
  await waitFor(async () => /kept-11/.test(await output()), 'the next command')
  expect(await output()).not.toMatch(/stray-7/)
  expect(outcomes()).toEqual([])

  // The card waits for its answer; the app's ⌘↩, Agent → Allow, gives it.
  await clickMenu(session, 'Allow')
  expect((await answered(outcomes, 1))[0]?.outcome.optionId).toBe('allow')
})

test('zoom steps a device frame from 25% to fit and zooms the desktop page, per viewport', async ({
  launch,
}) => {
  // These assertions compare settled geometry; animated handoffs have separate motion specs.
  const session = await launch({ fixture: 'vite', reducedMotion: 'reduce' })
  await session.waitForPreview()
  await session.app.evaluate(setContentSize, WINDOW)
  await clickMenu(session, 'Laptop Viewport')
  const laptop = viewportSpec('laptop').size ?? { width: 0, height: 0 }
  const fitted = await waitFor(async () => {
    const { frame } = (await session.state()).preview
    const page = await session.app.evaluate(pageSize)
    return frame && page?.width === laptop.width ? frame : null
  }, 'the laptop frame')
  const fit = fitted.scale
  expect(fit).toBeLessThan(1)
  const levels = ZOOM_LEVELS.filter((level) => level < fit - 0.001)

  // Zoom Out: each level down to 25%, and no further. The page keeps its CSS size.
  for (const level of [...levels].reverse()) {
    await clickMenu(session, 'Zoom Out')
    await zoomIs(session, level, `the frame at ${level}`)
  }
  await clickMenu(session, 'Zoom Out')
  await sleep(300)
  await zoomIs(session, 0.25, 'the frame still at 25%')
  await expect.poll(() => session.app.evaluate(pageSize)).toEqual(laptop)
  await expect(frameLabel(session)).toHaveText(`Laptop · 1440 × 900 · 25%`)
  const small = await session.app.evaluate(views)
  expect(small?.preview.width).toBe(Math.round(1440 * 0.25))

  // Zoom In: back up to the largest that fits, never past it (or needing to scroll).
  for (const level of levels.slice(1)) {
    await clickMenu(session, 'Zoom In')
    await zoomIs(session, level, `the frame at ${level}`)
  }
  await clickMenu(session, 'Zoom In')
  await zoomIs(session, fit, 'the frame fitting')
  await clickMenu(session, 'Zoom In')
  await sleep(300)
  await zoomIs(session, fit, 'the frame still fitting')

  // Actual Size fits it again after zooming out.
  await clickMenu(session, 'Zoom Out')
  await clickMenu(session, 'Zoom Out')
  const zoomed = levels.at(-2) ?? 0.25
  await zoomIs(session, zoomed, 'the frame two levels down')
  await session.shot('zoomed-frame')
  await clickMenu(session, 'Actual Size')
  await zoomIs(session, fit, 'the frame fitting after Actual Size')
  await clickMenu(session, 'Zoom Out')
  const remembered = levels.at(-1) ?? 0.25
  await zoomIs(session, remembered, 'the laptop zoomed out')

  // Desktop: the page zooms like a browser's. The field says how much; its button resets it.
  await clickMenu(session, 'Desktop Viewport')
  const address = session.chrome.getByRole('banner')
  const reset = address.getByRole('button', { name: /^Zoom \d+%/ })
  await expect(reset).toHaveCount(0)
  for (const level of [1.1, 1.25, 1.5]) {
    await clickMenu(session, 'Zoom In')
    await zoomIs(session, level, `the page at ${level}`)
  }
  expect((await session.state()).preview.frame).toBeNull()
  const desktop = await waitFor(async () => {
    const layout = await session.app.evaluate(views)
    const page = await session.app.evaluate(pageSize)
    if (!layout || !page) return null
    return Math.abs(page.width - layout.preview.width / 1.5) <= 1 ? { layout, page } : null
  }, 'the page laid out at 150%')
  expect(Math.abs(desktop.page.height - desktop.layout.preview.height / 1.5)).toBeLessThanOrEqual(1)
  await expect(reset).toHaveText('150%')
  await expect(reset).toHaveAttribute('aria-keyshortcuts', 'Meta+0')
  const viewports = address.getByRole('group', { name: 'Viewport' }).getByRole('button')
  await expect(viewports.first()).toHaveAttribute('aria-pressed', 'true')
  await session.shot('zoomed-desktop')

  // Each viewport keeps its own zoom.
  await clickMenu(session, 'Laptop Viewport')
  await zoomIs(session, remembered, 'the laptop as it was')
  await clickMenu(session, 'Desktop Viewport')
  await zoomIs(session, 1.5, 'the desktop as it was')

  // Back to 100% from the field; then out, below it.
  await reset.click()
  await zoomIs(session, 1, 'the page at 100%')
  await expect(reset).toHaveCount(0)
  await waitFor(async () => {
    const layout = await session.app.evaluate(views)
    const page = await session.app.evaluate(pageSize)
    return layout && page?.width === layout.preview.width
  }, 'the page at the view size')
  await clickMenu(session, 'Zoom Out')
  await zoomIs(session, 0.9, 'the page at 90%')
  await expect(reset).toHaveText('90%')
})

test('at any zoom a pick finds the element, and the agent sees the page at its CSS size', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', reducedMotion: 'reduce' })
  await useStandIn(session)
  await session.waitForPreview()
  await session.app.evaluate(setContentSize, WINDOW)
  const dpr = await (await session.previewPage()).evaluate(() => devicePixelRatio)

  // Desktop at 150%: the page is drawn larger; picking where it's drawn finds the button.
  for (let i = 0; i < 3; i++) await clickMenu(session, 'Zoom In')
  await zoomIs(session, 1.5, 'the page at 150%')
  const page = await waitFor(async () => {
    const layout = await session.app.evaluate(views)
    const size = await session.app.evaluate(pageSize)
    return layout && size && Math.abs(size.width - layout.preview.width / 1.5) <= 1 ? size : null
  }, 'the page laid out at 150%')
  const box = await counterBox(session)
  const picked = await pickAt(session, {
    x: (box.x + box.width / 2) * 1.5,
    y: (box.y + box.height / 2) * 1.5,
  })
  expect(picked.tag).toBe('button')
  expect(picked.text).toContain('count is')
  expect(picked.viewport).toEqual(page)
  expect(picked.rect.x).toBeCloseTo(box.x, 1)
  // Its crop is the button and its margin, drawn at 150%.
  const crop = picked.crop
  if (!crop || !picked.screenshot) throw new Error('The pick has no crop')
  const cropWidth = await session.chrome.evaluate(async (url) => {
    const image = new Image()
    image.src = url
    await image.decode()
    return image.naturalWidth
  }, picked.screenshot)
  expect(Math.abs(cropWidth - Math.min(1200, crop.area.width * 1.5 * dpr))).toBeLessThanOrEqual(2)

  // The agent's screenshot is the page at its CSS size, whatever the zoom.
  const fitted = Math.min(1, 1600 / (page.width * dpr), 1960 / (page.height * dpr))
  const shot = JSON.parse(await ask(session, 'SHOT {}')) as Size
  expect(shot.width).toBe(Math.round(page.width * fitted * dpr))
  expect(shot.height).toBe(Math.round(page.height * fitted * dpr))
  await zoomIs(session, 1.5, 'the zoom kept after the screenshot')

  // A zoomed-out device frame: the pick lands on the button where it's drawn.
  await clickMenu(session, 'Mobile Viewport')
  await waitFor(async () => (await session.state()).preview.frame, 'the mobile frame')
  await clickMenu(session, 'Zoom Out')
  await clickMenu(session, 'Zoom Out')
  const { frame } = await waitFor(async () => {
    const { preview } = await session.state()
    const size = await session.app.evaluate(pageSize)
    return preview.frame && size?.width === 390 ? preview : null
  }, 'the mobile frame zoomed out')
  if (!frame) throw new Error('No frame')
  const phone = await counterBox(session)
  const tapped = await pickAt(session, {
    x: (phone.x + phone.width / 2) * frame.scale,
    y: (phone.y + phone.height / 2) * frame.scale,
  })
  expect(tapped.tag).toBe('button')
  expect(tapped.viewport).toEqual({ width: 390, height: 844 })
  const mobile = JSON.parse(await ask(session, 'SHOT {}')) as Size
  const mobileFit = Math.min(1, 1600 / (390 * dpr), 1960 / (844 * dpr))
  expect(mobile.width).toBe(Math.round(390 * mobileFit * dpr))
})

test('focus mode shows only the preview, and Esc or ⌘\\ brings back what was showing', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  await session.app.evaluate(setContentSize, WINDOW)
  // What should come back: the drawer open on the logs, the floating chat showing.
  await session.chrome.evaluate(() => window.gui.showLogs())
  await waitFor(async () => (await session.state()).drawer.open, 'the logs open')
  const logsTab = session.chrome.getByRole('tab', { name: 'Dev server', selected: true })
  const before = await waitFor(async () => {
    const layout = await session.app.evaluate(views)
    const canvas = await canvasHeight(session)
    return layout?.chat?.visible && layout.preview.height === canvas ? layout : null
  }, 'the chat showing, and the preview above the logs')
  const toolbar = session.chrome.getByRole('banner')

  // View → Focus Mode: the preview fills the window under a slim bar with the traffic lights.
  await clickMenu(session, 'Focus Mode')
  await waitFor(async () => (await session.state()).focusMode, 'focus mode')
  const focused = await waitFor(async () => {
    const layout = await session.app.evaluate(views)
    const { preview } = layout ?? {}
    return preview && preview.y === FOCUS_BAR && !layout?.chat?.visible ? layout : null
  }, 'the preview filling the window')
  expect(focused.preview).toMatchObject({
    x: 0,
    y: FOCUS_BAR,
    width: focused.content.width,
    height: focused.content.height - FOCUS_BAR,
    visible: true,
  })
  expect(focused.lights).toEqual(FOCUS_LIGHTS)
  await expect(logsTab).toBeHidden()
  await expect(toolbar).toHaveCount(1)
  const bar = session.chrome.locator('header.drag').first()
  await expect(bar).toContainText('gui-e2e-vite')
  const exit = bar.getByRole('button', { name: /^Exit focus mode/ })
  await expect(exit).toHaveAttribute('aria-keyshortcuts', 'Meta+\\')
  expect((await session.app.evaluate(menuItem, 'focus-mode'))?.checked).toBe(true)
  await session.shot('focus-mode')

  // The screenshot menu comes up at the pointer: its button is hidden.
  await session.app.evaluate(({ Menu }) => {
    const store = globalThis as unknown as { guiPopups?: { x?: number }[] }
    store.guiPopups = []
    const build = Menu.buildFromTemplate.bind(Menu)
    Menu.buildFromTemplate = (template) => {
      const menu = build(template)
      if (!menu.items.some((item) => item.label === 'Copy Screenshot')) return menu
      menu.popup = (options) => {
        store.guiPopups?.push({ x: options?.x })
        options?.callback?.()
      }
      return menu
    }
  })
  await clickMenu(session, 'Screenshot…')
  await waitFor(
    () =>
      session.app.evaluate(
        () => (globalThis as unknown as { guiPopups?: unknown[] }).guiPopups?.length === 1,
      ),
    'the screenshot menu',
  )
  expect(
    await session.app.evaluate(
      () => (globalThis as unknown as { guiPopups?: { x?: number }[] }).guiPopups?.[0]?.x,
    ),
  ).toBeUndefined()
  expect((await session.state()).focusMode).toBe(true)

  // Esc on the page ends it; everything is back as it was. (Real input: main sees the key
  // before the page, which Playwright's protocol keys skip.)
  await session.app.evaluate(({ webContents }) => {
    const preview = webContents.getAllWebContents().find((wc) => /^https?:\/\//.test(wc.getURL()))
    preview?.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    preview?.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  })
  await waitFor(async () => !(await session.state()).focusMode, 'focus mode to end')
  const after = await waitFor(async () => {
    const layout = await session.app.evaluate(views)
    return layout?.chat?.visible && layout.preview.y === before.preview.y ? layout : null
  }, 'the chat and toolbar back')
  expect(after.preview).toEqual(before.preview)
  expect(after.chat).toEqual(before.chat)
  expect(after.lights).toEqual(before.lights)
  expect((await session.state()).drawer).toMatchObject({ open: true, tab: 'server' })
  await expect(logsTab).toBeVisible()
  await expect(toolbar.getByLabel('App address')).toBeVisible()

  // ⌘\ toggles it; Esc in the chrome ends it too.
  await clickMenu(session, 'Focus Mode')
  await waitFor(async () => (await session.state()).focusMode, 'focus mode again')
  await clickMenu(session, 'Focus Mode')
  await waitFor(async () => !(await session.state()).focusMode, 'focus mode off from the menu')
  await clickMenu(session, 'Focus Mode')
  await waitFor(async () => (await session.state()).focusMode, 'focus mode once more')
  await session.chrome.keyboard.press('Escape')
  await waitFor(async () => !(await session.state()).focusMode, 'focus mode off from Esc')

  // ⌘J needs the drawer, hidden in focus mode whether or not it's open: it ends focus mode.
  await clickMenu(session, 'Focus Mode')
  await waitFor(async () => (await session.state()).focusMode, 'focus mode before ⌘J')
  await clickMenu(session, 'Show or Hide Terminal')
  await waitFor(async () => !(await session.state()).focusMode, '⌘J to end focus mode')
  expect((await session.state()).drawer).toMatchObject({ open: true, tab: 'server' })
  await expect(logsTab).toBeVisible()

  // Picking works in focus mode; the pick brings the chat (and the rest) back to describe it.
  await clickMenu(session, 'Focus Mode')
  await waitFor(async () => (await session.state()).focusMode, 'focus mode for a pick')
  const box = await counterBox(session)
  const picked = await pickAt(session, { x: box.x + box.width / 2, y: box.y + box.height / 2 })
  expect(picked.tag).toBe('button')
  await waitFor(async () => !(await session.state()).focusMode, 'the pick to end focus mode')
  // ⇧⌘L needs the toolbar: it ends focus mode too.
  await clickMenu(session, 'Focus Mode')
  await waitFor(async () => (await session.state()).focusMode, 'focus mode before ⇧⌘L')
  await clickMenu(session, 'Focus Address Bar')
  await waitFor(async () => !(await session.state()).focusMode, '⇧⌘L to end focus mode')
  await expect(toolbar.getByLabel('App address')).toBeFocused()
})
