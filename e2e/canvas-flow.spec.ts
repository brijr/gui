import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardManifest } from '../src/shared/board'
import type { BoardState } from '../src/shared/types'
import { waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'
import { ask, installToolAgent } from './helpers/tool-agent'

// A canvas as the user goes back and forth with it: Undo and Redo with the board and the
// agent's turns, a frame open live and back, links between frames, and preview_navigate.
// The agent is a stand-in that runs real canvas and preview tool calls (tool-agent.ts).

async function board(session: GuiSession): Promise<BoardState> {
  return waitFor(async () => (await session.state()).board, 'the canvas')
}

async function openCanvas(session: GuiSession) {
  await session.chrome.getByRole('button', { name: /New canvas/ }).click()
  return board(session)
}

const frameOf = (state: BoardState, id: string) => state.frames.find((frame) => frame.id === id)

const undo = (session: GuiSession) =>
  session.app.evaluate(({ Menu }) => {
    const edit = Menu.getApplicationMenu()?.items.find((item) => item.label === 'Edit')
    edit?.submenu?.items.find((item) => item.label === 'Undo')?.click()
  })

const page = (title: string, body = '') =>
  `<!doctype html><body style="margin:0"><h1>${title}</h1>${body}</body>`

test('new frames take the next free name, however quickly they’re added', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  await openCanvas(session)
  await session.chrome.evaluate(() => {
    for (let i = 0; i < 3; i++) window.gui.boardAddFrame('mobile', null)
  })
  const three = await waitFor(async () => {
    const state = await board(session)
    return state.frames.length === 3 ? state : null
  }, 'three frames')
  expect(three.frames.map((frame) => frame.name)).toEqual(['Mobile', 'Mobile 2', 'Mobile 3'])

  // Deleting one in the middle doesn't free its number for a name already used after it.
  await session.chrome.evaluate(() => window.gui.boardDelete(['mobile-2']))
  await waitFor(async () => (await board(session)).frames.length === 2, 'the frame deleted')
  await session.chrome.evaluate(() => window.gui.boardAddFrame('mobile', null))
  const names = await waitFor(async () => {
    const state = await board(session)
    return state.frames.length === 3 ? state.frames.map((frame) => frame.name) : null
  }, 'the new frame')
  expect(names).toEqual(['Mobile', 'Mobile 3', 'Mobile 4'])
})

