import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { electronExecutable } from './helpers/env'
import { standInsFile } from './helpers/session'
import { expect, test } from './helpers/test'

// A saved chat picks its agent session back up. A stand-in ACP agent (in place of Grok,
// through GUI_AGENT_STAND_INS) offers session/resume and session/load, and logs the calls
// it gets. Its session/load replays the old conversation first, as real agents do.

const AGENT_SCRIPT = String.raw`
const { appendFileSync } = require('node:fs')
const [log, resumeFails] = process.argv.slice(2)
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const say = (sessionId, text) =>
  write({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } })
const handle = ({ id, method, params }) => {
  if (id === undefined || method === undefined) return
  if (method !== 'initialize' && !(params.cwd ?? '').includes('agent-check')) {
    appendFileSync(log, JSON.stringify({ method, sessionId: params.sessionId ?? null }) + '\n')
  }
  if (method === 'initialize') {
    const agentCapabilities = { loadSession: true, sessionCapabilities: { resume: {} } }
    return write({ id, result: { protocolVersion: 1, agentCapabilities, authMethods: [] } })
  }
  if (method === 'session/new') return write({ id, result: { sessionId: 'new-session' } })
  if (method === 'session/resume') {
    if (resumeFails === 'yes') return write({ id, error: { code: -32603, message: 'Internal error' } })
    return write({ id, result: {} })
  }
  if (method === 'session/load') {
    say(params.sessionId, 'REPLAYED earlier reply')
    return write({ id, result: {} })
  }
  if (method === 'session/prompt') {
    say(params.sessionId, 'New reply')
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

for (const resumeFails of [false, true]) {
  test(`a saved chat resumes its session ${resumeFails ? 'through session/load when session/resume fails' : 'without a replay'}`, async ({
    launch,
  }) => {
    const session = await launch({ fixture: 'vite', open: 'recent' })
    const { root, base, userData } = session.fixture
    const log = join(base, 'resume-calls.ndjson')
    const script = join(base, 'resume-agent.cjs')
    writeFileSync(script, AGENT_SCRIPT)
    writeFileSync(
      standInsFile(session.fixture),
      JSON.stringify({
        grok: {
          command: electronExecutable(),
          args: [script, log, resumeFails ? 'yes' : 'no'],
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
        primedWithTools: false,
        turns: [],
        checkpoints: {},
        redo: null,
      }),
    )
    await session.chrome.evaluate((at) => window.gui.openRecent(at), root)
    await session.waitForPreview()
    expect(await session.chat.evaluate(() => window.gui.send('Review the heading'))).toBe(true)
    const { turn } = await session.waitForTurn(0)
    expect(turn.status).toBe('done')

    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { method: string; sessionId: string | null })
    const starts = calls.filter((call) => call.method !== 'session/prompt')
    expect(starts).toEqual(
      resumeFails
        ? [
            { method: 'session/resume', sessionId: 'old-session' },
            { method: 'session/load', sessionId: 'old-session' },
          ]
        : [{ method: 'session/resume', sessionId: 'old-session' }],
    )
    // The chat's own transcript: one turn with the new reply, nothing of a replay, and no
    // notice that a new session started.
    const { turns } = await session.chatSnapshot()
    expect(turns).toHaveLength(1)
    const texts = turn.items.flatMap((item) => (item.kind === 'text' ? [item.text] : []))
    expect(texts.join('')).toBe('New reply')
    expect(turn.items.filter((item) => item.kind === 'notice')).toEqual([])
  })
}
