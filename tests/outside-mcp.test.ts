import { afterEach, expect, test } from 'bun:test'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ASK_FIRST_TOOLS, GUI_TOOL_NAMES } from '../src/main/mcp-server'
import {
  CLOSED_MID_CALL,
  NOTHING_OPEN,
  OUTSIDE_MCP_PORT,
  OUTSIDE_TOOL_NAMES,
  type OutsideOpener,
  type OutsideTarget,
  type RunningOutsideServer,
  STATUS_TOOL,
  startOutsideMcpServer,
} from '../src/main/outside-mcp'
import { OUTSIDE_CLIENTS, outsideSetup } from '../src/shared/outside-setup'

// Agents outside Gui (Claude Code, Codex, Cursor) reach Gui's tools at one fixed loopback
// address with the user's token, and each call acts on what's open in the focused Gui window
// (main/outside-mcp.ts). The setting, token file and window lookup are outside-agents.ts's.

const TOKEN = 'a'.repeat(64)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort() {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise((resolve) => probe.close(resolve))
  return port
}

interface Harness {
  port: number
  target: OutsideTarget | null
  signedIn: boolean
  token: string | null
  opener: OutsideOpener
}

/** Lists nothing and opens nothing, unless a test says otherwise. */
const NO_OPENER: OutsideOpener = {
  list: async () => [],
  open: () => Promise.reject(new Error('nothing to open')),
}

