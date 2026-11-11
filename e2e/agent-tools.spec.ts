import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'
import { ask, installToolAgent, pageData, type ToolResult } from './helpers/tool-agent'

// What the agent's tools refuse to do without the user: run a dev script it changed, or act on
// a page that isn't the user's app. docs/architecture.md ("Preview tools for the agent").

const text = (result: ToolResult) => result.content.map((item) => item.text ?? '').join('\n')

/** package.json with its dev script changed, as an agent's edit would leave it. */
function changedPackage(session: GuiSession, dev: string) {
  const pkg = JSON.parse(readFileSync(join(session.fixture.root, 'package.json'), 'utf8'))
  pkg.scripts.dev = dev
  return { path: 'package.json', text: JSON.stringify(pkg, null, 2) }
}

test('a dev script the agent changed asks before its restart runs it', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  await installToolAgent(session)
  await session.declineConsentDialogs()

  const [restarted] = await ask(session, [
    { write: changedPackage(session, 'vite --clearScreen false') },
    { name: 'dev_server_restart' },
  ])
  const prompts = await session.consentPrompts()
  expect(prompts.length).toBeGreaterThan(0)
  expect(prompts[0].message).toContain('scripts changed')
  expect(prompts[0].detail).toContain('vite --clearScreen false')
  expect(text(restarted)).toContain('declined')
  // Nothing ran it, so nothing was recorded as agreed to.
  const state = await session.state()
  expect(state.devServer.status).not.toBe('running')

  // Asked once: not again as the turn ends, nor when the agent tries the same restart again.
  const [again] = await ask(session, [{ name: 'dev_server_restart' }])
  expect(text(again)).toContain('declined')
  await new Promise((resolve) => setTimeout(resolve, 1500))
  expect(await session.consentPrompts()).toHaveLength(1)
})

test('a dev script the agent changed during a turn asks before it runs at the turn end', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  await installToolAgent(session)
  await session.declineConsentDialogs()

  // The user watched the turn, but didn't see the script: it asks all the same.
  await ask(session, [{ write: changedPackage(session, 'vite --clearScreen false') }])
  const [prompt] = await waitFor(async () => {
    const prompts = await session.consentPrompts()
    return prompts.length > 0 ? prompts : null
  }, 'the changed script prompt')
  expect(prompt?.message).toContain('scripts changed')
  expect(prompt?.detail).toContain('vite --clearScreen false')
  await waitFor(async () => (await session.state()).devServer.status === 'idle', 'the stop')
})

test("going back to the detected command asks when the project's script changed", async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  await installToolAgent(session)
  await session.acceptConsentDialogs()

  // The user agrees to the agent's command, which runs from then on.
  const [set] = await ask(session, [
    { name: 'set_start_command', args: { command: 'bun run dev' } },
  ])
  expect(set.isError, text(set)).not.toBe(true)
  await waitFor(
    async () => (await session.state()).project?.custom?.command === 'bun run dev',
    'the start command saved',
  )
  const agreedToCommand = (await session.consentPrompts()).length
  expect(agreedToCommand).toBe(1)

  // Then it changes the script and goes back to it: that asks again, as a new command would.
  await session.declineConsentDialogs()
  const [reset] = await ask(session, [
    { write: changedPackage(session, 'vite --clearScreen false') },
    { name: 'set_start_command', args: { reset: true } },
  ])
  const prompts = await session.consentPrompts()
  expect(prompts.length).toBeGreaterThan(agreedToCommand)
  expect(prompts[agreedToCommand].message).toContain('scripts changed')
  expect(text(reset)).toContain('declined')
})

test("the app's tools refuse another server on this machine the app links to", async ({
  launch,
}) => {
  // Another project's server, a database UI, a notebook: local, but not the user's app.
  const other = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><title>Notebook</title><button id="run">Run all</button>')
  })
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve))
  const port = (other.address() as AddressInfo).port
  try {
    const session = await launch({ fixture: 'vite' })
    await session.waitForPreview()
    writeFileSync(
      join(session.fixture.root, 'src', 'App.tsx'),
      `export default function App() {
  return <main style={{ height: 3000 }}>
    <h1>Linked</h1>
    <a id="away" href="http://localhost:${port}/">Notebook</a>
    <button id="low" style={{ marginTop: 1500 }}>Low</button>
  </main>
}`,
    )
    const page = await session.previewPage()
    await expect(page.locator('h1')).toHaveText('Linked')
    await installToolAgent(session)

    // Its box is in page pixels: scrolled 1000px down, it's still where the page has it.
    await page.evaluate(() => window.scrollTo(0, 1000))
    const [inspected] = await ask(session, [
      { name: 'preview_inspect', args: { selector: '#low' } },
    ])
    const element = pageData(inspected)
    expect(element.pageBox.y).toBeGreaterThan(1500)
    expect(element).not.toHaveProperty('rect')
    expect(element).not.toHaveProperty('id')

    const [followed, snapshot, clicked, back] = await ask(session, [
      { name: 'preview_click', args: { selector: '#away' } },
      { wait: 1500 },
      { name: 'preview_snapshot' },
      { name: 'preview_click', args: { selector: '#run' } },
      { name: 'preview_navigate', args: { path: '/' } },
    ])
    expect(followed.isError, text(followed)).not.toBe(true)
    expect(snapshot.isError).toBe(true)
    expect(text(snapshot)).toContain("not showing the user's app")
    expect(clicked.isError).toBe(true)
    expect(back.isError, text(back)).not.toBe(true)
    await expect(page.locator('h1')).toHaveText('Linked')
  } finally {
    other.close()
  }
})

