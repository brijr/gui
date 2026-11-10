import type { Page } from '@playwright/test'
import type { BoardState } from '../src/shared/types'
import { waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// The canvas board's WebGL canvas: what it does when its GPU context is lost, when the
// appearance changes, when the display's scale does, and when WebGL2 can't start at all.

/** The board's background, --canvas, in light and dark (styles.css). */
const CANVAS = { light: [236, 236, 236], dark: [14, 14, 15] }

/** A canvas with two captured frames, fitted, every thumbnail drawn. */
async function openBoard(session: GuiSession): Promise<BoardState> {
  const { chrome } = session
  await chrome.getByRole('button', { name: /New canvas/ }).click()
  await waitFor(async () => (await session.state()).board, 'the canvas')
  await chrome.evaluate(() => {
    window.gui.boardAddFrame('desktop', null)
    window.gui.boardAddFrame('desktop', null)
  })
  const board = await waitFor(async () => {
    const board = (await session.state()).board
    return board?.frames.length === 2 && board.frames.every((frame) => frame.captured)
      ? board
      : null
  }, 'two captured frames')
  await waitFor(async () => (await thumbWidths(chrome)).every((width) => width > 0), 'thumbnails')
  return board
}

/** The width of the texture each frame's tile says the canvas holds for it. */
const thumbWidths = (chrome: Page) =>
  chrome.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-frame]')].map((tile) =>
      Number(tile.dataset.thumb ?? 0),
    ),
  )

/**
 * The colour most of the board's top-left corner is on screen (empty board: the background),
 * from a capture of the page: a WebGL canvas that doesn't keep its drawing buffer reads back
 * blank from script once it has been shown.
 */
async function corner(chrome: Page) {
  const box = await chrome.locator('[role="application"]').boundingBox()
  if (!box) return null
  const png = await chrome.screenshot({ clip: { x: box.x, y: box.y, width: 16, height: 16 } })
  return chrome.evaluate(async (data) => {
    const image = new Image()
    image.src = `data:image/png;base64,${data}`
    await image.decode()
    const context = new OffscreenCanvas(image.width, image.height).getContext('2d')
    if (!context) return null
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, image.width, image.height).data
    const counts = new Map<string, number>()
    for (let at = 0; at < pixels.length; at += 4) {
      const key = `${pixels[at]},${pixels[at + 1]},${pixels[at + 2]}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const [key] = [...counts].sort((a, b) => b[1] - a[1])[0]
    return key.split(',').map(Number)
  }, png.toString('base64'))
}

const near = (color: number[] | null, expected: number[]) =>
  !!color && color.every((value, index) => Math.abs(value - expected[index]) <= 2)

test('the canvas draws the board again after its GPU context is lost', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { chrome } = session
  await chrome.emulateMedia({ colorScheme: 'light' })
  await openBoard(session)
  await waitFor(async () => near(await corner(chrome), CANVAS.light), 'the board drawn')
  const before = await thumbWidths(chrome)

  // As a driver reset or a GPU process restart does: the textures go with the context. The
  // extension is kept: a lost context gives none.
  await chrome.evaluate(() => {
    const extension = document
      .querySelector<HTMLCanvasElement>('[role="application"] canvas')
      ?.getContext('webgl2')
      ?.getExtension('WEBGL_lose_context')
    if (!extension) throw new Error('No WEBGL_lose_context')
    ;(window as unknown as { loseContext: typeof extension }).loseContext = extension
    extension.loseContext()
  })
  await waitFor(
    async () => (await thumbWidths(chrome)).every((width) => width === 0),
    'textures gone with the context',
  )
  await chrome.evaluate(() =>
    (window as unknown as { loseContext: WEBGL_lose_context }).loseContext.restoreContext(),
  )
  await waitFor(
    async () => (await thumbWidths(chrome)).join() === before.join(),
    'every thumbnail drawn again',
  )
  expect(near(await corner(chrome), CANVAS.light)).toBe(true)
})

test('the canvas follows the appearance and the display’s scale', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { chrome } = session
  await openBoard(session)

  for (const colorScheme of ['dark', 'light'] as const) {
    await chrome.emulateMedia({ colorScheme })
    await waitFor(async () => near(await corner(chrome), CANVAS[colorScheme]), colorScheme)
  }

  // As if the window moved to a display of another scale: the canvas's backing store stays
  // its size in device pixels, and the thumbnails' widths (chosen in device pixels) follow.
  // A test can't move the window to another display, and Chromium's emulated scale changes
  // devicePixelRatio but not what the canvas is drawn at; zooming the page changes the same
  // ratio of device pixels to CSS pixels, through the same observer.
  const backing = () =>
    chrome.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[role="application"] canvas')
      return canvas
        ? { width: canvas.width, css: canvas.clientWidth, scale: devicePixelRatio }
        : null
    })
  const zoomPage = (factor: number) =>
    session.app.evaluate(({ webContents }, factor) => {
      webContents
        .getAllWebContents()
        .find((contents) => /\/index\.html(?:[?#]|$)/.test(contents.getURL()))
        ?.setZoomFactor(factor)
    }, factor)
  const start = await backing()
  if (!start) throw new Error('No canvas')
  expect(start.width).toBe(Math.round(start.css * start.scale))
  const widths = await thumbWidths(chrome)
  const factor = start.scale >= 2 ? 0.5 : 2
  const scale = start.scale * factor
  await zoomPage(factor)
  try {
    await waitFor(async () => {
      const now = await backing()
      return now?.scale === scale && now.width === Math.round(now.css * scale)
    }, `a backing store at ${scale}×`)
    await waitFor(async () => {
      const now = await thumbWidths(chrome)
      return now.every((width, index) =>
        factor < 1 ? width < widths[index] : width > widths[index],
      )
    }, `thumbnails for ${scale}×`)
  } finally {
    await zoomPage(1)
  }
  await waitFor(async () => (await backing())?.scale === start.scale, 'the first scale')
  expect((await backing())?.width).toBe(start.width)
  await waitFor(
    async () => (await thumbWidths(chrome)).join() === widths.join(),
    'the first thumbnails',
  )
})

test('without WebGL2, the board says it can’t be shown', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { chrome } = session
  // As on a Mac whose graphics can't give the window a WebGL2 context.
  await chrome.evaluate(() => {
    const getContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      type: string,
      ...rest: unknown[]
    ) {
      return type === 'webgl2' ? null : getContext.call(this, type, ...(rest as []))
    } as typeof getContext
  })
  await chrome.getByRole('button', { name: /New canvas/ }).click()
  await expect(chrome.getByText('This canvas can’t be shown')).toBeVisible()
  await expect(chrome.locator('[role="application"]')).toHaveCount(0)
})
