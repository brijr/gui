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
  // How wide the thumbnail each frame shows is, 0 for none, as the page draws it: an <img> in
  // the tile, or (GUI_BOARD_WEBGL) the texture the canvas holds, which the tile reports. A tile
  // still swapping one <img> for another reads 0 here: `widths` waits for what it settles on.
  await chrome.evaluate(() => {
    const read = (tile: HTMLElement, settled: boolean) => {
      if (tile.dataset.thumb !== undefined) return Number(tile.dataset.thumb)
      const images = [...tile.querySelectorAll('img')]
      if (!settled) return Math.max(0, ...images.map((img) => img.naturalWidth))
      return images.length === 1 && images[0].complete ? images[0].naturalWidth : 0
    }
    const page = window as unknown as {
      thumbWidths: (settled: boolean) => [string, number][]
      thumbProbe: { blank: number }
    }
    page.thumbWidths = (settled) =>
      [...document.querySelectorAll<HTMLElement>('[data-frame]')].map((tile) => [
        tile.dataset.frame ?? '',
        read(tile, settled),
      ])
    // Counts the animation frames where a frame that had shown its thumbnail shows none.
    const shown = new Set<string>()
    const probe = { blank: 0 }
    page.thumbProbe = probe
    const tick = () => {
      for (const [id, width] of page.thumbWidths(false)) {
        if (width > 0) shown.add(id)
        else if (shown.has(id)) probe.blank++
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  const widths = () =>
    chrome.evaluate(() =>
      (window as unknown as { thumbWidths: (settled: boolean) => [string, number][] })
        .thumbWidths(true)
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