test('the agent waits for what it expects, goes back, and reads hover styles without hovering', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  writeFileSync(
    join(session.fixture.root, 'src', 'App.tsx'),
    `import { useState } from 'react'
export default function App() {
  const [saved, setSaved] = useState(false)
  const save = () => setTimeout(() => setSaved(true), 600)
  return <main>
    <h1>{location.pathname === '/next' ? 'Next page' : 'Waiting'}</h1>
    <button id="save" onClick={save}>Save</button>
    {saved && <p id="toast">Saved!</p>}
    <a id="next" href="/next">Next</a>
  </main>
}`,
  )
  writeFileSync(
    join(session.fixture.root, 'src', 'index.css'),
    '#save { color: rgb(0, 0, 0); transition: color 200ms } #save:hover { color: rgb(255, 0, 0) } #save:focus-visible { outline: 3px solid rgb(0, 0, 255) }',
  )
  const page = await session.previewPage()
  await expect(page.locator('h1')).toHaveText('Waiting')
  await installToolAgent(session)

  const [clicked, shown, notThere, waited, , inspected] = await ask(session, [
    { name: 'preview_click', args: { selector: '#save' } },
    { name: 'preview_wait', args: { selector: '#toast', text: 'Saved!' } },
    { name: 'preview_wait', args: { text: 'Never appears', ms: 300 } },
    { name: 'preview_wait', args: { ms: 50 } },
    // The click left the pointer on the button; off it, its own styles aren't its hover's.
    { name: 'preview_hover', args: { selector: 'h1' } },
    { wait: 500 },
    { name: 'preview_inspect', args: { selector: '#save', states: ['hover', 'focus'] } },
  ])
  expect(clicked.content[0].text).toBe('Clicked.')
  expect(text(shown)).toMatch(/showed after \d+ms/)
  expect(text(notThere)).toContain("didn't show after 300ms")
  expect(text(waited)).toBe('Waited 50ms.')
  const element = pageData(inspected)
  expect(element.styles.color).toBe('rgb(0, 0, 0)')
  // Read once the transition finished, not where it starts.
  expect(element.states.hover.color).toBe('rgb(255, 0, 0)')
  expect(element.states.focus.outline).toContain('rgb(0, 0, 255)')

  // Loaded fresh first: going back reuses the browser's copy of a page, and the first load's
  // is from before this test rewrote the app.
  const [, followed, arrived, back, home, noFurther] = await ask(session, [
    { name: 'preview_navigate', args: { path: '/' } },
    { name: 'preview_click', args: { selector: '#next' } },
    { name: 'preview_wait', args: { text: 'Next page' } },
    { name: 'preview_back' },
    { name: 'preview_wait', args: { text: 'Waiting' } },
    { name: 'preview_back' },
  ])
  expect(followed.isError).toBeFalsy()
  expect(text(arrived)).toContain('showed')
  expect(back.isError, text(back)).toBeFalsy()
  expect(text(back)).toContain('Went back')
  expect(text(home)).toContain('showed')
  // Before the app's first page there's nothing of the app's to go back to.
  expect(noFurther.isError).toBe(true)
  expect(text(noFurther)).toContain('Nothing earlier')
})

test("the dev server tool gives its status and output; Gui's own tools read this chat", async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  await installToolAgent(session)
  await ask(session, [{ write: { path: 'src/note.txt', text: 'first change' } }])
  const [logs, turns, versions] = await ask(session, [
    { name: 'dev_server_logs', args: { lines: 5 } },
    { name: 'chat_turns' },
    { name: 'versions_list' },
  ])
  expect(text(logs)).toContain('running')
  expect(text(logs)).toContain('Latest output:')
  expect(text(turns)).toContain('TOOLS')
  expect(text(turns)).toContain('src/note.txt')
  expect(text(versions)).toMatch(/Versions \(\d+, newest first/)
})
