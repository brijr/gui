import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'
import { ask, installToolAgent, pageData } from './helpers/tool-agent'

const APP = `import { useRef, useState } from 'react'
export default function App() {
  const [value, setValue] = useState('original')
  const [submitted, setSubmitted] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  return <main>
    <h1>Interaction fixture</h1>
    <button id="open" onClick={() => dialog.current?.showModal()}>Open dialog</button>
    <dialog ref={dialog}><h2>Dialog content</h2><button onClick={() => dialog.current?.close()}>Close</button></dialog>
    <div id="hover" style={{ display: 'inline-block' }}><button>Hover me</button><span id="menu">Hover content</span></div>
    <form onSubmit={event => { event.preventDefault(); setSubmitted(true) }}>
      <label htmlFor="name">Name</label><input id="name" value={value} onChange={event => setValue(event.target.value)} />
      <button id="submit">Submit</button><output id="value">{value}</output>{submitted && <p>Submitted</p>}
    </form>
    <input id="password" type="password" defaultValue="private-value" />
    <button id="disabled" disabled>Disabled</button><button className="duplicate">One</button><button className="duplicate">Two</button>
    <button id="hidden" style={{ display: 'none' }}>Hidden</button>
    <input id="readonly" readOnly value="Read only" />
    <div id="editable" contentEditable suppressContentEditableWarning>Original content</div>
    <div id="covered" style={{ position: 'relative', width: 100, height: 50 }}><button id="under">Under</button><div style={{ position: 'absolute', inset: 0 }}>Cover</div></div>
    <div id="scroller" style={{ height: 100, overflow: 'auto' }}><div style={{ height: 600 }}>Scrollable</div><button id="bottom">Bottom</button></div>
  </main>
}`

async function setup(session: GuiSession) {
  await session.waitForPreview()
  writeFileSync(join(session.fixture.root, 'src', 'App.tsx'), APP)
  writeFileSync(
    join(session.fixture.root, 'src', 'index.css'),
    '#menu { display: none; } #hover:hover #menu { display: block; } main { padding: 10px; }',
  )
  const page = await session.previewPage()
  await expect(page.locator('h1')).toHaveText('Interaction fixture')
  await installToolAgent(session)
  return page
}

test('agent tools discover controls, click, hover, type, press keys and scroll', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const page = await setup(session)
  const [snapshot] = await ask(session, [{ name: 'preview_snapshot' }])
  const data = pageData(snapshot)
  expect(data.elements).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ selector: '#name', name: 'Name', value: 'original' }),
    ]),
  )
  expect(JSON.stringify(data)).not.toContain('private-value')
  expect(
    data.elements.some((element: { selector: string }) => element.selector === '#hidden'),
  ).toBe(false)

  const click = await ask(session, [{ name: 'preview_click', args: { selector: '#open' } }])
  expect(click[0].isError).not.toBe(true)
  await expect(page.locator('dialog')).toBeVisible()
  await ask(session, [{ name: 'preview_press', args: { key: 'Escape' } }])
  await expect(page.locator('dialog')).not.toBeVisible()
  await ask(session, [{ name: 'preview_hover', args: { selector: '#hover button' } }])
  await expect(page.locator('#menu')).toBeVisible()

  const typed = await ask(session, [
    { name: 'preview_type', args: { selector: '#name', text: 'Revised name' } },
  ])
  expect(typed[0].isError, JSON.stringify(typed)).not.toBe(true)
  await expect(page.locator('#name')).toHaveValue('Revised name')
  await expect(page.locator('#value')).toHaveText('Revised name')
  await ask(session, [{ name: 'preview_press', args: { key: 'Tab', selector: '#name' } }])
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('submit')
  await ask(session, [{ name: 'preview_press', args: { key: 'Tab', shift: true } }])
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('name')
  await ask(session, [{ name: 'preview_press', args: { key: 'Enter', selector: '#name' } }])
  await expect(page.getByText('Submitted', { exact: true })).toBeVisible()
  await ask(session, [{ name: 'preview_type', args: { selector: '#name', text: '' } }])
  await expect(page.locator('#value')).toHaveText('')
  const editable = await ask(session, [
    { name: 'preview_type', args: { selector: '#editable', text: 'Revised content' } },
  ])
  expect(editable[0].isError, JSON.stringify(editable)).not.toBe(true)
  await expect(page.locator('#editable')).toHaveText('Revised content')
  await ask(session, [{ name: 'preview_scroll', args: { selector: '#scroller', deltaY: 250 } }])
  await expect
    .poll(() => page.locator('#scroller').evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0)

  // CDP input uses CSS coordinates even when Gui draws the mobile viewport smaller.
  await session.chrome.evaluate(() => window.gui.setViewport('mobile'))
  await ask(session, [
    { name: 'preview_click', args: { selector: '#open' } },
    { name: 'preview_screenshot' },
  ])
  await expect(page.locator('dialog')).toBeVisible()
})

