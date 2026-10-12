import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { electronExecutable, waitFor } from './helpers/env'
import { chooseFromChatMenu } from './helpers/menus'
import { type GuiSession, standInsFile } from './helpers/session'
import { expect, test } from './helpers/test'

const MARKER = '// Changed after the first save'

/** Runs in the chat page. */
function getVersions() {
  return window.gui.getVersions()
}

test('saving a version, restoring it, and restoring back', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  const { root } = session.fixture
  await waitFor(() => session.chat.evaluate(getVersions), 'versions')

  await chooseFromChatMenu(session.app, session.chat, 'Versions…')
  await expect(session.chat.getByText('No versions yet')).toBeVisible()
  await session.chat.getByPlaceholder('Name this version').fill('First save')
  await session.chat
    .getByRole('button', { name: 'Save version', exact: true })
    .dispatchEvent('click')
  await expect(session.chat.getByText('First save', { exact: true })).toBeVisible()
  await expect(session.chat.getByText('Current', { exact: true })).toBeVisible()

  appendFileSync(join(root, 'src/App.tsx'), `\n${MARKER}\n`)
  writeFileSync(join(root, 'src/extra.txt'), 'extra\n')

  // Reopening reloads the list, so First save is no longer where the files are.
  await session.chat.getByRole('button', { name: 'Back to chat' }).first().dispatchEvent('click')
  await chooseFromChatMenu(session.app, session.chat, 'Versions…')
  await session.chat.getByRole('button', { name: 'Restore First save' }).dispatchEvent('click')
  await expect(session.chat.getByText(/Before restoring/)).toBeVisible()
  await waitFor(
    async () =>
      !readFileSync(join(root, 'src/App.tsx'), 'utf8').includes(MARKER) &&
      !existsSync(join(root, 'src/extra.txt')),
    'files restored to First save',
  )

  // The state saved before that restore brings both edits back.
  await session.chat
    .getByRole('button', { name: /Restore Before restoring/ })
    .dispatchEvent('click')
  await waitFor(
    async () =>
      readFileSync(join(root, 'src/App.tsx'), 'utf8').includes(MARKER) &&
      existsSync(join(root, 'src/extra.txt')) &&
      readFileSync(join(root, 'src/extra.txt'), 'utf8') === 'extra\n',
    'files restored back',
  )

  // Publish hands over to Source Control with the files as they are now.
  await session.chat.getByRole('button', { name: 'Publish…' }).dispatchEvent('click')
  await expect(session.chat.getByText('Source control', { exact: true })).toBeVisible()
})

// A stand-in ACP agent that appends a marker on its prompt: no login or usage needed.
const AGENT_SCRIPT = String.raw`
const { appendFileSync } = require('node:fs')
const { join } = require('node:path')
const write = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
let cwd = process.cwd()
const prompt = async params => {
  appendFileSync(join(cwd, 'src/App.tsx'), '\n// Edited by the stand-in\n')
  write({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } } } })
  return { stopReason: 'end_turn' }
}
const handle = ({ id, method, params }) => {
  if (id === undefined || !method) return
  if (method === 'initialize') return write({ id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, authMethods: [] } })
  if (method === 'session/new') { cwd = params.cwd || cwd; return write({ id, result: { sessionId: 'versions' } }) }
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

async function useStandIn(session: GuiSession) {
  const script = join(session.fixture.base, 'versions-agent.cjs')
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

test('a finished turn becomes a version named for its request', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  await useStandIn(session)

  const index = (await session.chatSnapshot()).turns.length
  expect(
    await session.chat.evaluate((text) => window.gui.send(text), 'Add the versions marker'),
  ).toBe(true)
  const { turn } = await session.waitForTurn(index)
  expect(turn.error).toBeNull()
  expect(turn.status).toBe('done')

  await chooseFromChatMenu(session.app, session.chat, 'Versions…')
  await expect(session.chat.getByText('Add the versions marker')).toBeVisible()
  await expect(session.chat.getByText(/1 file changed/)).toBeVisible()
  await expect(session.chat.getByText('Current', { exact: true })).toBeVisible()
})
