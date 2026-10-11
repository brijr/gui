import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { electronExecutable, waitFor } from './helpers/env'
import { standInsFile } from './helpers/session'
import { expect, test } from './helpers/test'

// The user sees their app in Gui's preview, so an agent must never open their browser: a
// stand-in ACP agent (a small Node script, in place of Grok through GUI_AGENT_STAND_INS)
// records the BROWSER its sessions start with and the first prompt it gets.

const AGENT_SCRIPT = String.raw`
const { appendFileSync } = require('node:fs')
const [log] = process.argv.slice(2)
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const handle = ({ id, method, params }) => {
  if (id === undefined || method === undefined) return
  if (method === 'initialize') {
    const agentCapabilities = { loadSession: true, mcpCapabilities: { http: true } }
    return write({ id, result: { protocolVersion: 1, agentCapabilities, authMethods: [] } })
  }
  if (method === 'session/new') {
    const entry = { cwd: params.cwd, browser: process.env.BROWSER ?? null, mcpServers: params.mcpServers.length }
    appendFileSync(log + '.sessions', JSON.stringify(entry) + '\n')
    return write({ id, result: { sessionId: 'session-1' } })
  }
  if (method === 'session/load') return write({ id, result: {} })
  if (method === 'session/prompt') {
    appendFileSync(log, JSON.stringify(params.prompt) + '\n')
    return write({ id, result: { stopReason: 'end_turn' } })
  }
  write({ id, error: { code: -32601, message: 'Method not found' } })
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    if (line) handle(JSON.parse(line))
  }
})

`

type Block = { type: string; text?: string }
type Started = { cwd: string; browser: string | null; mcpServers: number }

test('agents start without a browser to open, and are told the preview is theirs', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  const { base } = session.fixture
  const log = join(base, 'prompts.ndjson')
  const script = join(base, 'browser-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  const standIn = {
    command: electronExecutable(),
    args: [script, log],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
  writeFileSync(standInsFile(session.fixture), JSON.stringify({ grok: standIn }))
  await waitFor(async () => (await session.state()).project !== null, 'the project to open')
  await session.chrome.evaluate(() => window.gui.setAgent('grok'))
  await waitFor(async () => (await session.chatSnapshot()).meta.agentId === 'grok', 'Grok')
  const lines = (file: string) =>
    existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []

  const box = session.chat.getByRole('textbox', { name: /^Message / })
  await box.fill('Make the heading blue')
  await box.press('Enter')
  expect((await session.waitForTurn(0)).turn.status).toBe('done')

  // The chat's session, not Gui's agent check (which starts its own in a folder of its own).
  const started = lines(`${log}.sessions`)
    .map((line) => JSON.parse(line) as Started)
    .filter(({ cwd }) => !cwd.includes('agent-check'))
  expect(started).toHaveLength(1)
  expect(started[0]).toMatchObject({ browser: 'none', mcpServers: 1 })

  const [prompt] = lines(log).map((line) => JSON.parse(line) as Block[])
  const preamble = prompt?.[0]?.text ?? ''
  expect(preamble).toContain('These preview tools are your browser')
  expect(preamble).toContain("Never open the user's browser")
  expect(preamble).toContain('preview_click')
  expect(preamble).toContain('preview_type')
  expect(preamble).toContain('edit again and repeat the checks before replying')
})

test('resumed chats receive updated preview guidance once', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { root, base, userData } = session.fixture
  const log = join(base, 'resumed-prompts.ndjson')
  const script = join(base, 'resumed-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  writeFileSync(
    standInsFile(session.fixture),
    JSON.stringify({
      grok: {
        command: electronExecutable(),
        args: [script, log],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    }),
  )
  const directory = join(userData, 'chats')
  mkdirSync(directory, { recursive: true })
  const name = createHash('sha1').update(realpathSync(root)).digest('hex').slice(0, 16)
  writeFileSync(
    join(directory, `${name}.json`),
    JSON.stringify({
      version: 1,
      agentId: 'grok',
      sessionId: 'old-session',
      primed: true,
      primedWithTools: true,
      turns: [],
      checkpoints: {},
      redo: null,
    }),
  )
  await session.chrome.evaluate((at) => window.gui.openRecent(at), root)
  await session.waitForPreview()
  for (const index of [0, 1]) {
    expect(await session.chat.evaluate(() => window.gui.send('Review the heading'))).toBe(true)
    expect((await session.waitForTurn(index)).turn.status).toBe('done')
  }
  const prompts = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Block[])
  expect(prompts).toHaveLength(2)
  expect(prompts[0][0].text).toContain('edit again and repeat the checks before replying')
  expect(
    prompts[1].some((block) => block.text?.includes('These preview tools are your browser')),
  ).toBe(false)
})