test('agent tools reject ambiguous, hidden, disabled, covered and noneditable targets', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const page = await setup(session)
  const results = await ask(session, [
    { name: 'preview_click', args: { selector: '.duplicate' } },
    { name: 'preview_click', args: { selector: '#missing' } },
    { name: 'preview_click', args: { selector: '#disabled' } },
    { name: 'preview_click', args: { selector: '#hidden' } },
    { name: 'preview_click', args: { selector: '#under' } },
    { name: 'preview_type', args: { selector: '#readonly', text: 'wrong' } },
    { name: 'preview_type', args: { selector: '#open', text: 'wrong' } },
  ])
  expect(results.every((result) => result.isError)).toBe(true)
  expect(results[0].content[0].text).toContain('unique selector')
  await expect(page.locator('#readonly')).toHaveValue('Read only')
  await page.goto('data:text/html,<button id="remote">Outside app</button>')
  const denied = await ask(session, [{ name: 'preview_click', args: { selector: '#remote' } }])
  expect(denied[0].isError).toBe(true)
  expect(denied[0].content[0].text).toContain('local dev server')
})

test('agent can edit, view, revise and view again within one turn', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await setup(session)
  const results = await ask(session, [
    { css: 'h1 { color: rgb(255, 0, 0); }' },
    { name: 'preview_screenshot', args: { selector: 'h1' } },
    { name: 'preview_inspect', args: { selector: 'h1' } },
    { css: 'h1 { color: rgb(0, 0, 255); }' },
    { name: 'preview_screenshot', args: { selector: 'h1', width: 390 } },
    { name: 'preview_inspect', args: { selector: 'h1' } },
    { name: 'preview_console' },
  ])
  expect(results.every((result) => !result.isError)).toBe(true)
  expect(results[0].content[0].bytes).toBeGreaterThan(0)
  expect(pageData(results[1]).styles.color).toBe('rgb(255, 0, 0)')
  expect(results[2].content[0].bytes).toBeGreaterThan(0)
  expect(pageData(results[3]).styles.color).toBe('rgb(0, 0, 255)')
  expect(results[4].content[0].text).toContain('No current errors.')
  const { turns } = await session.chatSnapshot()
  expect(turns).toHaveLength(1)
  expect(turns[0].changes).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: 'src/index.css' })]),
  )
})

test('a walkthrough points out elements with captions and shows the agent pointer', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const page = await setup(session)
  const overlay = await session.pickPage()

  const [pointed, clicked] = await ask(session, [
    { name: 'preview_point', args: { selector: '#open', caption: 'This opens the dialog.' } },
    { name: 'preview_click', args: { selector: '#open' } },
  ])
  expect(pointed.isError, JSON.stringify(pointed)).not.toBe(true)
  expect(pointed.content[0].text).toContain('Shown')
  expect(clicked.isError).not.toBe(true)
  await expect(page.locator('dialog')).toBeVisible()

  // The last step stays a moment after the turn, over the page and out of its screenshots.
  await expect(overlay.getByRole('status')).toHaveText('This opens the dialog.')
  await expect(overlay.locator('[data-guide-outline]')).toBeVisible()
  expect(await page.locator('text=This opens the dialog.').count()).toBe(0)

  // Each step replaces the last: one outline, at the new element.
  await ask(session, [
    { name: 'preview_point', args: { selector: '#name', caption: 'Type a name here.' } },
    { name: 'preview_point', args: { selector: '#submit', caption: 'Then send it.' } },
  ])
  await expect(overlay.getByRole('status')).toHaveText('Then send it.')
  await expect(overlay.locator('[data-guide-outline]')).toHaveCount(1)

  const [missing] = await ask(session, [
    { name: 'preview_point', args: { selector: '#missing', caption: 'Nothing here' } },
  ])
  expect(missing.isError).toBe(true)

  // A click hands the pointer back to the user.
  await overlay.locator('[data-guide-outline]').locator('..').dispatchEvent('pointerdown')
  await expect(overlay.getByRole('status')).toHaveCount(0)
})

test('the agent’s pointer shows for every click, walkthrough or not', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  const page = await setup(session)
  const overlay = await session.pickPage()

  const [clicked] = await ask(session, [{ name: 'preview_click', args: { selector: '#open' } }])
  expect(clicked.isError, JSON.stringify(clicked)).not.toBe(true)
  await expect(page.locator('dialog')).toBeVisible()
  // The pointer, with no caption or outline: the agent is using the app, not pointing things out.
  await expect(overlay.locator('[data-guide-pointer]')).toBeVisible()
  await expect(overlay.locator('[data-guide-outline]')).toHaveCount(0)
  await expect(overlay.getByRole('status')).toHaveCount(0)
})
