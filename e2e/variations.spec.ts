import type { Page } from '@playwright/test'
import type { PanelCorner, Rect } from '../src/shared/types'
import { sleep, waitFor } from './helpers/env'
import { gitStatus } from './helpers/fixtures'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'
import { ask, installToolAgent } from './helpers/tool-agent'

// Variations (docs/variations.md): the agent writes versions of an element behind a switch
// that follows Gui's contract, and preview_variations shows a bar in the preview's bottom-left
// corner to flip them, scrolling the element into view.

/** What Playwright passes to `app.evaluate` callbacks. */
type ElectronModule = typeof import('electron/main')

/** The bar's inset from the preview's edges and its gap from the chat (PANEL_MARGIN) */
const INSET = 12
/** These start with the floating chat in the bottom-left corner (the tests start bottom-right). */
const BOTTOM_LEFT_PREFS = { chatCorner: { x: 'left', y: 'bottom' } satisfies PanelCorner }

/** The fixture's App with a hero in three versions, behind a switch that follows the contract. */
const VARIATIONS_APP = `import { useSyncExternalStore } from 'react'

const KEY = 'gui:variation:hero'
const subscribe = (changed: () => void) => {
  addEventListener('gui:variation', changed)
  return () => removeEventListener('gui:variation', changed)
}
const read = () => localStorage.getItem(KEY) ?? 'original'
const VERSIONS: Record<string, string> = {
  original: 'Ship faster',
  bold: 'Ship faster, today',
  quiet: 'Ship, quietly',
  split: 'Ship faster — together',
}

function Hero() {
  const chosen = useSyncExternalStore(subscribe, read, () => 'original')
  const variant = chosen in VERSIONS ? chosen : 'original'
  return (
    <section data-gui-variation="hero" data-gui-variant={variant} className="hero">
      <h2>{VERSIONS[variant]}</h2>
      <p>Gui shows your app while an agent changes it.</p>
    </section>
  )
}

export default function App() {
  return (
    <main>
      <h1>Gui Vite fixture</h1>
      {/* The hero starts below the fold, so showing it scrolls to it. */}
      <div style={{ height: '150vh' }} />
      <Hero />
    </main>
  )
}
`

const VARIANTS = [
  { id: 'bold', name: 'Bold' },
  { id: 'quiet', name: 'Quiet' },
  { id: 'split', name: 'Split' },
]

/** One message: the agent writes the versions, then shows them. */
async function showVariations(session: GuiSession) {
  await session.waitForPreview()
  const page = await session.previewPage()
  await installToolAgent(session)
  const [shown] = await ask(session, [
    { write: { path: 'src/App.tsx', text: VARIATIONS_APP } },
    { name: 'preview_variations', args: { set: 'hero', variants: VARIANTS } },
  ])
  expect(shown.isError, JSON.stringify(shown)).not.toBe(true)
  expect(shown.content[0].text).toContain('1 of 3 · Bold')
  return { page, overlay: await session.pickPage() }
}

const label = (overlay: Page) => overlay.locator('[data-variation-label]')
const hero = (page: Page) => page.locator('[data-gui-variation="hero"]')

interface Views {
  preview: Rect
  pick: Rect
  /** The floating chat as drawn, without its view's shadow margin */
  chat: Rect
}

