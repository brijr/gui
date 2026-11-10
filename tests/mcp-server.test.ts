import { afterEach, expect, test } from 'bun:test'
import { type RunningMcpServer, startMcpServer } from '../src/main/mcp-server'

// Each tab serves Gui's tools to its agent over MCP on loopback (docs/architecture.md,
// "Preview tools for the agent"). The server listens before the MCP SDK has loaded, so a
// project opening doesn't wait the tens of milliseconds that takes; the first call does.

/** Nothing here calls a tool: the server only has to list them. */
const unused = {} as never

const servers: RunningMcpServer[] = []
async function start() {
  const server = await startMcpServer(unused, unused, unused)
  servers.push(server)
  return server.config
}
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

/** Where the agent is told to call, and the token it's told to send. */
function endpoint(config: RunningMcpServer['config']) {
  if (!('url' in config)) throw new Error('Gui serves its tools over HTTP')
  const headers = Object.fromEntries(config.headers.map((header) => [header.name, header.value]))
  return { url: config.url, headers }
}

function call(
  config: RunningMcpServer['config'],
  method: string,
  headers: Record<string, string> = endpoint(config).headers,
) {
  return fetch(endpoint(config).url, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params:
        method === 'initialize'
          ? {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'test', version: '1' },
            }
          : {},
    }),
  })
}
test('the first call is answered, and lists the tools', async () => {
  const config = await start()
  const hello = await call(config, 'initialize')
  expect(hello.status).toBe(200)
  expect((await hello.json()).result.serverInfo.name).toBe('gui')

  const listed = await call(config, 'tools/list')
  const names = (await listed.json()).result.tools.map((tool: { name: string }) => tool.name)
  expect(names).toContain('preview_screenshot')
  expect(names).toContain('dev_server_status')
  expect(names).not.toContain('canvas_list_frames')
})

test('calls arriving together while nothing has loaded yet are all answered', async () => {
  const config = await start()
  const answers = await Promise.all([1, 2, 3].map(() => call(config, 'tools/list')))
  expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200])
})

test('only the token Gui gave its agent gets in', async () => {
  const config = await start()
  expect((await call(config, 'tools/list', {})).status).toBe(401)
  expect((await call(config, 'tools/list', { Authorization: 'Bearer nope' })).status).toBe(401)
  const { url, headers } = endpoint(config)
  expect((await fetch(url, { headers })).status).toBe(405)
})
