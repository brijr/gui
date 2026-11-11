import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'
import { ask, installToolAgent } from './helpers/tool-agent'

// The agent's input moves the way a person's would while the user watches (input-pace.ts):
// the page eases to a far target, text arrives a few characters at a time, the wheel slows to
// a stop. With Reduce motion each goes at once. The input lands the same either way.

const APP = `import { useState } from 'react'
export default function App() {
  const [clicked, setClicked] = useState(false)
  const [value, setValue] = useState('')
  return <main>
    <h1>Motion fixture</h1>
    <div style={{ height: 2400 }} />
    <button id="far" onClick={() => setClicked(true)}>Far away</button>
    {clicked && <p>Clicked</p>}
    <input id="field" value={value} onChange={event => setValue(event.target.value)} />
    <div style={{ height: 3000 }} />
  </main>
}`

async function setup(session: GuiSession) {
  await session.waitForPreview()
  writeFileSync(join(session.fixture.root, 'src', 'App.tsx'), APP)
  const page = await session.previewPage()
  await expect(page.locator('h1')).toHaveText('Motion fixture')
  await installToolAgent(session)
  // Every frame's scroll, and every input event's value.
  await page.evaluate(() => {
    const record = window as unknown as { scrolls: number[]; values: string[] }
    record.scrolls = []
    record.values = []
    const frame = () => {
      record.scrolls.push(Math.round(scrollY))
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
    addEventListener('input', (event) =>
      record.values.push((event.target as HTMLInputElement).value),
    )
  })
  return page
}

/** Scroll positions the page showed strictly between `from` and `to` since the last call. */
async function between(page: Page, from: number, to: number) {
  const scrolls = await page.evaluate(() => {
    const record = window as unknown as { scrolls: number[] }
    const seen = record.scrolls
    record.scrolls = []
    return seen
  })
  const [low, high] = from < to ? [from, to] : [to, from]
  return new Set(scrolls.filter((y) => y > low + 1 && y < high - 1)).size
}

const values = (page: Page) =>
  page.evaluate(() => (window as unknown as { values: string[] }).values.splice(0))

test('watched, the agent scrolls to a target, types and wheels over several frames', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const page = await setup(session)

  const [clicked] = await ask(session, [{ name: 'preview_click', args: { selector: '#far' } }])
  expect(clicked.isError, JSON.stringify(clicked)).not.toBe(true)
  await expect(page.getByText('Clicked', { exact: true })).toBeVisible()
  const revealed = await page.evaluate(() => scrollY)
  expect(revealed).toBeGreaterThan(1000)
  expect(await between(page, 0, revealed)).toBeGreaterThan(3)

  const [typed] = await ask(session, [
    { name: 'preview_type', args: { selector: '#field', text: 'Hello there' } },
  ])
  expect(typed.isError, JSON.stringify(typed)).not.toBe(true)
  await expect(page.locator('#field')).toHaveValue('Hello there')
  const typing = await values(page)
  expect(typing.length).toBeGreaterThan(3)
  expect(typing.at(-1)).toBe('Hello there')

  const before = await page.evaluate(() => scrollY)
  await between(page, 0, 0)
  await ask(session, [{ name: 'preview_scroll', args: { deltaY: 900 } }])
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(before + 900)
  expect(await between(page, before, before + 900)).toBeGreaterThan(3)

  // A key the agent presses shows on its pointer.
  const overlay = await session.pickPage()
  await ask(session, [{ name: 'preview_press', args: { key: 'Escape' } }])
  await expect(overlay.locator('[data-guide-key]')).toHaveText('Esc')
})

test('with Reduce motion, each input lands at once', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', reducedMotion: 'reduce' })
  const page = await setup(session)

  await ask(session, [{ name: 'preview_click', args: { selector: '#far' } }])
  await expect(page.getByText('Clicked', { exact: true })).toBeVisible()
  const revealed = await page.evaluate(() => scrollY)
  expect(revealed).toBeGreaterThan(1000)
  expect(await between(page, 0, revealed)).toBe(0)

  await ask(session, [{ name: 'preview_type', args: { selector: '#field', text: 'Hello there' } }])
  await expect(page.locator('#field')).toHaveValue('Hello there')
  expect(await values(page)).toEqual(['Hello there'])

  const before = await page.evaluate(() => scrollY)
  await between(page, 0, 0)
  await ask(session, [{ name: 'preview_scroll', args: { deltaY: 900 } }])
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(before + 900)
  expect(await between(page, before, before + 900)).toBe(0)
})
