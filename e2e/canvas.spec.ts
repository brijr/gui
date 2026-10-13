import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardState } from '../src/shared/types'
import { electronExecutable, waitFor } from './helpers/env'
import { type GuiSession, standInsFile } from './helpers/session'
import { expect, test } from './helpers/test'

// A canvas: opened from the start screen with no dialog, built on by hand and by the agent's
// canvas tools (through a stand-in agent: no agent login or paid usage).
const AGENT_SCRIPT = String.raw`
const write = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
let mcp
const call = async (name, args) => {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  for (const header of mcp.headers) headers[header.name] = header.value
  const response = await fetch(mcp.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  const reply = await response.json()
  if (reply.error) throw new Error(reply.error.message)
  const result = reply.result
  return { isError: result.isError, content: result.content.map(c => c.type === 'image' ? { type: 'image' } : c) }
}
const prompt = async params => {
  const texts = params.prompt.filter(block => block.type === 'text').map(block => block.text)
  const request = texts.find(text => text.startsWith('TOOLS '))
  const results = [{ canvas: texts.find(text => text.startsWith('<canvas_')) || null }]
  for (const step of JSON.parse(request.slice(6))) results.push(await call(step.name, step.args || {}))
  write({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(results) } } } })
  return { stopReason: 'end_turn' }
}
const handle = ({ id, method, params }) => {
  if (id === undefined || !method) return
  if (method === 'initialize') return write({ id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, authMethods: [] } })
  if (method === 'session/new') { mcp = params.mcpServers.find(server => server.url); return write({ id, result: { sessionId: 'canvas' } }) }
  if (method === 'session/prompt') return void prompt(params).then(result => write({ id, result }), error => write({ id, error: { code: -32603, message: error.message } }))
  write({ id, error: { code: -32601, message: 'Method not found' } })
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1)
    if (line) handle(JSON.parse(line))
  }
})
`

interface ToolResult {
  isError?: boolean
  canvas?: string | null
  content?: { type: string; text?: string }[]
}

async function board(session: GuiSession): Promise<BoardState> {
  return waitFor(async () => (await session.state()).board, 'the canvas')
}

async function openCanvas(session: GuiSession) {
  await session.chrome.getByRole('button', { name: /Open a canvas/ }).click()
  return board(session)
}

/** Closing the last tab closes its window; leave a start-screen tab for reopen tests. */
async function keepWindowOnClose(session: GuiSession) {
  const id = (await session.state()).activeTab
  await session.chrome.evaluate((tab) => {
    window.gui.newTab()
    window.gui.selectTab(tab)
  }, id)
  await waitFor(async () => {
    const state = await session.state()
    return state.tabs.length === 2 && state.activeTab === id
  }, 'a spare tab before closing the canvas')
  return id
}

const undo = (session: GuiSession) =>
  session.app.evaluate(({ Menu }) => {
    const edit = Menu.getApplicationMenu()?.items.find((item) => item.label === 'Edit')
    edit?.submenu?.items.find((item) => item.label === 'Undo')?.click()
  })

test('a canvas opens from the start screen and its frames are moved, undone, duplicated and opened', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { chrome } = session
  const opened = await openCanvas(session)
  expect(opened.frames).toEqual([])
  await expect(chrome.getByText('Start your canvas')).toBeVisible()
  const { project } = await session.state()
  expect(project?.root).toContain('canvases')

  await chrome.evaluate(() => window.gui.boardAddFrame('desktop', null))
  await chrome.evaluate(() => window.gui.boardAddFrame('mobile', null))
  await waitFor(
    async () => (await board(session)).frames.every((frame) => frame.captured) || null,
    'thumbnails',
  )
  const [desktop, mobile] = (await board(session)).frames
  expect(desktop).toMatchObject({ id: 'desktop', x: 0, y: 0, width: 1440, height: 900 })
  // Beside the one before it, never on top of it.
  expect(mobile.x).toBeGreaterThanOrEqual(desktop.x + desktop.width)

  // A page written straight to the folder joins the board.
  const root = project?.root ?? ''
  writeFileSync(join(root, 'frames', 'written.html'), '<!doctype html><h1>Written</h1>')
  await waitFor(
    async () => (await board(session)).frames.some((frame) => frame.id === 'written'),
    'the written page on the board',
  )

  // Drag a frame; ⌘Z puts it back before touching the agent's turns.
  await chrome.keyboard.press('Meta+0')
  const box = await chrome.locator('[data-frame="desktop"]').last().boundingBox()
  if (!box) throw new Error('The desktop frame is not on screen')
  await chrome.mouse.move(box.x + 40, box.y + 40)
  await chrome.mouse.down()
  await chrome.mouse.move(box.x + 140, box.y + 140, { steps: 6 })
  await chrome.mouse.up()
  await waitFor(
    async () => (await board(session)).frames.find((frame) => frame.id === 'desktop')?.x !== 0,
    'the frame to move',
  )
  await undo(session)
  await waitFor(
    async () => (await board(session)).frames.find((frame) => frame.id === 'desktop')?.x === 0,
    'the move undone',
  )

  // ⌥⌘D on the board duplicates the selection.
  await chrome.locator('[data-frame="desktop"]').last().click()
  await chrome.keyboard.press('Alt+Meta+d')
  await waitFor(
    async () => (await board(session)).frames.some((frame) => frame.id === 'desktop-copy'),
    'the copy',
  )

  // A double-click opens the frame live in the preview, at the viewport its size matches.
  await chrome.keyboard.press('Meta+0')
  const target = await chrome.locator('[data-frame="mobile"]').last().boundingBox()
  if (!target) throw new Error('The mobile frame is not on screen')
  await chrome.mouse.click(target.x + 10, target.y + 10)
  await chrome.mouse.click(target.x + 10, target.y + 10)
  const live = await waitFor(async () => {
    const state = await session.state()
    return state.board?.open === 'mobile' && state.preview.visible ? state : null
  }, 'the frame open')
  expect(live.preview.viewport).toBe('mobile')
  expect(live.preview.selectable).toBe(true)
  await chrome.getByRole('button', { name: 'Board' }).click()
  await waitFor(async () => {
    const state = await session.state()
    return state.board?.open === null && !state.preview.visible
  }, 'back on the board')
})

