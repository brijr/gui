import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { electronExecutable, waitFor } from './helpers/env'
import { type GuiSession, standInsFile } from './helpers/session'
import { expect, test } from './helpers/test'

// The agent's slash commands: a stand-in ACP agent (a small Node script, in place of Pi
// through GUI_AGENT_STAND_INS) reports two commands just after its session starts, as
// Claude Code's adapter does, and records every prompt it gets.

const AGENT_SCRIPT = String.raw`
const { appendFileSync } = require('node:fs')
const [log] = process.argv.slice(2)
const COMMANDS = [
  { name: 'compact', description: 'Summarize the conversation' },
  { name: 'review', description: 'Review changes', input: { hint: 'branch or PR' } },
]
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const notify = (sessionId, update) => write({ method: 'session/update', params: { sessionId, update } })
const handle = ({ id, method, params }) => {
  if (id === undefined || method === undefined) return
  if (method === 'session/prompt') appendFileSync(log, JSON.stringify(params.prompt) + '\n')
  if (method === 'initialize') {
    return write({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
  }
  if (method === 'session/new') {
    write({ id, result: { sessionId: 'session-1' } })
    setTimeout(() => notify('session-1', { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS }), 0)
    return
  }
  if (method === 'session/prompt') return write({ id, result: { stopReason: 'end_turn' } })
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

/** Stands the script in for Pi and makes it the chat's agent; returns the prompts it gets. */
async function useStandIn(session: GuiSession) {
  const { base } = session.fixture
  const log = join(base, 'prompts.ndjson')
  const script = join(base, 'commands-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  const standIn = {
    command: electronExecutable(),
    args: [script, log],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
  writeFileSync(standInsFile(session.fixture), JSON.stringify({ pi: standIn }))
  await waitFor(async () => (await session.state()).project !== null, 'the project to open')
  await session.chrome.evaluate(() => window.gui.setAgent('pi'))
  await waitFor(async () => (await session.chatSnapshot()).meta.agentId === 'pi', 'Pi')
  return (): Block[][] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Block[])
      : []
}

test('the composer lists the agent’s slash commands and sends one on its own', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  const prompts = await useStandIn(session)
  const { chat } = session
  const box = chat.getByRole('textbox', { name: /^Message / })
  const menu = chat.getByRole('listbox', { name: 'Commands' })

  // Nothing to list until the agent has started and said what it offers.
  expect((await session.chatSnapshot()).meta.commands).toEqual([])
  await box.fill('/')
  await expect(menu).toBeHidden()
  await box.fill('Hello')
  await box.press('Enter')
  expect((await session.waitForTurn(0)).turn.status).toBe('done')
  await waitFor(
    async () => (await session.chatSnapshot()).meta.commands.length === 2,
    'the commands',
  )

  // `/` lists them; typing filters, Esc closes, typing again reopens.
  await box.fill('/')
  await expect(menu.getByRole('option')).toHaveText([
    '/compact Summarize the conversation',
    '/review Review changes',
  ])
  await box.press('r')
  await expect(menu.getByRole('option')).toHaveText(['/review Review changes'])
  await box.press('Escape')
  await expect(menu).toBeHidden()
  await box.press('e')
  await expect(menu).toBeVisible()

  // Enter puts the command in the box and shows what it takes; the next Enter sends it,
  // alone: no instructions, viewport, or picked element.
  await box.press('Enter')
  await expect(box).toHaveValue('/review ')
  await expect(chat.getByText('branch or PR')).toBeVisible()
  await box.pressSequentially('main')
  await box.press('Enter')
  expect((await session.waitForTurn(1)).turn.status).toBe('done')
  expect(prompts()[1]).toEqual([{ type: 'text', text: '/review main' }])

  // One typed out in full that takes nothing runs on Enter; it said nothing, so Gui does.
  await box.fill('/compact')
  await box.press('Enter')
  const compact = (await session.waitForTurn(2)).turn
  expect(prompts()[2]).toEqual([{ type: 'text', text: '/compact' }])
  expect(compact.items).toMatchObject([{ kind: 'notice', text: 'Ran /compact.' }])

  // A slash that isn't one of them is an ordinary message.
  await box.fill('/src/App.tsx looks off')
  await expect(menu).toBeHidden()
  await box.press('Enter')
  await session.waitForTurn(3)
  const ordinary = prompts()[3] ?? []
  expect(ordinary.length).toBeGreaterThan(1)
  expect(ordinary.at(-1)).toEqual({ type: 'text', text: '/src/App.tsx looks off' })

  // A new chat still knows them, before its agent starts.
  await chat.evaluate(() => window.gui.newSession())
  await waitFor(async () => (await session.chatSnapshot()).turns.length === 0, 'a new chat')
  expect((await session.chatSnapshot()).meta.commands.map((c) => c.name)).toEqual([
    'compact',
    'review',
  ])
  await box.fill('/')
  await expect(menu).toBeVisible()
  await session.shot('slash-commands')
})
