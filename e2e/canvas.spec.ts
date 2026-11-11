import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { SMALL_THUMB_WIDTH, THUMB_WIDTH } from '../src/shared/board'
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
  await session.chrome.getByRole('button', { name: /New canvas/ }).click()
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

/**
 * ⌘0, then waits for the fit to land: it asks main where the floating chat is first, so the
 * frames move a moment after the key. Done when every frame is in view and has stopped moving.
 */
async function zoomToFit(session: GuiSession) {
  const view = () =>
    session.chrome.evaluate(() => {
      const area = document.querySelector('[role="application"]')?.getBoundingClientRect()
      const frames = [...document.querySelectorAll('[data-frame]')].map((el) =>
        el.getBoundingClientRect(),
      )
      if (!area || !frames.length) return null
      const inView = frames.every(
        (r) =>
          r.left >= area.left &&
          r.right <= area.right &&
          r.top >= area.top &&
          r.bottom <= area.bottom,
      )
      return inView ? JSON.stringify(frames.map((r) => [r.x, r.y, r.width, r.height])) : null
    })
  await session.chrome.keyboard.press('Meta+0')
  let last: string | null = null
  await waitFor(async () => {
    const now = await view()
    const settled = now !== null && now === last
    last = now
    return settled
  }, 'every frame in view')
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
  await waitFor(async () => {
    const frames = (await board(session)).frames
    return frames.length === 2 && frames.every((frame) => frame.captured)
  }, 'thumbnails')
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
  await zoomToFit(session)
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
  // On the board too, before fitting: a frame that lands after a fit is brought into sight on
  // its own, and the others can leave it.
  await expect(chrome.locator('[data-frame="desktop-copy"]').last()).toBeVisible()

  // A double-click opens the frame live in the preview, at the viewport its size matches.
  await zoomToFit(session)
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

  // The frame is on the canvas's own host: it can't read or send the cookies of the user's
  // apps on 127.0.0.1 or localhost in the same preview session, nor set theirs.
  const cookies: (string | undefined)[] = []
  const app = createServer((req, res) => {
    cookies.push(req.headers.cookie)
    res.end('ok')
  })
  await new Promise<void>((done) => app.listen(0, '127.0.0.1', () => done()))
  try {
    const appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}/`
    const seen = await session.app.evaluate(
      async ({ session: sessions, webContents }, { url, thumbs }) => {
        const preview = sessions.fromPartition('persist:gui-preview')
        await preview.cookies.set({ url, name: 'app', value: 'secret' })
        await preview.cookies.set({ url: 'http://localhost/', name: 'local', value: 'secret' })
        const wc = webContents
          .getAllWebContents()
          .find((w) => w.session === preview && w.getURL().includes('/frames/mobile.html'))
        if (!wc) throw new Error('No live frame')
        const frame = await wc.executeJavaScript(
          `document.cookie = 'frame=1; path=/'; fetch(${JSON.stringify(url)}, { mode: 'no-cors', credentials: 'include' }).then(() => document.cookie)`,
        )
        // Nor read the canvas's thumbnails: only Gui's own session serves them.
        const thumb = await wc.executeJavaScript(
          `fetch(${JSON.stringify(`${thumbs}/mobile`)}).then(() => 'read', () => 'refused')`,
        )
        const app = (await preview.cookies.get({ url })).map((cookie) => cookie.name)
        return { host: new URL(wc.getURL()).hostname, frame, app, thumb }
      },
      { url: appUrl, thumbs: opened.thumbs },
    )
    expect(seen.frame).toBe('frame=1')
    expect(seen.thumb).toBe('refused')
    expect(seen.app).toEqual(['app'])
    expect(cookies).toEqual([undefined])
    expect(seen.host).toBe(`${opened.id}.localhost`)
  } finally {
    app.close()
  }
  await chrome.getByRole('button', { name: 'Canvas', exact: true }).click()
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
    // Back on the board, with no frame open: the page tools say how to open one.
    { name: 'preview_snapshot' },
  ])
  expect(results[0].canvas).toContain('It has no frames yet.')
  expect(results.slice(1, 7).every((result) => !result.isError)).toBe(true)
  expect(results[3].content?.[0].type).toBe('image')
  expect(results[5].content?.[0].text).toContain('Bold')
  expect(results[7].isError).toBe(true)
  expect(results[7].content?.[0].text).toContain('Open a frame with canvas_open_frame first')
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

test('zoomed out, the board shows small thumbnails, and full ones zoomed in, never blank between', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { chrome } = session
  const canvas = await openCanvas(session)
  await chrome.evaluate(() => {
    window.gui.boardAddFrame('desktop', null)
    window.gui.boardAddFrame('desktop', null)
  })
  const { frames } = await waitFor(async () => {
    const state = await board(session)
    return state.frames.length === 2 && state.frames.every((frame) => frame.captured) ? state : null
  }, 'thumbnails')
  const thumbs = join(session.fixture.userData, 'canvas-thumbnails', canvas.id)
  expect(readdirSync(thumbs).sort()).toEqual(
    expect.arrayContaining(frames.flatMap((f) => [`${f.id}.jpg`, `${f.id}.small.jpg`])),
  )
  // The window can read a thumbnail's bytes with CORS, as a texture needs, not only show it.
  const fetched = await chrome.evaluate(async (url) => {
    const response = await fetch(url)
    const blob = await response.blob()
    const bitmap = await createImageBitmap(blob)
    const read = { status: response.status, type: blob.type, width: bitmap.width }
    bitmap.close()
    return read
  }, `${canvas.thumbs}/${frames[0].id}.small?v=${frames[0].version}`)
  expect(fetched).toEqual({ status: 200, type: 'image/jpeg', width: 360 })
  // How wide the thumbnail each frame shows is, 0 for none: the texture the canvas holds for
  // it, which its tile reports.
  await chrome.evaluate(() => {
    const page = window as unknown as {
      thumbWidths: () => [string, number][]
      thumbProbe: { blank: number }
    }
    page.thumbWidths = () =>
      [...document.querySelectorAll<HTMLElement>('[data-frame]')].map((tile) => [
        tile.dataset.frame ?? '',
        Number(tile.dataset.thumb ?? 0),
      ])
    // Counts the animation frames where a frame that had shown its thumbnail shows none.
    const shown = new Set<string>()
    const probe = { blank: 0 }
    page.thumbProbe = probe
    const tick = () => {
      for (const [id, width] of page.thumbWidths()) {
        if (width > 0) shown.add(id)
        else if (shown.has(id)) probe.blank++
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const widths = () =>
    chrome.evaluate(() =>
      (window as unknown as { thumbWidths: () => [string, number][] })
        .thumbWidths()
        .map(([, width]) => width),
    )
  // ⌘− and ⌘= as real keys to the board, one step a poll, until each copy shows: zoomed out,
  // one no wider than the small copy (the canvas may make it narrower still); zoomed in, the
  // full one.
  const zoomUntil = (keyCode: '-' | '=', wanted: (width: number) => boolean, label: string) =>
    waitFor(async () => {
      const now = await widths()
      if (now.length === 2 && now.every(wanted)) return true
      await session.app.evaluate(({ webContents }, keyCode) => {
        const contents = webContents
          .getAllWebContents()
          .find((wc) => /\/index\.html(?:[?#]|$)/.test(wc.getURL()))
        contents?.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['meta'] })
        contents?.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['meta'] })
      }, keyCode)
      return false
    }, label)
  const small = (width: number) => width > 0 && width <= SMALL_THUMB_WIDTH
  const full = (width: number) => width === THUMB_WIDTH
  await chrome.locator('[role="application"]').focus()
  await zoomUntil('-', small, 'small thumbnails')
  await zoomUntil('=', full, 'full thumbnails')
  await zoomUntil('-', small, 'small thumbnails again')
  expect(
    await chrome.evaluate(
      () => (window as unknown as { thumbProbe: { blank: number } }).thumbProbe.blank,
    ),
  ).toBe(0)
})

test('a screen reader finds each frame by its name, and is on the frame Tab or a click selects', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { chrome } = session
  await openCanvas(session)
  await chrome.evaluate(() => {
    window.gui.boardAddFrame('desktop', null)
    window.gui.boardAddFrame('mobile', null)
  })
  const { frames } = await waitFor(async () => {
    const state = await board(session)
    return state.frames.length === 2 ? state : null
  }, 'two frames')
  await zoomToFit(session)

  // Each frame is an option named for it, in the board's list of frames.
  const area = chrome.getByRole('application')
  const list = area.getByRole('listbox', { name: 'Frames' })
  await expect(list.getByRole('option')).toHaveCount(2)
  const [first, second] = frames.map((frame) =>
    list.getByRole('option', { name: frame.name, exact: true }),
  )
  await expect(first).toBeVisible()
  await expect(first).toHaveAttribute('data-frame', frames[0].id)

  // A frame added is selected, and the board points a screen reader at it; with nothing
  // selected, at nothing.
  await expect(second).toHaveAttribute('aria-selected', 'true')
  await expect(area).toHaveAttribute(
    'aria-activedescendant',
    (await second.getAttribute('id')) ?? '',
  )
  await area.focus()
  await chrome.keyboard.press('Escape')
  await expect(second).toHaveAttribute('aria-selected', 'false')
  await expect(area).not.toHaveAttribute('aria-activedescendant')

  // Tab selects a frame, and the board points a screen reader at it.
  await chrome.keyboard.press('Tab')
  await expect(first).toHaveAttribute('aria-selected', 'true')
  await expect(area).toHaveAttribute(
    'aria-activedescendant',
    (await first.getAttribute('id')) ?? '',
  )
  await chrome.keyboard.press('Tab')
  await expect(area).toHaveAttribute(
    'aria-activedescendant',
    (await second.getAttribute('id')) ?? '',
  )
  await expect(first).toHaveAttribute('aria-selected', 'false')

  // In Chromium's own accessibility tree, the focused board's active descendant is that
  // frame's option, selected: what a screen reader is given as the focus.
  const cdp = await session.app.context().newCDPSession(chrome)
  const reading = async () => {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree')
    const value = (node: (typeof nodes)[number] | undefined, name: string) =>
      node?.properties?.find((property) => property.name === name)?.value
    const area = nodes.find((node) => node.role?.value === 'application')
    const active = value(area, 'activedescendant')?.relatedNodes?.[0]?.backendDOMNodeId
    const option = nodes.find((node) => node.backendDOMNodeId === active)
    return {
      focused: value(area, 'focused')?.value,
      role: option?.role?.value,
      name: option?.name?.value,
      selected: value(option, 'selected')?.value,
    }
  }
  await waitFor(
    async () => (await reading()).name === frames[1].name,
    'the second frame active for a screen reader',
  )
  expect(await reading()).toEqual({
    focused: true,
    role: 'option',
    name: frames[1].name,
    selected: true,
  })

  // A click from assistive tech (no pointer behind it) selects the frame it's on.
  await first.dispatchEvent('click')
  await waitFor(
    async () => (await board(session)).selection.join() === frames[0].id,
    'the first frame selected',
  )
  await expect(area).toHaveAttribute(
    'aria-activedescendant',
    (await first.getAttribute('id')) ?? '',
  )
})

test("Figma's zoom keys: ⇧0 is 100%, ⇧1 fits, ⇧2 the selection, + and − step, not while naming", async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { chrome } = session
  await openCanvas(session)
  await chrome.evaluate(() => {
    window.gui.boardAddFrame('desktop', null)
    window.gui.boardAddFrame('mobile', null)
  })
  await waitFor(async () => (await board(session)).frames.length === 2, 'two frames')
  await zoomToFit(session)
  const zoom = () =>
    chrome.evaluate(() => {
      const layer = document.querySelector<HTMLElement>('[style*="--board-zoom"]')
      return Number(layer?.style.getPropertyValue('--board-zoom'))
    })
  const zoomed = (wanted: (zoom: number) => boolean, label: string) =>
    waitFor(async () => {
      const now = await zoom()
      return wanted(now) ? now : null
    }, label)
  const fitted = await zoom()
  expect(fitted).toBeLessThan(1)

  const area = chrome.getByRole('application')
  await area.focus()
  await chrome.keyboard.press('Shift+Digit0')
  await zoomed((z) => z === 1, '100%')
  await chrome.keyboard.press('-')
  await zoomed((z) => Math.abs(z - 0.8) < 1e-9, 'a step out')
  await chrome.keyboard.press('=')
  await zoomed((z) => Math.abs(z - 1) < 1e-9, 'a step back in')
  await chrome.keyboard.press('Shift+Digit1')
  await zoomed((z) => z === fitted, 'everything fitted again')

  // ⇧2 with nothing selected does nothing; with the phone frame selected, it fills the view.
  await chrome.keyboard.press('Escape')
  await expect(chrome.locator('[aria-selected="true"]')).toHaveCount(0)
  // The board leaves the key alone: it goes on, not taken.
  await chrome.evaluate(() => {
    const page = window as unknown as { taken?: boolean }
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Digit2') page.taken = event.defaultPrevented
    })
  })
  await chrome.keyboard.press('Shift+Digit2')
  const heard = await waitFor(
    () =>
      chrome.evaluate(() => {
        const { taken } = window as unknown as { taken?: boolean }
        return taken === undefined ? null : { taken }
      }),
    'the key heard',
  )
  expect(heard.taken).toBe(false)
  expect(await zoom()).toBe(fitted)
  await chrome.locator('[data-frame="mobile"]').last().click()
  // Selected on the board itself, which hears of it a moment after main.
  await expect(chrome.locator('[data-frame="mobile"]').last()).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await chrome.keyboard.press('Shift+Digit2')
  await zoomed((z) => z > fitted, 'the phone frame filling the view')
  const [frame, view] = await chrome.evaluate(() =>
    [
      [...document.querySelectorAll('[data-frame="mobile"]')].at(-1),
      document.querySelector('[role="application"]'),
    ].map((el) => {
      const r = (el as HTMLElement).getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, height: r.height }
    }),
  )
  // As tall as the view allows, less its margin.
  expect(frame.top).toBeGreaterThanOrEqual(view.top)
  expect(frame.bottom).toBeLessThanOrEqual(view.bottom)
  expect(frame.height).toBeGreaterThan(view.height * 0.7)

  // Typing in a frame's name, they're the name's: the board doesn't zoom.
  const before = await zoom()
  await chrome.keyboard.press('F2')
  const field = area.getByRole('textbox', { name: 'Frame name' })
  await expect(field).toBeFocused()
  await chrome.keyboard.press('Shift+Digit0')
  await chrome.keyboard.press('-')
  await expect(field).toHaveValue(/\)-$/)
  expect(await zoom()).toBe(before)
  await chrome.keyboard.press('Escape')
})

test("Figma's Z: held, a click zooms in there, ⌥-click out, a drag to its area; let go, the tool is back", async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { chrome } = session
  await openCanvas(session)
  await chrome.evaluate(() => {
    window.gui.boardAddFrame('desktop', null)
    window.gui.boardAddFrame('mobile', null)
  })
  await waitFor(async () => (await board(session)).frames.length === 2, 'two frames')
  await zoomToFit(session)
  const area = chrome.getByRole('application')
  await area.focus()
  const box = await area.boundingBox()
  if (!box) throw new Error('no board')
  /** The camera as the board's layer is drawn: its origin on screen, in board-view pixels, and zoom */
  const camera = () =>
    chrome.evaluate(() => {
      const layer = document.querySelector<HTMLElement>('[style*="--board-zoom"]')
      const [x, y] = (layer?.style.transform.match(/-?[\d.e-]+(?=px)/g) ?? []).map(Number)
      return { x, y, zoom: Number(layer?.style.getPropertyValue('--board-zoom')) }
    })
  const zoomed = (wanted: (zoom: number) => boolean, label: string) =>
    waitFor(async () => {
      const now = await camera()
      return wanted(now.zoom) ? now : null
    }, label)
  /** The board point under the window point `at`, for the camera `c` */
  const under = (at: { x: number; y: number }, c: { x: number; y: number; zoom: number }) => ({
    x: (at.x - box.x - c.x) / c.zoom,
    y: (at.y - box.y - c.y) / c.zoom,
  })
  /** Within a screen pixel at `zoom`: the pointer's position may be rounded */
  const near = (a: { x: number; y: number }, b: { x: number; y: number }, zoom: number) =>
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1.5 / zoom)
  const cursor = () => area.evaluate((el) => getComputedStyle(el).cursor)
  const fitted = await camera()
  expect(fitted.zoom).toBeLessThan(1)

  // Held, the pointer is a magnifier; with ⌥ too, one that zooms out.
  await chrome.keyboard.down('z')
  await expect.poll(cursor).toBe('zoom-in')
  await chrome.keyboard.down('Alt')
  await expect.poll(cursor).toBe('zoom-out')
  await chrome.keyboard.up('Alt')
  await expect.poll(cursor).toBe('zoom-in')

  // A click zooms one step in, about the point clicked: what's under it stays under it.
  const at = { x: box.x + box.width * 0.4, y: box.y + box.height * 0.45 }
  await chrome.mouse.click(at.x, at.y)
  const stepped = await zoomed((z) => Math.abs(z - fitted.zoom * 1.25) < 1e-9, 'a step in')
  near(under(at, stepped), under(at, fitted), stepped.zoom)
  // ⌥-click, a step back out.
  await chrome.keyboard.down('Alt')
  await chrome.mouse.click(at.x, at.y)
  await chrome.keyboard.up('Alt')
  const back = await zoomed((z) => Math.abs(z - fitted.zoom) < 1e-9, 'a step out')
  near(under(at, back), under(at, fitted), back.zoom)

  // A drag zooms to its area: half the board wide and a quarter high fills it, 2× closer.
  const from = { x: box.x + box.width * 0.2, y: box.y + box.height * 0.3 }
  const to = { x: from.x + box.width / 2, y: from.y + box.height / 4 }
  const middle = under({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 }, back)
  await chrome.mouse.move(from.x, from.y)
  await chrome.mouse.down()
  await chrome.mouse.move(to.x, to.y, { steps: 5 })
  await chrome.mouse.up()
  const boxed = await zoomed(
    (z) => Math.abs(z / back.zoom - 2) < 0.02,
    'the area filling the board',
  )
  // Its middle is the board's middle now.
  near(under({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, boxed), middle, back.zoom)

  // Let go of Z: the Move tool is back, and a click selects a frame again.
  await chrome.keyboard.up('z')
  await expect.poll(cursor).not.toMatch(/zoom/)
  const mobile = chrome.locator('[data-frame="mobile"]').last()
  await chrome.keyboard.press('Shift+Digit1')
  await zoomed((z) => z === fitted.zoom, 'everything fitted again')
  await mobile.click()
  await expect(mobile).toHaveAttribute('aria-selected', 'true')
  expect((await camera()).zoom).toBe(fitted.zoom)

  // With the Hand on, Z held zooms, and letting go gives the Hand back.
  await chrome.keyboard.press('h')
  await expect.poll(cursor).toBe('grab')
  await chrome.keyboard.down('z')
  await expect.poll(cursor).toBe('zoom-in')
  await chrome.keyboard.up('z')
  await expect.poll(cursor).toBe('grab')
  await chrome.keyboard.press('v')
  await expect.poll(cursor).not.toBe('grab')

  // Typed in a frame's name, Z is a letter: no magnifier, and a click there doesn't zoom.
  await chrome.keyboard.press('F2')
  const field = area.getByRole('textbox', { name: 'Frame name' })
  await expect(field).toBeFocused()
  await chrome.keyboard.down('z')
  await expect(field).toHaveValue(/z$/)
  expect(await cursor()).not.toMatch(/zoom/)
  await chrome.keyboard.up('z')
  await chrome.keyboard.press('Escape')
  expect((await camera()).zoom).toBe(fitted.zoom)
})

/** Runs in main: the clipboard as a variable, so the tests never touch the real one. */
function stubClipboard({ clipboard }: typeof import('electron')) {
  type Stored = { types: string[]; data: Record<string, Blob> }
  const store = globalThis as unknown as { guiClipboard: Stored[] }
  store.guiClipboard = []
  clipboard.write = async (items) => {
    const written: Stored[] = []
    for (const item of items) {
      const data: Record<string, Blob> = {}
      for (const type of item.types) data[type] = (await item.getType(type)) as Blob
      written.push({ types: item.types, data })
    }
    store.guiClipboard = written
  }
  clipboard.read = async () =>
    store.guiClipboard.map(
      ({ types, data }) =>
        ({
          types,
          getType: async (type: string) => data[type],
        }) as unknown as Electron.ClipboardItem,
    )
}

test('⌘C and ⌘V copy frames onto the same canvas and another, as one undo step each', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { chrome } = session
  const first = await openCanvas(session)
  await session.app.evaluate(stubClipboard)
  await chrome.evaluate(() => {
    window.gui.boardAddFrame('desktop', null)
    window.gui.boardAddFrame('mobile', null)
  })
  await waitFor(async () => {
    const { frames } = await board(session)
    return frames.length === 2 && frames.every((frame) => frame.captured)
  }, 'two frames')
  // ⌘C copies the page as it is on disk.
  const page = '<!doctype html><h1>Copied page</h1>'
  writeFileSync(join((await session.state()).project?.root ?? '', 'frames', 'mobile.html'), page)
  const clipboard = () =>
    session.app.evaluate(async () => {
      const { guiClipboard } = globalThis as unknown as {
        guiClipboard: { types: string[]; data: Record<string, Blob> }[]
      }
      const [item] = guiClipboard
      const frames = item?.data['web application/x.gui-frames']
      return item ? { types: item.types, text: frames ? await frames.text() : null } : null
    })

  // ⌘C: the selected frame, in Gui's format and as a picture for other apps.
  await zoomToFit(session)
  const mobile = chrome.locator('[data-frame="mobile"]').last()
  await mobile.click()
  await expect(mobile).toHaveAttribute('aria-selected', 'true')
  await chrome.keyboard.press('Meta+c')
  const copied = await waitFor(clipboard, 'the frame on the clipboard')
  expect(copied.types.sort()).toEqual(['image/png', 'web application/x.gui-frames'])
  expect(JSON.parse(copied.text ?? '')).toMatchObject({
    canvas: first.id,
    frames: [{ id: 'mobile', name: 'Mobile', width: 390, height: 844, html: page }],
  })

  // ⌘V on the same canvas: a new frame beside the original, selected; ⌘Z takes it back.
  await chrome.keyboard.press('Meta+v')
  const pasted = await waitFor(async () => {
    const state = await board(session)
    const added = state.frames.find((frame) => !['desktop', 'mobile'].includes(frame.id))
    return added && state.selection.join() === added.id ? state : null
  }, 'the pasted frame, selected')
  const [copy] = pasted.frames.filter((frame) => !['desktop', 'mobile'].includes(frame.id))
  const original = pasted.frames.find((frame) => frame.id === 'mobile')
  expect(copy.x).toBeGreaterThan((original?.x ?? 0) + (original?.width ?? 0))
  await undo(session)
  await waitFor(async () => (await board(session)).frames.length === 2, 'the paste undone')

  // ⌘V on another canvas, in another tab: the same page.
  await chrome.evaluate(() => window.gui.newBoard())
  const second = await waitFor(async () => {
    const state = await board(session)
    return state.id !== first.id && !state.frames.length ? state : null
  }, 'a second canvas')
  const area = chrome.getByRole('application')
  await area.focus()
  await chrome.keyboard.press('Meta+v')
  const there = await waitFor(async () => {
    const state = await board(session)
    return state.id === second.id && state.frames.length === 1 && state.selection.length
      ? state
      : null
  }, 'the frame pasted on the second canvas')
  const root = (await session.state()).project?.root ?? ''
  expect(root).toContain(second.id)
  expect(readFileSync(join(root, 'frames', `${there.frames[0].id}.html`), 'utf8')).toBe(page)
  expect(there.frames[0]).toMatchObject({ name: 'Mobile', width: 390, height: 844 })

  // In a frame's name, ⌘C and ⌘V are the field's: the board leaves them to it.
  await expect(chrome.locator(`[data-frame="${there.frames[0].id}"]`).last()).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await chrome.keyboard.press('F2')
  const field = area.getByRole('textbox', { name: 'Frame name' })
  await expect(field).toBeFocused()
  const before = await clipboard()
  // Dispatched rather than pressed, so the field's own copy doesn't reach the real clipboard.
  const taken = await field.evaluate((input) =>
    ['c', 'v', 'x'].map(
      (key) =>
        !input.dispatchEvent(
          new KeyboardEvent('keydown', {
            key,
            code: `Key${key.toUpperCase()}`,
            metaKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
    ),
  )
  expect(taken).toEqual([false, false, false])
  await chrome.keyboard.press('Escape')
  expect(await clipboard()).toEqual(before)
  expect((await board(session)).frames).toHaveLength(1)
})