/** Runs in main: the first window's preview, pick overlay and chat views. */
function views({ BrowserWindow, WebContentsView }: ElectronModule): Views | null {
  const children = (BrowserWindow.getAllWindows()[0]?.contentView.children ?? []).filter(
    (child): child is InstanceType<typeof WebContentsView> => child instanceof WebContentsView,
  )
  const find = (match: (url: string) => boolean) =>
    children.find((view) => match(view.webContents.getURL()))?.getBounds()
  const preview = find((url) => /^https?:\/\//.test(url))
  const pick = find((url) => url.endsWith('/pick.html'))
  const chat = find((url) => url.endsWith('/chat.html'))
  if (!preview || !pick || !chat) return null
  // Its view's transparent shadow margin (SHADOW), inlined: this runs in main.
  const shadow = 18
  const inner = {
    x: chat.x + shadow,
    y: chat.y + shadow,
    width: chat.width - shadow * 2,
    height: chat.height - shadow * 2,
  }
  return { preview, pick, chat: inner }
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1

/** Waits for the bar, in the window's coordinates, to rest where `check` wants it. */
function barWhere(
  session: GuiSession,
  overlay: Page,
  label: string,
  check: (bar: Rect, views: Views) => boolean,
) {
  return waitFor(async () => {
    const layout = await session.app.evaluate(views)
    const box = await overlay.locator('[data-variations]').boundingBox()
    if (!layout || !box) return null
    const bar = { ...box, x: layout.pick.x + box.x, y: layout.pick.y + box.y }
    return check(bar, layout) ? { bar, layout } : null
  }, label)
}

/** At the preview's bottom edge, `INSET` in. */
const onBottom = (bar: Rect, { preview }: Views) =>
  near(bar.y + bar.height, preview.y + preview.height - INSET)
const inCorner = (bar: Rect, layout: Views) =>
  onBottom(bar, layout) && near(bar.x, layout.preview.x + INSET)
const besideChat = (bar: Rect, layout: Views) =>
  onBottom(bar, layout) && near(bar.x, layout.chat.x + layout.chat.width + INSET)

/** ← or → with the preview's page holding the keyboard. */
function pressInPreview(session: GuiSession, key: 'Left' | 'Right') {
  return session.app.evaluate(({ webContents }, keyCode) => {
    const preview = webContents
      .getAllWebContents()
      .find((wc) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(wc.getURL()))
    preview?.sendInputEvent({ type: 'keyDown', keyCode })
  }, key)
}

test('the bar flips versions in the page, keeps the choice across a reload, and Use this asks the agent to keep it', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const { page, overlay } = await showVariations(session)
  await expect(label(overlay)).toHaveText('1 of 3 · Bold')
  await expect(hero(page)).toHaveAttribute('data-gui-variant', 'bold')
  // Showing the set scrolled the hero, below the fold, into view.
  await expect(hero(page)).toBeInViewport({ ratio: 1 })

  // ‹ ›, and ← → in the bar (the page keeps its own arrow keys); past the last comes the original.
  await overlay.getByRole('button', { name: 'Next version' }).click()
  await expect(label(overlay)).toHaveText('2 of 3 · Quiet')
  await expect(hero(page)).toHaveAttribute('data-gui-variant', 'quiet')
  await overlay.keyboard.press('ArrowRight')
  await expect(label(overlay)).toHaveText('3 of 3 · Split')
  await expect(page.locator('h2')).toHaveText('Ship faster — together')
  await pressInPreview(session, 'Right')
  await expect(label(overlay)).toHaveText('3 of 3 · Split')
  await overlay.keyboard.press('ArrowRight')
  await expect(label(overlay)).toHaveText('Original')
  await expect(hero(page)).toHaveAttribute('data-gui-variant', 'original')
  await overlay.keyboard.press('ArrowLeft')
  await expect(label(overlay)).toHaveText('3 of 3 · Split')
  await overlay.keyboard.press('ArrowLeft')
  await overlay.getByRole('button', { name: 'Previous version' }).click()
  await expect(label(overlay)).toHaveText('1 of 3 · Bold')
  await overlay.getByRole('button', { name: 'Next version' }).click()
  await expect(hero(page)).toHaveAttribute('data-gui-variant', 'quiet')

  // The page keeps showing the choice after a reload.
  await page.reload()
  await expect(hero(page)).toHaveAttribute('data-gui-variant', 'quiet')
  await expect(label(overlay)).toHaveText('2 of 3 · Quiet')

  // Use this: a message asks the agent to keep that version, and the bar goes.
  await overlay.getByRole('button', { name: 'Use this' }).click()
  const { turn } = await session.waitForTurn(1)
  expect(turn.prompt).toContain('Keep "Quiet" (`quiet`) of the "hero" variations as the real code')
  await expect(overlay.locator('[data-variations]')).toHaveCount(0)
})

test('discarding the versions undoes the message that wrote them, asking first about later ones', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const { page, overlay } = await showVariations(session)
  // A later message that changed files too, which discarding undoes with it.
  await ask(session, [{ css: 'h1 { color: rgb(255, 0, 0); }' }])
  expect(gitStatus(session.fixture.root)).not.toBe('')

  // Esc asks first; Esc again keeps them.
  await overlay.keyboard.press('Escape')
  const question = overlay.getByRole('status')
  await expect(question).toHaveText('Undo this and 1 later message? You can redo.')
  await overlay.keyboard.press('Escape')
  await expect(label(overlay)).toHaveText('1 of 3 · Bold')

  await overlay.getByRole('button', { name: 'Discard versions' }).click()
  await expect(question).toBeVisible()
  await overlay.getByRole('button', { name: 'Undo' }).click()
  await waitFor(() => gitStatus(session.fixture.root) === '', 'the files to be restored')
  await expect(overlay.locator('[data-variations]')).toHaveCount(0)
  await expect(hero(page)).toHaveCount(0)
  const { turns } = await session.chatSnapshot()
  expect(turns.map((turn) => turn.reverted)).toEqual([true, true])
})

test("the bar floats at the preview's bottom-left, and flipping scrolls the element into view", async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const { page, overlay } = await showVariations(session)
  await barWhere(session, overlay, "the bar in the preview's bottom-left corner", inCorner)

  // Scrolled away from the hero, the bar stays put; a flip scrolls back to it.
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect(hero(page)).not.toBeInViewport()
  await overlay.getByRole('button', { name: 'Next version' }).click()
  await expect(hero(page)).toHaveAttribute('data-gui-variant', 'quiet')
  await expect(hero(page)).toBeInViewport({ ratio: 1 })
  await barWhere(session, overlay, 'the bar still in its corner', inCorner)
})

test('the bar sits right of a floating chat in the bottom-left corner, and moves with it', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', prefs: BOTTOM_LEFT_PREFS })
  const { overlay } = await showVariations(session)
  await barWhere(session, overlay, 'the bar beside the chat', besideChat)

  // Docked as a sidebar, the chat is beside the preview: the bar goes back to the corner.
  await session.chat.evaluate(() => window.gui.toggleDock())
  await barWhere(session, overlay, 'the bar in the corner beside the sidebar', inCorner)
})

// The bar names the version on the page: it waits for the page to show it, and when the page
// can't (no switch that follows the contract), it never comes up.
test('the bar never shows a version the page does not', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  await installToolAgent(session)
  const overlay = await session.pickPage()
  let seen = false
  let asking = true
  const watch = (async () => {
    while (asking) {
      if ((await overlay.locator('[data-variations]').count()) > 0) seen = true
      await sleep(50)
    }
  })()
  // The hero has no switch: Gui flips nothing the page reads.
  const [shown] = await ask(session, [
    {
      write: {
        path: 'src/App.tsx',
        text: VARIATIONS_APP.replace('data-gui-variant={variant}', 'data-gui-variant="original"'),
      },
    },
    { name: 'preview_variations', args: { set: 'hero', variants: VARIANTS } },
  ])
  asking = false
  await watch
  expect(shown.isError).toBe(true)
  expect(shown.content[0].text).toContain('No bar yet')
  expect(seen).toBe(false)
  await expect(overlay.locator('[data-variations]')).toHaveCount(0)
})
