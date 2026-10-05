import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { type AgentId, CUSTOM_AGENT_PREFIX, type PanelCorner, type Rect } from '../src/shared/types'
import { electronExecutable, sleep, TAKES_FOCUS, takesFocus, waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// While the user picks an element, the floating chat panel shrinks to a bubble at its
// anchored corner (bottom-right unless it was moved) so it doesn't cover the page, and comes
// back as it was afterwards.

/** What Playwright passes to `app.evaluate` callbacks. */
type ElectronModule = typeof import('electron/main')

/** Transparent margin around the floating panel's view (SHADOW in window.ts). */
const SHADOW = 18
/** Space the panel keeps from the canvas's edges in its corner (PANEL_MARGIN in tab.ts). */
const PANEL_MARGIN = 12
/** The bubble's view: the 44px bubble (BUBBLE in window.ts) and its shadow margin. */
const BUBBLE_VIEW = 44 + SHADOW * 2
/** The minimized pill's view height (MINI in window.ts). */
const PILL_VIEW_HEIGHT = 52 + SHADOW * 2
const SELECTOR = 'button.counter'

interface Views {
  chat: Rect
  chatVisible: boolean
  preview: Rect
}

/** Runs in main: the chat and preview views of the first window. */
function views({ BrowserWindow, WebContentsView }: ElectronModule): Views | null {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return null
  const children = win.contentView.children.filter(
    (child): child is InstanceType<typeof WebContentsView> => child instanceof WebContentsView,
  )
  const chat = children.find((view) => view.webContents.getURL().endsWith('/chat.html'))
  const preview = children.find((view) => /^https?:\/\//.test(view.webContents.getURL()))
  if (!chat || !preview) return null
  return { chat: chat.getBounds(), chatVisible: chat.getVisible(), preview: preview.getBounds() }
}

/**
 * Waits for the visible chat view's bounds to satisfy `check`, outside a morph of the preview's
 * layout (mid-morph the preview waits out of sight, off the window's left edge, and a docked
 * chat slides in).
 */
function chatWhere(session: GuiSession, label: string, check: (chat: Rect) => boolean) {
  return waitFor(async () => {
    const layout = await session.app.evaluate(views)
    const settled = layout !== null && layout.preview.x >= 0
    return settled && layout.chatVisible && check(layout.chat) ? layout : null
  }, label)
}

const isBubble = (chat: Rect) => chat.width === BUBBLE_VIEW && chat.height === BUBBLE_VIEW

const BOTTOM_LEFT: PanelCorner = { x: 'left', y: 'bottom' }
/** These start from the bottom-left corner (new windows default to the bottom-right). */
const BOTTOM_LEFT_PREFS = { chatCorner: BOTTOM_LEFT }

/** The bubble's view: in the anchored corner of where the panel's view is. */
const bubbleAt = (panel: Rect, corner = BOTTOM_LEFT): Rect => ({
  x: corner.x === 'left' ? panel.x : panel.x + panel.width - BUBBLE_VIEW,
  y: corner.y === 'top' ? panel.y : panel.y + panel.height - BUBBLE_VIEW,
  width: BUBBLE_VIEW,
  height: BUBBLE_VIEW,
})

/** The visible panel: its view without the shadow margin. */
const inner = (view: Rect): Rect => ({
  x: view.x + SHADOW,
  y: view.y + SHADOW,
  width: view.width - SHADOW * 2,
  height: view.height - SHADOW * 2,
})

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

async function selecting(session: GuiSession, on: boolean) {
  const label = on ? 'selection mode' : 'selection mode to end'
  await waitFor(async () => (await session.state()).preview.selecting === on, label)
}

async function startSelecting(session: GuiSession) {
  await session.chrome.evaluate(() => window.gui.toggleSelect())
  await selecting(session, true)
}

/** Esc in the preview, as the user ends picking. */
async function pressEscape(session: GuiSession) {
  await (await session.previewPage()).keyboard.press('Escape')
  await selecting(session, false)
}

const showChat = (chat: Page) => chat.getByRole('button', { name: 'Show chat' })

/** A shot once the bubble's pop-in has finished (GUI_E2E_SHOTS=1). */
async function shot(session: GuiSession, name: string) {
  await sleep(300)
  await session.shot(name)
}

test('the floating chat is a bubble while picking and comes back as it was', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', prefs: BOTTOM_LEFT_PREFS })
  await session.waitForPreview()
  const preview = await session.previewPage()
  await expect(preview.locator(SELECTOR)).toBeVisible({ timeout: 30_000 })
  const panel = await chatWhere(session, 'the floating panel', (chat) => !isBubble(chat))

  // Picking: the view shrinks to the bubble at the panel's bottom-left corner.
  await startSelecting(session)
  await chatWhere(session, 'the bubble', isBubble)
  expect((await session.app.evaluate(views))?.chat).toEqual(bubbleAt(panel.chat))
  await expect(showChat(session.chat)).toBeVisible()
  await expect(showChat(session.chat)).toHaveAccessibleDescription('Stops selecting.')
  await shot(session, 'bubble-idle')

  // The toolbar's chat button hides the bubble and brings it back without ending the pick.
  await session.chrome.evaluate(() => window.gui.toggleChat())
  await waitFor(async () => !(await session.app.evaluate(views))?.chatVisible, 'a hidden chat')
  await session.chrome.evaluate(() => window.gui.toggleChat())
  await chatWhere(session, 'the bubble again', isBubble)
  expect((await session.state()).preview.selecting).toBe(true)

  // Esc: back exactly as it was.
  await pressEscape(session)
  const restored = await chatWhere(session, 'the panel again', (chat) => !isBubble(chat))
  expect(restored.chat).toEqual(panel.chat)
  await expect(showChat(session.chat)).toHaveCount(0)
  await expect(session.chat.getByRole('button', { name: 'Minimize' })).toBeVisible()
  await shot(session, 'bubble-restored')

  // Over the element to pick: the bubble leaves it uncovered, then the panel moves aside.
  // The panel rests in a corner, so the element goes under it: in the page, at the middle of
  // the panel as the window draws it.
  const middle = {
    x: panel.chat.x + panel.chat.width / 2 - panel.preview.x,
    y: panel.chat.y + panel.chat.height / 2 - panel.preview.y,
  }
  await preview.evaluate(({ x, y }) => {
    const covered = document.createElement('button')
    covered.id = 'covered'
    covered.textContent = 'Covered'
    covered.style.cssText = `position:fixed;left:${x - 60}px;top:${y - 20}px;width:120px;height:40px`
    document.body.append(covered)
  }, middle)
  const box = await preview.locator('#covered').boundingBox()
  if (!box) throw new Error('"#covered" has no layout box')
  const element = { ...box, x: panel.preview.x + box.x, y: panel.preview.y + box.y }
  expect(overlaps(inner(panel.chat), element)).toBe(true)
  await startSelecting(session)
  await chatWhere(session, 'the bubble over the panel', isBubble)
  const bubble = await session.app.evaluate(views)
  expect(bubble?.chat).toEqual(bubbleAt(panel.chat))
  expect(overlaps(inner(bubble?.chat ?? panel.chat), element)).toBe(false)
  await pressEscape(session)

  // Picked, the panel springs to the far side of the canvas, keeping its height and size.
  const selection = await session.pickElement('#covered')
  expect(selection.tag).toBe('button')
  const dodged = await chatWhere(
    session,
    'the panel against the right edge',
    (chat) =>
      !isBubble(chat) &&
      chat.x + chat.width - SHADOW === panel.preview.x + panel.preview.width - PANEL_MARGIN,
  )
  expect(overlaps(inner(dodged.chat), element)).toBe(false)
  expect(dodged.chat.width).toBe(panel.chat.width)
  expect(dodged.chat.height).toBe(panel.chat.height)
  expect(dodged.chat.y).toBe(panel.chat.y)
  await expect(showChat(session.chat)).toHaveCount(0)
  await shot(session, 'bubble-picked')
})

test('a minimized chat comes back minimized, the bubble ends picking, docked stays put', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', prefs: BOTTOM_LEFT_PREFS })
  await session.waitForPreview()
  await chatWhere(session, 'the floating panel', (chat) => !isBubble(chat))

  await session.chat.evaluate(() => window.gui.setMinimized(true))
  const pill = await chatWhere(session, 'the pill', (chat) => chat.height === PILL_VIEW_HEIGHT)
  await startSelecting(session)
  await chatWhere(session, 'the bubble', isBubble)
  expect((await session.app.evaluate(views))?.chat).toEqual(bubbleAt(pill.chat))
  await pressEscape(session)
  const back = await chatWhere(session, 'the pill again', (chat) => !isBubble(chat))
  expect(back.chat).toEqual(pill.chat)
  expect((await session.chatSnapshot()).meta.minimized).toBe(true)

  // Clicking the bubble stops picking and brings the chat back as it was.
  await startSelecting(session)
  await chatWhere(session, 'the bubble again', isBubble)
  await showChat(session.chat).click()
  await selecting(session, false)
  const shown = await chatWhere(session, 'the pill after the click', (chat) => !isBubble(chat))
  expect(shown.chat).toEqual(pill.chat)
  expect((await session.chatSnapshot()).meta.minimized).toBe(true)

  // As the sidebar beside the preview, the chat covers nothing and stays as it is.
  await session.chat.evaluate(() => window.gui.toggleDock())
  // In its place down the window's left side, once it has slid in.
  const docked = await chatWhere(
    session,
    'the sidebar',
    (chat) => chat.width === 380 && chat.x === 0,
  )
  await startSelecting(session)
  await sleep(500)
  expect((await session.app.evaluate(views))?.chat).toEqual(docked.chat)
  await expect(showChat(session.chat)).toHaveCount(0)
  await pressEscape(session)
  expect((await session.app.evaluate(views))?.chat).toEqual(docked.chat)
})

