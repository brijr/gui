import type { Page } from '@playwright/test'
import { sleep, waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// The tab strip moves on springs (src/renderer/src/app/tab-strip.tsx): a new tab grows in, the
// tabs after a closed one slide into its place, and a dropped tab springs from where it was let
// go into its slot. These record every frame of the strip in the chrome page.

interface TabFrame {
  t: number
  tabs: { id: string; left: number; opacity: number }[]
}

interface Store {
  guiTabFrames?: TabFrame[]
  guiTabRecording?: boolean
}

/** Runs in the chrome page: records where each tab is drawn every frame until stopped. */
function startRecording() {
  const store = globalThis as unknown as Store
  const frames: TabFrame[] = []
  const start = performance.now()
  store.guiTabFrames = frames
  store.guiTabRecording = true
  const record = () => {
    const tabs = [...document.querySelectorAll<HTMLElement>('[data-tab]')].map((el) => ({
      id: el.dataset.tab ?? '',
      left: Math.round(el.getBoundingClientRect().left * 10) / 10,
      opacity: Number(getComputedStyle(el).opacity),
    }))
    frames.push({ t: Math.round(performance.now() - start), tabs })
    if (store.guiTabRecording) requestAnimationFrame(record)
  }
  requestAnimationFrame(record)
}

function stopRecording() {
  const store = globalThis as unknown as Store
  store.guiTabRecording = false
  return store.guiTabFrames ?? []
}

/** Where tab `id` was drawn, frame by frame, each position once. */
function lefts(frames: TabFrame[], id: string) {
  const all = frames.flatMap((frame) => frame.tabs.filter((tab) => tab.id === id))
  return all.map((tab) => tab.left).filter((left, i, list) => i === 0 || left !== list[i - 1])
}

const tabIds = async (session: GuiSession) => (await session.state()).tabs.map((tab) => tab.id)

async function record(chrome: Page, act: () => Promise<unknown>, settle = 700) {
  await chrome.evaluate(startRecording)
  await act()
  await sleep(settle)
  return chrome.evaluate(stopRecording)
}

test('tabs grow in, slide into a closed one’s place, and spring into a drop', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { chrome } = session
  await chrome.evaluate(() => window.gui.newTab())
  await waitFor(async () => (await tabIds(session)).length === 2, 'two tabs')
  await expect(chrome.locator('[data-tab]')).toHaveCount(2)
  await sleep(500)

  // A new tab grows in: it fades up over several frames.
  const grow = await record(chrome, async () => {
    await chrome.evaluate(() => window.gui.newTab())
    await waitFor(async () => (await tabIds(session)).length === 3, 'a third tab')
  })
  const third = (await tabIds(session))[2] ?? ''
  const opacities = grow.flatMap((f) => f.tabs.filter((tab) => tab.id === third))
  expect(opacities.some((tab) => tab.opacity > 0.05 && tab.opacity < 0.95)).toBe(true)
  expect(opacities.at(-1)?.opacity).toBe(1)

  // Closing the middle tab: the last one slides left into its place, not jumping there.
  await chrome.evaluate(() => window.gui.newTab())
  await waitFor(async () => (await tabIds(session)).length === 4, 'a fourth tab')
  await sleep(600)
  const [, second, , fourth] = await tabIds(session)
  if (!second || !fourth) throw new Error('Missing tabs')
  const close = await record(chrome, () => chrome.evaluate((id) => window.gui.closeTab(id), second))
  const slid = lefts(close, fourth)
  expect(slid.length).toBeGreaterThan(4)
  for (let i = 1; i < slid.length; i++) expect(slid[i] ?? 0).toBeLessThan(slid[i - 1] ?? 0)

  // Dragged most of the way to the start and let go short of it: it springs from where it was
  // dropped into the first slot.
  const ids = await tabIds(session)
  const last = ids.at(-1) ?? ''
  const box = await chrome.locator(`[data-tab="${last}"]`).boundingBox()
  const first = await chrome.locator(`[data-tab="${ids[0]}"]`).boundingBox()
  const next = await chrome.locator(`[data-tab="${ids[1]}"]`).boundingBox()
  if (!box || !first || !next) throw new Error('The tabs have no layout box')
  const y = box.y + box.height / 2
  // A third of a slot past the first one: it lands there, the nearer.
  const short = (next.x - first.x) / 3
  let releasedAt = 0
  const drop = await record(chrome, async () => {
    await chrome.mouse.move(box.x + 30, y)
    await chrome.mouse.down()
    await chrome.mouse.move(first.x + short + 30, y, { steps: 12 })
    releasedAt = (await chrome.locator(`[data-tab="${last}"]`).boundingBox())?.x ?? 0
    await chrome.mouse.up()
    await waitFor(async () => (await tabIds(session))[0] === last, 'the tab moved first')
  })
  expect(Math.abs(releasedAt - (first.x + short))).toBeLessThan(2)
  const path = lefts(drop, last)
  const after = path.slice(path.findIndex((left) => left < releasedAt - 0.5))
  expect(after.length).toBeGreaterThan(3)
  expect(Math.abs((after.at(-1) ?? 0) - first.x)).toBeLessThan(1)
})
