import { readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { OUTSIDE_TOOL_NAMES } from '../src/main/outside-mcp'
import type { BoardState, SettingsState } from '../src/shared/types'
import { waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
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
