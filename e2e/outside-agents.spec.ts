import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { OUTSIDE_TOOL_NAMES } from '../src/main/outside-mcp'
import { AGENTS, type BoardState, type SettingsState } from '../src/shared/types'
import { waitFor } from './helpers/env'
import { type GuiSession, standInsFile } from './helpers/session'
import { expect, test } from './helpers/test'

// "Let other agents use Gui" (Settings → Agents): an agent outside Gui reaches Gui's tools at
// a fixed loopback address with the token from Settings, and its calls act on the canvas open
// in Gui's front window. Talked to over fetch, as Claude Code would: no agent, no usage.

async function freePort() {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return port
}

async function settingsPage(session: GuiSession): Promise<Page> {
  await session.chrome.evaluate(() => window.gui.openSettings('agents'))
  const find = () =>
    session.app
      .context()
      .pages()
      .find((page) => page.url().endsWith('/settings.html'))
  const page = await waitFor(find, 'the Settings window', { timeout: 30_000 })
  await page.waitForFunction(() => 'gui' in window)
  return page
}

function settingsWhere(page: Page, label: string, check: (settings: SettingsState) => boolean) {
  return waitFor(async () => {
    const settings = await page.evaluate(() => window.gui.getSettings())
    return check(settings) ? settings : null
  }, label)
}

test('other agents use the canvas in the front window once Settings lets them', async ({
  launch,
}) => {
  const port = await freePort()
  const session = await launch({
    fixture: 'vite',
    open: 'recent',
    env: { GUI_E2E_OUTSIDE_MCP_PORT: String(port) },
  })
  await session.chrome.getByRole('button', { name: /New canvas/ }).click()
  const board = await waitFor<BoardState | null>(
    async () => (await session.state()).board,
    'the canvas',
  )
  const url = `http://127.0.0.1:${port}/mcp`

  // Off by default: nothing listens.
  await expect(fetch(url, { method: 'POST' })).rejects.toThrow()

  const settings = await settingsPage(session)
  const toggle = settings.getByRole('switch', { name: 'Let other agents use Gui' })
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  const on = await settingsWhere(settings, 'listening', (state) => state.outsideAgents.on)
  expect(on.outsideAgents).toEqual({ on: true, port, error: null })
  // The setting shows at once; the server listens a moment later.
  await waitFor(
    () =>
      fetch(url, { method: 'POST' }).then(
        (reply) => reply.status === 401,
        () => false,
      ),
    'Gui listening for other agents',
  )

  // The token is kept owner-only in Gui's data folder, and the page never shows it.
  const tokenFile = join(session.fixture.userData, 'outside-agents-token')
  expect(statSync(tokenFile).mode & 0o777).toBe(0o600)
  const token = readFileSync(tokenFile, 'utf8').trim()
  expect(token).toMatch(/^[0-9a-f]{64}$/)
  const setup = settings.locator('pre')
  await expect(setup).toContainText(`claude mcp add --transport http gui ${url}`)
  await expect(setup).not.toContainText(token)

  let id = 0
  const rpc = async (method: string, params: unknown = {}, auth = `Bearer ${token}`) => {
    const reply = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: auth,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    })
    return { status: reply.status, body: reply.status === 200 ? await reply.json() : null }
  }
  const call = async (name: string) => {
    const { body } = await rpc('tools/call', { name, arguments: {} })
    const result = body.result as { isError?: boolean; content: { text: string }[] }
    return { isError: result.isError === true, text: result.content.map((c) => c.text).join('\n') }
  }

  expect((await rpc('tools/list', {}, 'Bearer nope')).status).toBe(401)
  const hello = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '1' },
  })
  expect(hello.status).toBe(200)
  expect(hello.body.result.instructions).toContain('gui_status')

  const listed = await rpc('tools/list')
  const names = (listed.body.result.tools as { name: string }[]).map((tool) => tool.name)
  expect(names.sort()).toEqual([...OUTSIDE_TOOL_NAMES].sort())

  const status = await call('gui_status')
  expect(status.isError).toBe(false)
  expect(status.text).toContain(`canvas “${board?.name}”`)
  expect(status.text).toContain('no frame open')

  const frames = await call('canvas_list_frames')
  expect(frames.isError).toBe(false)

  // Off again: nothing listens.
  await toggle.click()
  await settingsWhere(settings, 'stopped', (state) => !state.outsideAgents.on)
  await expect(fetch(url, { method: 'POST' })).rejects.toThrow()
})

