import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './helpers/test'
import { ask, installToolAgent, type ToolResult } from './helpers/tool-agent'

// A CSS transition (#panel, on a class the button toggles), a keyframe animation (#pulse)
// and a reduced-motion path that turns the transition off.
const APP = `export default function App() {
  return <main>
    <h1>Motion fixture</h1>
    <button id="toggle" onClick={() => document.getElementById('panel')?.classList.toggle('open')}>Toggle</button>
    <div id="panel">Panel</div>
    <div id="pulse">Pulse</div>
  </main>
}`
const CSS = `main { padding: 16px; display: grid; gap: 16px; justify-items: start; }
#panel { width: 200px; height: 80px; background: rgb(37, 99, 235); color: white; opacity: 0.2;
  transition: opacity 300ms ease-out, transform 300ms cubic-bezier(0.2, 0, 0, 1); }
#panel.open { opacity: 1; transform: translateX(160px); }
#pulse { width: 80px; height: 80px; background: rgb(234, 88, 12); animation: pulse 400ms ease-in-out 2; }
@keyframes pulse { 50% { transform: scale(1.4); } }
@media (prefers-reduced-motion: reduce) { #panel { transition: none; } }`

const textOf = (result: ToolResult) =>
  result.content
    .flatMap((item) => (item.type === 'text' && item.text ? [item.text] : []))
    .join('\n')

/** How far a 10 s animation gets in 300 ms: about 300 at normal speed, a quarter slowed 4×. */
const playbackProgress = (page: Page) =>
  page.evaluate(async () => {
    const animation = document.body.animate([{ opacity: 1 }, { opacity: 1 }], 10_000)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const progress = Number(animation.currentTime)
    animation.cancel()
    return progress
  })
const reducedMotion = (page: Page) =>
  page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)

test('preview_motion films a transition and a keyframe animation, and undoes slow and reduced motion', async ({
  launch,
}, testInfo) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  writeFileSync(join(session.fixture.root, 'src', 'App.tsx'), APP)
  writeFileSync(join(session.fixture.root, 'src', 'index.css'), CSS)
  const page = await session.previewPage()
  await expect(page.locator('h1')).toHaveText('Motion fixture')
  await installToolAgent(session)
  const sheet = testInfo.outputPath('motion-sheet.jpg')
  // Each result's text beside the sheet, to read after a run.
  const kept = (name: string, result: ToolResult) => {
    const text = textOf(result)
    writeFileSync(testInfo.outputPath(`${name}.txt`), text)
    return text
  }

  const [clicked, replayed] = await ask(session, [
    {
      name: 'preview_motion',
      args: { play: 'click', selector: '#toggle', durationMs: 500, frames: 6 },
      save: sheet,
    },
    { name: 'preview_motion', args: { play: 'replay', crop: '#pulse', durationMs: 800 } },
  ])
  expect(clicked.isError, textOf(clicked)).not.toBe(true)
  // One image: the contact sheet.
  expect(clicked.content.filter((item) => item.type === 'image')).toHaveLength(1)
  const jpeg = readFileSync(sheet)
  expect(jpeg.subarray(0, 2).toString('hex')).toBe('ffd8')
  expect(jpeg.length).toBeLessThan(4 * 1024 * 1024)
  const clickedText = kept('click', clicked)
  expect(clickedText).toContain('Clicked `#toggle` and filmed 500 ms: 6 frames in one')
  expect(clickedText).toMatch(/CSS transition opacity on div#panel[^\n]*: 300 ms ease-out/)
  expect(clickedText).toMatch(/CSS transition transform on div#panel[^\n]*cubic-bezier/)
  // In CSS pixels, as the stylesheet says, though Chromium reports device pixels.
  expect(clickedText).toContain('transform none → translateX(160px)')
  expect(clickedText).toContain('click button#toggle')
  // Page content is fenced.
  expect(clickedText).toMatch(/<preview_motion_[0-9a-f]{8}>/)
  await expect(page.locator('#panel')).toHaveClass('open')

  expect(replayed.isError, textOf(replayed)).not.toBe(true)
  const replayedText = kept('replay', replayed)
  expect(replayedText).toContain('Replayed 1 animation')
  expect(replayedText).toContain('CSS animation pulse on div#pulse')

  // Slowed 4×, the pulse's two 400 ms runs end near 800 ms in its own time, not 200.
  const [slowed, reduced] = await ask(session, [
    {
      name: 'preview_motion',
      args: { play: 'replay', crop: '#pulse', durationMs: 1000, frames: 4, slowMotion: 4 },
    },
    {
      name: 'preview_motion',
      args: { play: 'click', selector: '#toggle', durationMs: 400, reducedMotion: true },
    },
  ])
  const slowedText = kept('slow-motion', slowed)
  expect(slowed.isError, slowedText).not.toBe(true)
  expect(slowedText).toContain('Slow motion 4×')
  const end = Number(
    /0–(\d+) ms {2}CSS animation pulse on div#pulse[^\n]*ease-in-out/.exec(slowedText)?.[1],
  )
  expect(end).toBeGreaterThan(650)
  expect(end).toBeLessThan(1000)
  // Under reduced motion the fixture turns the transition off.
  const reducedText = kept('reduced-motion', reduced)
  expect(reduced.isError, reducedText).not.toBe(true)
  expect(reducedText).toContain('prefers-reduced-motion: reduce was emulated')
  expect(reducedText).not.toContain('CSS transition opacity')
  expect(reducedText).toContain('class on div#panel')
  expect(await playbackProgress(page)).toBeGreaterThan(240)
  expect(await reducedMotion(page)).toBe(false)

  // Both are undone when filming fails too; caps say what to do instead.
  const [failed, tooLong] = await ask(session, [
    {
      name: 'preview_motion',
      args: { play: 'click', selector: '#missing', slowMotion: 4, reducedMotion: true },
    },
    { name: 'preview_motion', args: { durationMs: 6000 } },
  ])
  expect(failed.isError).toBe(true)
  expect(textOf(failed)).toContain('#missing')
  expect(await playbackProgress(page)).toBeGreaterThan(240)
  expect(await reducedMotion(page)).toBe(false)
  expect(tooLong.isError).toBe(true)
  expect(textOf(tooLong)).toContain('capped at 5000 ms')
})
