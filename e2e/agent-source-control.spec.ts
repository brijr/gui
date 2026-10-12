import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { electronExecutable, waitFor } from './helpers/env'
import { git } from './helpers/fixtures'
import { type GuiSession, standInsFile } from './helpers/session'
import { expect, test } from './helpers/test'

// Calls Gui's own MCP tools through a stand-in agent: no agent login or paid usage.
const AGENT_SCRIPT = String.raw`
const write = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
let mcp
const call = async (name, args) => {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  for (const header of mcp.headers) headers[header.name] = header.value
  const response = await fetch(mcp.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  const reply = await response.json()
  if (reply.error) throw new Error(reply.error.message)
  return reply.result
}
const prompt = async params => {
  const request = params.prompt.filter(block => block.type === 'text').map(block => block.text).find(text => text.startsWith('TOOLS '))
  const results = []
  for (const step of JSON.parse(request.slice(6))) results.push(await call(step.name, step.args || {}))
  write({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(results) } } } })
  return { stopReason: 'end_turn' }
}
const handle = ({ id, method, params }) => {
  if (id === undefined || !method) return
  if (method === 'initialize') return write({ id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, authMethods: [] } })
  if (method === 'session/new') { mcp = params.mcpServers.find(server => server.url); return write({ id, result: { sessionId: 'source-control' } }) }
  if (method === 'session/prompt') return void prompt(params).then(result => write({ id, result }), error => write({ id, error: { code: -32603, message: error.message } }))
  write({ id, error: { code: -32601, message: 'Method not found' } })
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1)
    if (line) handle(JSON.parse(line))
  }
})
`

interface ToolResult {
  isError?: boolean
  content: { type: string; text?: string }[]
}

async function useStandIn(session: GuiSession) {
  const script = join(session.fixture.base, 'source-control-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  writeFileSync(
    standInsFile(session.fixture),
    JSON.stringify({
      grok: { command: electronExecutable(), args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } },
    }),
  )
  await session.chrome.evaluate(() => window.gui.setAgent('grok'))
  await waitFor(
    async () => (await session.chatSnapshot()).meta.agentId === 'grok',
    'the stand-in agent',
  )
}

async function ask(
  session: GuiSession,
  steps: { name: string; args?: Record<string, unknown> }[],
): Promise<ToolResult[]> {
  const index = (await session.chatSnapshot()).turns.length
  expect(
    await session.chat.evaluate((text) => window.gui.send(text), `TOOLS ${JSON.stringify(steps)}`),
  ).toBe(true)
  const { turn } = await session.waitForTurn(index)
  expect(turn.error).toBeNull()
  expect(turn.status).toBe('done')
  return JSON.parse(
    turn.items.flatMap((item) => (item.kind === 'text' ? [item.text] : [])).join(''),
  )
}

const textOf = (result: ToolResult) =>
  result.content.flatMap((item) => (item.type === 'text' ? [item.text ?? ''] : [])).join('\n')

test('the agent reads source control and earlier turns, and proposes a commit for the user', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const { root } = session.fixture
  await session.waitForPreview()
  git(root, 'branch', '-M', 'main')
  git(root, 'config', 'user.name', 'Gui E2E')
  git(root, 'config', 'user.email', 'e2e@example.com')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.hooksPath', '/dev/null')
  await useStandIn(session)
  const head = git(root, 'rev-parse', 'HEAD').trim()

  await waitFor(() => session.chat.evaluate(() => window.gui.getShipInfo()), 'ship info')
  // An earlier turn for chat_turns to report.
  const [clean] = await ask(session, [{ name: 'source_control_status' }])
  expect(textOf(clean)).toContain('No uncommitted changes.')
  appendFileSync(join(root, 'src/App.tsx'), '\n// Proposed by the agent\n')
  appendFileSync(join(root, 'src/index.css'), '\n/* Left out of the proposal */\n')

  const [status, turns, proposed] = await ask(session, [
    { name: 'source_control_status' },
    { name: 'chat_turns' },
    {
      name: 'source_control_propose',
      args: {
        mode: 'commit',
        title: 'Note the agent proposal',
        body: '- Adds a comment to App',
        files: ['src/App.tsx', 'src/missing.ts'],
      },
    },
  ])
  expect(textOf(status)).toContain('Branch: main')
  expect(textOf(status)).toContain('modified src/App.tsx')
  expect(textOf(turns)).toContain('source_control_status')
  expect(proposed.isError).not.toBe(true)

  // The sheet opens filled in once the turn is over; nothing is committed until the user ships.
  await expect(session.chat.getByRole('textbox', { name: 'Commit message' })).toHaveValue(
    'Note the agent proposal',
  )
  await expect(session.chat.getByRole('checkbox', { name: 'Include src/App.tsx' })).toBeChecked()
  await expect(
    session.chat.getByRole('checkbox', { name: 'Include src/index.css' }),
  ).not.toBeChecked()
  expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(head)

  await session.chat
    .getByRole('button', { name: 'Save commit', exact: true })
    .dispatchEvent('click')
  await expect(session.chat.getByText('Commit saved', { exact: true })).toBeVisible()
  expect(git(root, 'log', '-1', '--format=%s').trim()).toBe('Note the agent proposal')
  expect(git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').trim()).toBe(
    'src/App.tsx',
  )
})