// A stand-in ACP agent (a small Node script) keeps a turn running, or asks a permission
// question, so the bubble's states show without an agent login or usage.

const AGENT: AgentId = `${CUSTOM_AGENT_PREFIX}Bubble`
/** Works until it's stopped. */
const WORK = 'SCENARIO=work Keep working'
/** Asks a question Auto mode leaves to the user, then ends. */
const ASK = 'SCENARIO=ask Clean the build folder'

const AGENT_SCRIPT = String.raw`
const write = (message) => {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
}
const pending = new Map()
let lastId = 1000
let stop = null
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = ++lastId
    pending.set(id, resolve)
    write({ id, method, params })
  })

const prompt = async ({ sessionId, prompt }) => {
  const text = prompt.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  if (/SCENARIO=ask/.test(text)) {
    const toolCall = { toolCallId: 'clean-1', title: 'rm -rf build', kind: 'execute', status: 'pending' }
    write({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', ...toolCall } } })
    // Leading with No flags it, so Gui asks the user even in Auto mode.
    const options = [
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    ]
    await ask('session/request_permission', { sessionId, toolCall, options })
    return { stopReason: 'end_turn' }
  }
  return new Promise((resolve) => {
    stop = () => resolve({ stopReason: 'cancelled' })
  })
}

const handle = (message) => {
  const { id, method, params } = message
  if (method === undefined) {
    const resolve = pending.get(id)
    pending.delete(id)
    resolve?.(message.result)
    return
  }
  if (method === 'session/cancel') {
    stop?.()
    stop = null
    return
  }
  if (id === undefined) return
  if (method === 'initialize') {
    return write({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
  }
  if (method === 'session/new') {
    return write({ id, result: { sessionId: 'session-' + process.pid } })
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

/** Adds the stand-in to agents.json, waits for Gui to list it, and selects it. */
async function useStandIn(session: GuiSession) {
  const script = join(session.fixture.base, 'bubble-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  const agents = {
    Bubble: { command: electronExecutable(), args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } },
  }
  writeFileSync(join(session.fixture.userData, 'agents.json'), JSON.stringify(agents))
  await session.chrome.evaluate(() => window.gui.checkAgents())
  const listed = async () => (await session.state()).agents.some((agent) => agent.id === AGENT)
  await waitFor(listed, 'the stand-in agent to be listed')
  await waitFor(async () => (await session.state()).project !== null, 'the project to open')
  await session.chrome.evaluate((id) => window.gui.setAgent(id), AGENT)
  const selected = async () => (await session.chatSnapshot()).meta.agentId === AGENT
  await waitFor(selected, 'the stand-in agent to be selected')
}

const send = (chat: Page, text: string) =>
  chat.evaluate((message) => window.gui.send(message), text)

test('the bubble shows a running turn, and a permission card waits behind it', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', prefs: BOTTOM_LEFT_PREFS })
  await session.declineConsentDialogs()
  await useStandIn(session)
  await session.waitForPreview()
  const panel = await chatWhere(session, 'the floating panel', (chat) => !isBubble(chat))
  const bubble = showChat(session.chat)

  // A running turn: the bubble spins.
  expect(await send(session.chat, WORK)).toBe(true)
  const working = async () => (await session.chatSnapshot()).meta.status === 'working'
  await waitFor(working, 'the agent to be working')
  await startSelecting(session)
  await chatWhere(session, 'the bubble', isBubble)
  await expect(bubble).toHaveAccessibleDescription('The agent is working. Stops selecting.')
  await shot(session, 'bubble-running')
  await session.chat.evaluate(() => window.gui.cancel())
  expect((await session.waitForTurn(0)).turn.status).toBe('cancelled')
  await expect(bubble).toHaveAccessibleDescription('Stops selecting.')

  // A permission card while picking: a badge on the bubble, and the pick goes on.
  expect(await send(session.chat, ASK)).toBe(true)
  const waiting = async () => {
    const turn = (await session.chatSnapshot()).turns[1]
    return turn?.items.some((item) => item.kind === 'permission' && item.resolved === null)
  }
  await waitFor(waiting, 'the permission card')
  await expect(bubble).toHaveAccessibleDescription('The agent is waiting for you. Stops selecting.')
  await sleep(500)
  expect((await session.state()).preview.selecting).toBe(true)
  expect((await session.app.evaluate(views))?.chat).toEqual(bubbleAt(panel.chat))
  await shot(session, 'bubble-waiting')

  // Picking ends: the panel is back as it was, with the card.
  await pressEscape(session)
  const restored = await chatWhere(session, 'the panel with the card', (chat) => !isBubble(chat))
  expect(restored.chat).toEqual(panel.chat)
  await expect(session.chat.getByRole('button', { name: "Don't allow" })).toBeVisible()
  await shot(session, 'bubble-card')
  await session.chat.getByRole('button', { name: "Don't allow" }).click()
  expect((await session.waitForTurn(1)).turn.status).toBe('done')
})

test('the floating chat tucks into its bubble when the page takes the keyboard', async ({
  launch,
}) => {
  // Where the keyboard goes depends on Gui being the active app.
  test.skip(takesFocus, TAKES_FOCUS)
  const session = await launch({ fixture: 'vite', prefs: BOTTOM_LEFT_PREFS })
  await session.waitForPreview()
  await session.app.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true })
    BrowserWindow.getAllWindows()[0]?.focus()
  })
  const panel = await chatWhere(session, 'the open panel', (chat) => !isBubble(chat))
  await session.chat.getByRole('textbox', { name: /^Message / }).focus()

  // The keyboard into the page (a click there): the panel tucks into a bubble at its corner.
  await session.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const views = BrowserWindow.getAllWindows()[0]?.contentView.children ?? []
    const page = views.find(
      (view): view is InstanceType<typeof WebContentsView> =>
        view instanceof WebContentsView && /^https?:\/\//.test(view.webContents.getURL()),
    )
    page?.webContents.focus()
  })
  const tucked = await chatWhere(session, 'the tucked bubble', isBubble)
  expect(tucked.chat).toEqual(bubbleAt(panel.chat))
  expect((await session.state()).chatVisible).toBe(true)
  await session.shot('tucked')

  // The bubble brings it back as it was, with the cursor in the message box.
  await session.chat.getByRole('button', { name: 'Show chat' }).click()
  const back = await chatWhere(session, 'the panel back', (chat) => !isBubble(chat))
  expect(back.chat).toEqual(panel.chat)
  await waitFor(
    () => session.chat.evaluate(() => document.activeElement?.matches('[data-composer]')),
    'the cursor in the message box',
  )
})