const servers: RunningOutsideServer[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

async function start(initial: Partial<Harness> = {}) {
  const harness: Harness = {
    port: await freePort(),
    target: null,
    signedIn: true,
    token: TOKEN,
    opener: NO_OPENER,
    ...initial,
  }
  servers.push(
    await startOutsideMcpServer({
      port: harness.port,
      token: () => harness.token,
      signedIn: () => harness.signedIn,
      target: () => harness.target,
      opener: {
        list: () => harness.opener.list(),
        open: (request) => harness.opener.open(request),
      },
    }),
  )
  return harness
}

let id = 0
function post(
  harness: Harness,
  method: string,
  params: unknown = {},
  { auth = `Bearer ${TOKEN}`, path = '/mcp' }: { auth?: string | null; path?: string } = {},
) {
  return fetch(`http://127.0.0.1:${harness.port}${path}`, {
    method: 'POST',
    headers: {
      ...(auth ? { authorization: auth } : {}),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  })
}

interface ToolReply {
  isError?: boolean
  content: { type: string; text: string }[]
}

async function callTool(harness: Harness, name: string, args: Record<string, unknown> = {}) {
  const reply = await post(harness, 'tools/call', { name, arguments: args })
  expect(reply.status).toBe(200)
  const result = (await reply.json()).result as ToolReply
  return { isError: result.isError === true, text: result.content.map((c) => c.text).join('\n') }
}

/** A canvas or project whose tools say whose they are; only the board's list is called. */
function opening(
  name: string,
  kind: 'canvas' | 'project',
  list: () => Promise<string> = async () => `frames of ${name}`,
) {
  const closing = new AbortController()
  let live = true
  const target: OutsideTarget = {
    kind,
    name,
    root: `/tmp/${name}`,
    preview: () => (kind === 'canvas' ? 'Preview: the board.' : 'Dev server: running.'),
    live: () => live,
    closed: closing.signal,
    backends: {
      tools: {} as never,
      recordings: {} as never,
      board: kind === 'canvas' ? ({ list } as never) : null,
    },
  }
  const close = () => {
    live = false
    closing.abort()
  }
  return { target, close }
}

test('the port is fixed, unusual, and not one dev servers pick', () => {
  expect(OUTSIDE_MCP_PORT).toBe(29_417)
})

test('other agents get exactly the allowlisted tools, and nothing that runs commands, leaves Gui or needs a chat', async () => {
  const harness = await start()
  const hello = await post(harness, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  })
  expect(hello.status).toBe(200)
  const { result } = await hello.json()
  expect(result.serverInfo.name).toBe('gui')
  expect(result.instructions).toContain('gui_status')
  expect(result.instructions).toContain('focused Gui window')

  const listed = await post(harness, 'tools/list')
  const names = ((await listed.json()).result.tools as { name: string }[]).map((t) => t.name)
  expect(names.sort()).toEqual([...OUTSIDE_TOOL_NAMES].sort())
  // Pinned: a tool added to Gui is never served to other agents until it's added here.
  expect([...OUTSIDE_TOOL_NAMES].sort() as string[]).toEqual(
    [
      'canvas_arrange_frames',
      'canvas_create_frame',
      'canvas_delete_frames',
      'canvas_duplicate_frames',
      'canvas_list_frames',
      'canvas_open_frame',
      'canvas_screenshot',
      'canvas_section',
      'dev_server_logs',
      'gui_list',
      'gui_open',
      'gui_status',
      'preview_back',
      'preview_click',
      'preview_console',
      'preview_guides',
      'preview_hover',
      'preview_inspect',
      'preview_motion',
      'preview_navigate',
      'preview_point',
      'preview_press',
      'preview_reload',
      'preview_screenshot',
      'preview_scroll',
      'preview_snapshot',
      'preview_type',
      'preview_wait',
      'recording_frames',
      'recording_narration',
      'recording_timeline',
    ].sort(),
  )
  for (const name of [
    'set_start_command',
    'dev_server_restart',
    'chat_turns',
    'preview_variations',
    ...ASK_FIRST_TOOLS,
  ]) {
    expect(names).not.toContain(name)
  }
  // Every one is a tool Gui has, but the one that says where calls go.
  for (const name of names) {
    if (!name.startsWith('gui_')) expect(GUI_TOOL_NAMES).toContain(name as never)
  }
})

test('only the token from Settings gets in, at /mcp, by POST, while signed in', async () => {
  const harness = await start()
  expect((await post(harness, 'tools/list', {}, { auth: null })).status).toBe(401)
  expect((await post(harness, 'tools/list', {}, { auth: 'Bearer nope' })).status).toBe(401)
  expect((await post(harness, 'tools/list', {}, { auth: `Bearer ${'b'.repeat(64)}` })).status).toBe(
    401,
  )
  expect((await post(harness, 'tools/list', {}, { path: '/other' })).status).toBe(404)
  const get = await fetch(`http://127.0.0.1:${harness.port}/mcp`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  expect(get.status).toBe(405)

  // A new token: the old one stops working at once.
  harness.token = 'c'.repeat(64)
  expect((await post(harness, 'tools/list')).status).toBe(401)
  expect((await post(harness, 'tools/list', {}, { auth: `Bearer ${'c'.repeat(64)}` })).status).toBe(
    200,
  )
  harness.token = null
  expect((await post(harness, 'tools/list', {}, { auth: 'Bearer ' })).status).toBe(401)
  harness.token = TOKEN

  harness.signedIn = false
  const signedOut = await post(harness, 'tools/list')
  expect(signedOut.status).toBe(401)
  expect((await signedOut.json()).error.message).toBe('Sign in to Gui to use its tools.')
})

test('a page on another site, rebinding its name to loopback, is refused', async () => {
  const harness = await start()
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: harness.port,
        path: '/mcp',
        method: 'POST',
        headers: {
          host: `evil.example:${harness.port}`,
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on('error', reject)
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
  })
  expect(status).toBe(403)
})

test('a port already taken is reported, not swapped for another', async () => {
  const harness = await start()
  await expect(
    startOutsideMcpServer({
      port: harness.port,
      token: () => TOKEN,
      signedIn: () => true,
      target: () => null,
      opener: NO_OPENER,
    }),
  ).rejects.toMatchObject({ code: 'EADDRINUSE' })
})

test('each call acts on what the focused window has open as it comes in', async () => {
  const harness = await start()
  const first = opening('Landing ideas', 'canvas')
  const second = opening('Pricing', 'canvas')

  harness.target = null
  const none = await callTool(harness, 'canvas_list_frames')
  expect(none).toEqual({ isError: true, text: NOTHING_OPEN })
  expect((await callTool(harness, STATUS_TOOL)).isError).toBe(true)

  harness.target = first.target
  expect(await callTool(harness, 'canvas_list_frames')).toEqual({
    isError: false,
    text: 'frames of Landing ideas',
  })
  const status = await callTool(harness, STATUS_TOOL)
  expect(status.isError).toBe(false)
  expect(status.text).toContain('canvas “Landing ideas”')
  expect(status.text).toContain('Folder: /tmp/Landing ideas')
  expect(status.text).toContain('Preview: the board.')

  // The user focuses another window: the next call goes there.
  harness.target = second.target
  expect((await callTool(harness, 'canvas_list_frames')).text).toBe('frames of Pricing')
})

test("a canvas tool in a project, or a project's in a canvas, says what's open instead", async () => {
  const harness = await start()
  harness.target = opening('shop', 'project').target
  const canvasTool = await callTool(harness, 'canvas_list_frames')
  expect(canvasTool.isError).toBe(true)
  expect(canvasTool.text).toContain('works in a canvas')
  expect(canvasTool.text).toContain('project “shop”')
  const status = await callTool(harness, STATUS_TOOL)
  expect(status.text).toContain('project “shop”')
  expect(status.text).toContain('Dev server: running.')

  harness.target = opening('Ideas', 'canvas').target
  const projectTool = await callTool(harness, 'dev_server_logs')
  expect(projectTool.isError).toBe(true)
  expect(projectTool.text).toContain('works in a project')
})

test('an opening that closed, or closes mid-call, answers that it closed', async () => {
  const harness = await start()
  const gone = opening('Old', 'canvas')
  gone.close()
  harness.target = gone.target
  expect(await callTool(harness, 'canvas_list_frames')).toEqual({
    isError: true,
    text: CLOSED_MID_CALL,
  })

  // The call waits on the board; the canvas closes meanwhile. The reply doesn't wait for it.
  const slow = opening('Slow', 'canvas', () => new Promise<string>(() => {}))
  harness.target = slow.target
  const pending = callTool(harness, 'canvas_list_frames')
  await sleep(50)
  slow.close()
  expect(await pending).toEqual({ isError: true, text: CLOSED_MID_CALL })

  // Its result, when it does come after the close, is dropped too.
  let finish: (value: string) => void = () => {}
  const late = opening('Late', 'canvas', () => new Promise<string>((resolve) => (finish = resolve)))
  harness.target = late.target
  const answer = callTool(harness, 'canvas_list_frames')
  await sleep(50)
  late.target.live = () => false
  finish('frames of Late')
  expect(await answer).toEqual({ isError: true, text: CLOSED_MID_CALL })
})

test('setup for each agent carries the address and token', () => {
  expect(OUTSIDE_CLIENTS).toEqual(['claude', 'codex', 'cursor'])
  expect(outsideSetup('claude', 29_417, 'TOKEN')).toBe(
    'claude mcp add --transport http gui http://127.0.0.1:29417/mcp --header "Authorization: Bearer TOKEN"',
  )
  expect(outsideSetup('codex', 29_417, 'TOKEN')).toBe(
    '[mcp_servers.gui]\nurl = "http://127.0.0.1:29417/mcp"\nhttp_headers = { Authorization = "Bearer TOKEN" }',
  )
  expect(JSON.parse(outsideSetup('cursor', 29_417, 'TOKEN'))).toEqual({
    mcpServers: {
      gui: { url: 'http://127.0.0.1:29417/mcp', headers: { Authorization: 'Bearer TOKEN' } },
    },
  })
})

test('with nothing open, gui_list and gui_open still answer: they are the way to open something', async () => {
  const opened = opening('Landing ideas', 'canvas')
  const asked: unknown[] = []
  const harness = await start({
    opener: {
      list: async () => [
        { kind: 'canvas', name: 'Landing ideas', folder: '/tmp/Landing ideas', id: 'abcdefabcdef' },
        { kind: 'project', name: 'shop', folder: '/tmp/shop' },
      ],
      open: async (request) => {
        asked.push(request)
        return opened.target
      },
    },
  })
  expect((await callTool(harness, 'canvas_list_frames')).text).toBe(NOTHING_OPEN)
  expect(NOTHING_OPEN).toContain('gui_list')
  expect(NOTHING_OPEN).toContain('gui_open')

  const listed = await callTool(harness, 'gui_list')
  expect(listed.isError).toBe(false)
  const json = JSON.parse(
    listed.text.slice(listed.text.indexOf('{'), listed.text.lastIndexOf('}') + 1),
  )
  expect(json.current).toBeNull()
  expect(json.canvases).toEqual([
    {
      kind: 'canvas',
      name: 'Landing ideas',
      folder: '/tmp/Landing ideas',
      id: 'abcdefabcdef',
      current: false,
    },
  ])
  expect(json.projects).toEqual([
    { kind: 'project', name: 'shop', folder: '/tmp/shop', current: false },
  ])

  const open = await callTool(harness, 'gui_open', { canvas: 'abcdefabcdef' })
  expect(open.isError).toBe(false)
  expect(open.text).toContain('canvas “Landing ideas”')
  expect(asked).toEqual([{ canvas: 'abcdefabcdef' }])

  // One of the two, never both or neither.
  expect((await callTool(harness, 'gui_open', {})).isError).toBe(true)
  expect((await callTool(harness, 'gui_open', { canvas: 'a', folder: '/tmp' })).isError).toBe(true)

  // Why it didn't open is the tool's error.
  harness.opener = { ...harness.opener, open: () => Promise.reject(new Error('declined')) }
  expect(await callTool(harness, 'gui_open', { folder: '/tmp/x' })).toEqual({
    isError: true,
    text: 'declined',
  })

  // Once something is open, gui_list says it's where calls go.
  harness.target = opened.target
  const now = await callTool(harness, 'gui_list')
  expect(now.text).toContain('"current":{"kind":"canvas","name":"Landing ideas"')
})
