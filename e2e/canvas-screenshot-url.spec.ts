import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'
import { ask, installToolAgent, type ToolResult } from './helpers/tool-agent'

// canvas_screenshot_url, through a stand-in agent calling the real MCP server, against a
// website on this machine under a made-up `.test` name (GUI_E2E_WEBSITE, unpackaged builds only).
const HOST = 'reference.gui-e2e.test'

/** Each visit leaves a cookie named for who made it (`?by=`), for the next visit to send back. */
const PAGE = `<!doctype html><title>Reference</title>
<body style="margin:0;background:#1d4ed8;color:#fff"><h1>Reference</h1>
<script>document.cookie = 'by_' + new URLSearchParams(location.search).get('by') + '=1; path=/'</script>`

let server: Server
let url: string
/** Each request's path and Cookie header, in order */
const requests: { path: string; cookie: string }[] = []
test.beforeAll(async () => {
  server = createServer((request, response) => {
    requests.push({ path: request.url ?? '/', cookie: request.headers.cookie ?? '' })
    if (!request.url?.startsWith('/?')) {
      response.writeHead(404)
      return response.end()
    }
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    response.end(PAGE)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  url = `http://${HOST}:${(server.address() as AddressInfo).port}`
})
test.afterAll(() => new Promise<void>((done) => server.close(() => done())))

const text = (result: ToolResult) =>
  result.content.flatMap((item) => (item.type === 'text' ? [item.text ?? ''] : [])).join('\n')

/** The same session driven through another tab's chat (each tab has its own). */
function withChat(session: GuiSession, chat: GuiSession['chat']): GuiSession {
  return Object.create(session, { chat: { value: chat } })
}

test('canvas_screenshot_url captures a website in a session of its own and saves it to assets', async ({
  launch,
}) => {
  const port = (server.address() as AddressInfo).port
  const session = await launch({ fixture: 'vite', env: { GUI_E2E_WEBSITE: `${HOST}=${port}` } })
  await session.waitForPreview()
  // The user signed into the website in their own preview.
  await session.app.evaluate(
    ({ session: electronSession }, url) =>
      electronSession
        .fromPartition('persist:gui-preview')
        .cookies.set({ url, name: 'signed_in', value: 'user-secret' }),
    url,
  )
  // The agent opens it in this project's preview, which keeps its own cookie.
  await installToolAgent(session)
  const [opened] = await ask(session, [
    { name: 'preview_open_website', args: { url: `${url}/?by=website` } },
  ])
  expect(opened.isError, text(opened)).not.toBe(true)
  const website = await waitFor(
    () =>
      session.app
        .context()
        .pages()
        .find((page) => page.url().includes(HOST)),
    'the website page',
  )
  await waitFor(
    async () => (await website.evaluate(() => document.cookie)) === 'by_website=1' || undefined,
    "the website's cookie",
  )

  // A canvas in a new tab, while the website stays open in the first.
  const first = (await session.state()).activeTab
  await session.chrome.evaluate(() => window.gui.newTab())
  await waitFor(async () => (await session.state()).activeTab !== first, 'the new tab')
  await session.chrome.getByRole('button', { name: /New canvas/ }).click()
  await waitFor(async () => (await session.state()).board, 'the canvas')
  const root = (await session.state()).project?.root ?? ''
  const chat = await waitFor(
    () =>
      session.app
        .context()
        .pages()
        .find((page) => page.url().endsWith('/chat.html') && page !== session.chat),
    "the canvas's chat",
  )
  const canvas = withChat(session, chat)
  await installToolAgent(canvas)

  const visits = requests.length
  const [shot, again] = await ask(canvas, [
    { name: 'canvas_screenshot_url', args: { url: `${url}/?by=capture`, saveAs: 'reference' } },
    { name: 'canvas_screenshot_url', args: { url: `${url}/?by=capture-again` } },
  ])
  // An image comes back, with the page fenced as the website's.
  for (const result of [shot, again]) {
    expect(result.isError, text(result)).not.toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'image' })
    expect(result.content[0].bytes).toBeGreaterThan(1000)
    expect(text(result)).toMatch(/<website_[0-9a-f]{8}>[\s\S]*Title: Reference/)
  }
  // saveAs keeps it full size, as a JPEG in the canvas's assets/ folder.
  const saved = /Saved full size as (assets\/[^;\s]+);/.exec(text(shot))?.[1]
  expect(saved).toMatch(/^assets\/reference\.jpe?g$/)
  const file = readFileSync(join(root, saved ?? ''))
  expect([...file.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff])
  expect(text(again)).not.toContain('Saved')

  // Neither capture sent a cookie: not the user's sign-in, the website's, nor the last capture's.
  const captured = requests.slice(visits).filter((request) => request.path.startsWith('/?'))
  expect(captured.map((request) => request.path)).toEqual(['/?by=capture', '/?by=capture-again'])
  expect(captured.map((request) => request.cookie)).toEqual(['', ''])
  // And the website the agent opened still has only its own.
  expect(await website.evaluate(() => document.cookie)).toBe('by_website=1')
})