test('the agent builds on the canvas with its canvas tools', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  await openCanvas(session)
  const script = join(session.fixture.base, 'canvas-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  writeFileSync(
    standInsFile(session.fixture),
    JSON.stringify({
      grok: { command: electronExecutable(), args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } },
    }),
  )
  await session.chrome.evaluate(() => window.gui.setAgent('grok'))
  await waitFor(async () => (await session.chatSnapshot()).meta.agentId === 'grok', 'the agent')

  const ask = async (steps: { name: string; args?: Record<string, unknown> }[]) => {
    const index = (await session.chatSnapshot()).turns.length
    const sent = await session.chat.evaluate(
      (text) => window.gui.send(text),
      `TOOLS ${JSON.stringify(steps)}`,
    )
    expect(sent).toBe(true)
    const { turn } = await session.waitForTurn(index)
    expect(turn.error).toBeNull()
    const text = turn.items.flatMap((item) => (item.kind === 'text' ? [item.text] : [])).join('')
    return JSON.parse(text) as ToolResult[]
  }
  const page = (title: string) => `<!doctype html><body style="margin:0"><h1>${title}</h1></body>`

  const results = await ask([
    {
      name: 'canvas_create_frame',
      args: { name: 'Landing — calm', width: 1440, height: 900, html: page('Calm') },
    },
    {
      name: 'canvas_create_frame',
      args: {
        name: 'Landing — bold',
        width: 1440,
        height: 900,
        html: page('Bold'),
        after: ['landing-calm'],
      },
    },
    { name: 'canvas_screenshot', args: { id: 'landing-calm' } },
    { name: 'canvas_open_frame', args: { id: 'landing-bold' } },
    { name: 'preview_snapshot' },
    { name: 'canvas_open_frame', args: { id: null } },
    { name: 'dev_server_status' },
  ])
  expect(results[0].canvas).toContain('It has no frames yet.')
  expect(results.slice(1).every((result) => !result.isError)).toBe(true)
  expect(results[3].content?.[0].type).toBe('image')
  expect(results[5].content?.[0].text).toContain('Bold')
  expect(results[7].content?.[0].text).toContain('no dev server')
  const built = await board(session)
  expect(built.frames.map((frame) => frame.id)).toEqual(['landing-calm', 'landing-bold'])
  expect(built.frames[1].x).toBeGreaterThan(built.frames[0].x + built.frames[0].width)

  // The selection rides along with the next message; undoing the turn brings a deleted frame back.
  await session.chrome.evaluate(() => window.gui.boardSelect(['landing-calm']))
  const [second] = await ask([{ name: 'canvas_delete_frames', args: { ids: ['landing-bold'] } }])
  expect(second.canvas).toMatch(/landing-calm .*\[selected\]/)
  const root = (await session.state()).project?.root ?? ''
  expect(readdirSync(join(root, 'frames'))).toEqual(['landing-calm.html'])
  await undo(session)
  await waitFor(
    async () => (await board(session)).frames.some((frame) => frame.id === 'landing-bold'),
    'the deleted frame back',
  )
})