test('undo on a canvas: the user’s own change first, never the agent’s turn from a live frame, and turns undo and redo without asking', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  await openCanvas(session)
  await installToolAgent(session)
  // Any native dialog is answered (and recorded) rather than shown.
  await session.acceptConsentDialogs()
  const root = (await session.state()).project?.root ?? ''

  await ask(session, [
    {
      name: 'canvas_create_frame',
      args: { name: 'One', width: 1440, height: 900, html: page('One') },
    },
    {
      name: 'canvas_create_frame',
      args: { name: 'Two', width: 1440, height: 900, html: page('Two'), after: ['one'] },
    },
  ])
  const first = await board(session)
  const one = frameOf(first, 'one')
  const two = frameOf(first, 'two')
  if (!one || !two) throw new Error('The first turn made no frames')
  await ask(session, [
    { name: 'canvas_arrange_frames', args: { frames: [{ id: 'one', x: 6000, y: 2000 }] } },
    {
      name: 'canvas_create_frame',
      args: { name: 'Three', width: 390, height: 844, html: page('Three') },
    },
  ])
  const turns = (await session.chatSnapshot()).turns.map((turn) => turn.id)
  expect(turns).toHaveLength(2)

  // The user moves a frame, then opens another live: Undo takes back the move, not the turn.
  await session.chrome.evaluate(() => window.gui.boardArrange([{ id: 'two', x: 9000, y: 3000 }]))
  await waitFor(async () => frameOf(await board(session), 'two')?.x === 9000, 'the user’s move')
  await session.chrome.evaluate(() => window.gui.boardOpenFrame('three'))
  await waitFor(async () => {
    const state = await session.state()
    return state.board?.open === 'three' && state.preview.visible
  }, 'the frame open live')
  await undo(session)
  await waitFor(async () => {
    const state = await board(session)
    return frameOf(state, 'two')?.x === two.x && state.open === 'three'
  }, 'the move undone, the frame still open')
  // Nothing of the user's left to undo: with a frame open, Undo leaves the turn alone.
  await undo(session)

  // Esc with the window's chrome holding the keyboard goes back to the board, and the frame
  // the user opened isn't left selected.
  // (Real input: main sees the key before the page, which Playwright's protocol keys skip.)
  await session.app.evaluate(({ webContents }) => {
    const chrome = webContents
      .getAllWebContents()
      .find((wc) => /\/index\.html(?:[?#]|$)/.test(wc.getURL()))
    chrome?.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    chrome?.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  })
  const back = await waitFor(async () => {
    const state = await session.state()
    return state.board?.open === null && !state.preview.visible ? state.board : null
  }, 'back on the board')
  expect(back.selection).toEqual([])
  expect(back.frames.map((frame) => frame.id).sort()).toEqual(['one', 'three', 'two'])
  const chat = await session.chatSnapshot()
  expect(chat.turns.map((turn) => turn.reverted)).toEqual([false, false])

  // Moved again and panned: the layout file now differs from how the turn left it.
  await session.chrome.evaluate((id) => {
    window.gui.boardArrange([{ id: 'two', x: 9000, y: 3000 }])
    window.gui.boardCamera({ x: -300, y: -200, zoom: 0.4 }, id)
  }, back.id)
  await waitFor(() => {
    const saved = JSON.parse(readFileSync(join(root, 'canvas.json'), 'utf8')) as BoardManifest
    return saved.frames.find((frame) => frame.id === 'two')?.x === 9000
  }, 'the move saved')

  // Undoing the second turn takes back its frame and its move, keeps the user's later move,
  // and asks nothing: Gui wrote the layout file itself.
  await session.chat.evaluate((id) => window.gui.restoreTurn(id), turns[1])
  await waitFor(async () => {
    const state = await board(session)
    return (
      !frameOf(state, 'three') &&
      frameOf(state, 'one')?.x === one.x &&
      frameOf(state, 'one')?.y === one.y &&
      frameOf(state, 'two')?.x === 9000
    )
  }, 'the second turn undone, the user’s move kept')

  // Undoing the first too leaves the canvas's frames folder in place.
  await session.chat.evaluate((id) => window.gui.restoreTurn(id), turns[0])
  await waitFor(async () => (await board(session)).frames.length === 0, 'the first turn undone')
  expect(existsSync(join(root, 'frames'))).toBe(true)

  // One Redo brings both turns back, where they left their frames (and the user's move).
  await session.chat.evaluate(() => window.gui.redo())
  await waitFor(async () => {
    const state = await board(session)
    return (
      state.frames.length === 3 &&
      frameOf(state, 'one')?.x === 6000 &&
      frameOf(state, 'two')?.x === 9000 &&
      frameOf(state, 'three')?.name === 'Three'
    )
  }, 'both turns redone')
  const redone = await session.chatSnapshot()
  expect(redone.turns.map((turn) => turn.reverted)).toEqual([false, false])
  expect(redone.meta.redoTurnIds).toEqual([])
  const asked = (await session.consentPrompts()).filter((prompt) =>
    /Overwrite/.test(prompt.message),
  )
  expect(asked).toEqual([])
})

test('a link between frames opens the other frame, and preview_navigate opens frames only', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  await openCanvas(session)
  await installToolAgent(session)
  const results = await ask(session, [
    {
      name: 'canvas_create_frame',
      args: {
        name: 'Alpha',
        width: 1440,
        height: 900,
        html: page('Alpha', '<a id="go" href="beta.html" style="font-size:48px">Beta</a>'),
      },
    },
    {
      name: 'canvas_create_frame',
      args: { name: 'Beta', width: 390, height: 844, html: page('Beta') },
    },
    { name: 'preview_navigate', args: { path: '/frames/alpha.html' } },
    { name: 'preview_navigate', args: { path: '/pricing' } },
    { name: 'preview_navigate', args: { path: 'frames/missing.html' } },
  ])
  expect(results[2].isError).toBeFalsy()
  expect(results[2].content[0].text).toContain('/frames/alpha.html')
  expect(results[3].isError).toBe(true)
  expect(results[3].content[0].text).toContain('canvas_open_frame')
  expect(results[4].isError).toBe(true)
  expect(results[4].content[0].text).toContain('canvas_open_frame')
  // The refused paths left the frame open, with nothing over it.
  const opened = await session.state()
  expect(opened.board?.open).toBe('alpha')
  expect(opened.preview.error).toBeNull()

  // Following the link opens Beta: at its own viewport, and the one the agent is told about.
  const [clicked] = await ask(session, [{ name: 'preview_click', args: { selector: '#go' } }])
  expect(clicked.isError).toBeFalsy()
  await waitFor(async () => {
    const state = await session.state()
    return state.board?.open === 'beta' && state.preview.viewport === 'mobile'
  }, 'the linked frame open')

  // The agent's own Esc is for the page: the frame stays open.
  const [pressed] = await ask(session, [{ name: 'preview_press', args: { key: 'Escape' } }])
  expect(pressed.isError).toBeFalsy()
  expect((await session.state()).board?.open).toBe('beta')
})

test('a frame of no device’s size opens live at exactly its size, and the size menu goes to a device and back', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  await openCanvas(session)
  await installToolAgent(session)
  await ask(session, [
    {
      name: 'canvas_create_frame',
      // Phones lay a page out at its meta viewport's width (980px without one).
      args: {
        name: 'Post',
        width: 1080,
        height: 1080,
        html: page('Post').replace(
          '<body',
          '<meta name="viewport" content="width=device-width"><body',
        ),
      },
    },
    { name: 'canvas_open_frame', args: { id: 'post' } },
  ])
  // The live page's own size, read in the preview.
  const inner = () =>
    session.app.evaluate(({ session: sessions, webContents }) => {
      const preview = sessions.fromPartition('persist:gui-preview')
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.session === preview && w.getURL().includes('/frames/post.html'))
      return wc?.executeJavaScript('innerWidth + "x" + innerHeight') ?? null
    })
  const at = (viewport: string, size: string) =>
    waitFor(async () => {
      const state = await session.state()
      const shown =
        state.board?.open === 'post' && state.preview.visible && state.preview.viewport === viewport
      return shown && (await inner()) === size ? state : null
    }, `the frame at ${viewport}`)

  const live = await at('1080x1080', '1080x1080')
  // Drawn smaller to fit the window if need be, like a device frame, and named by its size.
  expect(live.preview.frame?.viewport).toBe('1080x1080')
  expect(live.preview.frame?.scale).toBeLessThanOrEqual(1)
  await expect(session.chrome.getByRole('button', { name: 'Viewport: 1080 × 1080' })).toBeVisible()
  // The agent's own look at the page sees the same size.
  const [snapshot] = await ask(session, [{ name: 'preview_snapshot' }])
  expect(snapshot.content[0].text).toMatch(/"viewport": \{\s*"height": 1080,\s*"width": 1080\s*\}/)

  // A device from the size menu, then the frame's own size again.
  await session.chrome.evaluate(() => window.gui.setViewport('mobile'))
  await at('mobile', '390x844')
  await expect(session.chrome.getByRole('button', { name: 'Viewport: Mobile' })).toBeVisible()
  await session.chrome.evaluate(() => window.gui.setViewport('1080x1080'))
  await at('1080x1080', '1080x1080')

  // Resized while open, it's shown at its new size.
  await ask(session, [
    {
      name: 'canvas_arrange_frames',
      args: { frames: [{ id: 'post', width: 1200, height: 630 }] },
    },
  ])
  await at('1200x630', '1200x630')
})