/** Calls Gui's tools for other agents at `url` with `token`, as an outside agent would. */
function client(url: string, token: string) {
  let id = 0
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++id,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    })
    const result = (await reply.json()).result as {
      isError?: boolean
      content: { text: string }[]
    }
    return { isError: result.isError === true, text: result.content.map((c) => c.text).join('\n') }
  }
  return { call }
}

test('from the start screen, another agent opens a canvas, which has no chat until the user shows it', async ({
  launch,
}) => {
  const port = await freePort()
  const session = await launch({
    fixture: 'vite',
    open: 'recent',
    env: { GUI_E2E_OUTSIDE_MCP_PORT: String(port) },
  })
  const { base, userData } = session.fixture

  // Every agent Gui could start is a stand-in that writes the folder it's started in and
  // quits: no agent login, no usage.
  const runs = join(base, 'agent-runs.txt')
  const script = join(base, 'marker-agent.sh')
  writeFileSync(script, `#!/bin/sh\npwd -P >> '${runs}'\nexit 1\n`, { mode: 0o755 })
  writeFileSync(
    standInsFile(session.fixture),
    JSON.stringify(Object.fromEntries(AGENTS.map((agent) => [agent.id, { command: script }]))),
  )
  const started = () => (existsSync(runs) ? readFileSync(runs, 'utf8').split('\n') : [])

  // A canvas made earlier, closed again: back on the start screen.
  await session.chrome.getByRole('button', { name: /New canvas/ }).click()
  const made = await waitFor<BoardState | null>(
    async () => (await session.state()).board,
    'the canvas',
  )
  const canvasTab = (await session.state()).activeTab
  await session.chrome.evaluate((tab) => {
    window.gui.newTab()
    window.gui.closeTab(tab)
  }, canvasTab)
  await waitFor(async () => {
    const state = await session.state()
    return state.tabs.length === 1 && state.project === null
  }, 'the start screen')

  const settings = await settingsPage(session)
  await settings.getByRole('switch', { name: 'Let other agents use Gui' }).click()
  const url = `http://127.0.0.1:${port}/mcp`
  await waitFor(
    () =>
      fetch(url, { method: 'POST' }).then(
        (reply) => reply.status === 401,
        () => false,
      ),
    'Gui listening for other agents',
  )
  const token = readFileSync(join(userData, 'outside-agents-token'), 'utf8').trim()
  const { call } = client(url, token)

  // Nothing open: the error says how to open something.
  const nothing = await call('canvas_list_frames')
  expect(nothing.isError).toBe(true)
  expect(nothing.text).toContain('gui_open')

  const listed = await call('gui_list')
  expect(listed.isError).toBe(false)
  expect(listed.text).toContain(`"id":"${made?.id}"`)
  expect(listed.text).toContain('"current":null')

  const opened = await call('gui_open', { canvas: made?.id })
  expect(opened.isError).toBe(false)
  expect(opened.text).toContain(`canvas “${made?.name}”`)

  // In the start screen's tab, with no chat panel.
  const state = await session.state()
  expect(state.tabs).toHaveLength(1)
  expect(state.board?.id).toBe(made?.id)
  expect(state.chatVisible).toBe(false)

  // The canvas tools act on it.
  const frames = await call('canvas_list_frames')
  expect(frames.isError).toBe(false)
  expect((await call('gui_status')).text).toContain(`canvas “${made?.name}”`)

  // No agent of Gui's started for it.
  const canvasRoot = realpathSync(state.project?.root ?? '')
  await new Promise((resolve) => setTimeout(resolve, 1500))
  expect(started()).not.toContain(canvasRoot)
  // The first tab, and its chat page, closed with the canvas: this tab's is the one left.
  const chat = await waitFor(() => {
    const pages = session.app
      .context()
      .pages()
      .filter((page) => page.url().endsWith('/chat.html') && !page.isClosed())
    return pages.length === 1 ? pages[0] : null
  }, "the tab's chat page")
  const snapshot = await chat.evaluate(() => window.gui.getChat())
  expect(snapshot.meta.status).toBe('idle')
  expect(snapshot.turns).toEqual([])

  // The user shows the chat (⌘B): from then on it's a chat like any other, and the first
  // message starts the agent (the stand-in, which quits at once) in the canvas.
  await session.chrome.evaluate(() => window.gui.toggleChat())
  await waitFor(async () => (await session.state()).chatVisible, 'the chat to show')
  expect(await chat.evaluate(() => window.gui.send('Hello'))).toBe(true)
  await waitFor(async () => started().includes(canvasRoot), 'the agent to start in the canvas')
})