test('overlapping frame actions keep unique files and immediate close/reopen preserves the final layout', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const canvas = await openCanvas(session)
  await session.chrome.evaluate(() => {
    for (let i = 0; i < 8; i++) window.gui.boardAddFrame('desktop', null)
  })
  const created = await waitFor(async () => {
    const current = await board(session)
    return current.frames.length === 8 ? current : null
  }, 'all concurrent frame actions')
  const ids = created.frames.map((frame) => frame.id)
  expect(new Set(ids).size).toBe(8)
  const root = (await session.state()).project?.root ?? ''
  await waitFor(() => readdirSync(join(root, 'frames')).length === 8, 'all frame files')
  expect(readdirSync(join(root, 'frames')).sort()).toEqual(ids.map((id) => `${id}.html`).sort())
  for (let i = 1; i < created.frames.length; i++)
    expect(created.frames[i].x).toBeGreaterThanOrEqual(
      created.frames[i - 1].x + created.frames[i - 1].width,
    )
  const tab = await keepWindowOnClose(session)
  await session.chrome.evaluate(
    ({ id, canvasId, tabId }) => {
      window.gui.boardArrange([{ id, x: 54321, y: 23456 }])
      window.gui.closeTab(tabId)
      window.gui.openBoard(canvasId)
    },
    { id: ids[0], canvasId: canvas.id, tabId: tab },
  )
  const reopened = await waitFor(async () => {
    const state = await session.state()
    return state.activeTab !== tab && state.board?.id === canvas.id ? state.board : null
  }, 'the same canvas reopened after its final persistence')
  expect(reopened.frames.find((frame) => frame.id === ids[0])).toMatchObject({ x: 54321, y: 23456 })
  const saved = JSON.parse(readFileSync(join(root, 'canvas.json'), 'utf8')) as BoardState
  expect(saved.frames.find((frame) => frame.id === ids[0])).toMatchObject({ x: 54321, y: 23456 })
})

test('thumbnail workers unload idle animated pages and shared CSS stays fresh through reopen', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const canvas = await openCanvas(session)
  const root = (await session.state()).project?.root ?? ''
  const css = join(root, 'assets', 'shared.css')
  writeFileSync(css, 'body { margin: 0; background: #aa0000; color: white; }')
  for (const id of ['one', 'two', 'three'])
    writeFileSync(
      join(root, 'frames', `${id}.html`),
      `<!doctype html><link rel="stylesheet" href="../assets/shared.css"><h1>${id}</h1><script>window.ticks = 0; const tick = () => { window.ticks++; document.body.style.opacity = '1'; requestAnimationFrame(tick); }; requestAnimationFrame(tick);</script>`,
    )
  const ready = await waitFor(async () => {
    const state = await board(session)
    return state.frames.length === 3 && state.frames.every((frame) => frame.captured) ? state : null
  }, 'animated frame thumbnails')
  const idleWorkers = () =>
    session.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((win) => win.webContents.isOffscreen())
        .map((win) => ({ url: win.webContents.getURL(), painting: win.webContents.isPainting() })),
    )
  await waitFor(async () => {
    const workers = await idleWorkers()
    return (
      workers.length > 0 &&
      workers.every((worker) => worker.url === 'about:blank' && !worker.painting)
    )
  }, 'idle workers with no running frame page')
  const thumb = join(session.fixture.userData, 'canvas-thumbnails', canvas.id, 'one.jpg')
  const digest = () => createHash('sha256').update(readFileSync(thumb)).digest('hex')
  const red = digest()
  const previous = new Map(ready.frames.map((frame) => [frame.id, frame.version]))
  writeFileSync(css, 'body { margin: 0; background: #0000aa; color: white; }')
  await waitFor(async () => {
    const state = await board(session)
    return (
      state.frames.every((frame) => frame.version > (previous.get(frame.id) ?? 0)) &&
      digest() !== red
    )
  }, 'all thumbnails invalidated by shared CSS')
  const blue = digest()
  const tab = await keepWindowOnClose(session)
  await session.chrome.evaluate((id) => window.gui.closeTab(id), tab)
  await waitFor(async () => (await session.state()).board === null, 'the canvas closed')
  writeFileSync(css, 'body { margin: 0; background: #00aa00; color: white; }')
  await session.chrome.evaluate((id) => window.gui.openBoard(id), canvas.id)
  await waitFor(async () => {
    const state = await board(session)
    return (
      state.id === canvas.id &&
      state.frames.every((frame) => frame.version > 0) &&
      digest() !== blue
    )
  }, 'shared CSS changed while closed, recaptured on reopening')
  await waitFor(
    async () =>
      (await idleWorkers()).every((worker) => worker.url === 'about:blank' && !worker.painting),
    'reopened workers idle',
  )
})
