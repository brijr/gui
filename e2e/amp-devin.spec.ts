import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { waitFor } from './helpers/env'
import { expect, test } from './helpers/test'

// Exercise the real launch paths and Amp's bundled adapter with local fake CLIs.
// No credentials, network calls, or paid agent turns are used.
for (const id of ['amp', 'devin', 'cursor', 'fx'] as const) {
  test(`${id} is selectable and streams a CLI response`, async ({ launch }) => {
    const scratch = mkdtempSync(join(tmpdir(), 'gui-cli-'))
    const log = join(scratch, 'calls.jsonl')
    const shell = fakeShell(scratch)
    const script = id === 'amp' ? AMP_SCRIPT : DEVIN_SCRIPT
    const command = id === 'cursor' ? 'cursor-agent' : id
    const cli = join(scratch, command)
    writeFileSync(cli, `#!${process.execPath}\n${script}`)
    chmodSync(cli, 0o755)
    try {
      const session = await launch({
        fixture: 'vite',
        env: {
          SHELL: shell,
          PATH: `${scratch}:${process.env.PATH}`,
          GUI_CLI_LOG: log,
          // A deliberately invalid inherited override verifies Gui pins Amp to the CLI it found.
          AMP_CLI_PATH: '/missing/amp',
          AMP_ACP_TRANSPORT: 'cli',
          AMP_ACP_CONTINUE_LATEST: '',
        },
      })
      await session.waitForPreview()
      await session.chrome.evaluate((agentId) => window.gui.setAgent(agentId), id)
      expect((await session.chatSnapshot()).meta.agentId).toBe(id)
      const health = (await session.state()).agents.find((agent) => agent.id === id)
      expect(health?.command).toBe(command)
      expect(health?.status).not.toBe('not-installed')
      expect(await session.chat.evaluate(() => window.gui.send('Hello from Gui'))).toBe(true)
      if (id === 'cursor') {
        const card = await waitFor(async () => {
          const turn = (await session.chatSnapshot()).turns[0]
          const permission = turn?.items.find(
            (item) => item.kind === 'permission' && item.resolved === null,
          )
          return turn && permission ? { turnId: turn.id, itemId: permission.id } : null
        }, 'Cursor plan approval')
        await expect(
          session.chat.getByText('Review the workspace before editing.', { exact: true }),
        ).toBeVisible()
        await session.chat.evaluate(
          ({ turnId, itemId }) => window.gui.respondPermission(turnId, itemId, 'accept'),
          card,
        )
      }
      const { turn } = await session.waitForTurn(0)
      expect(turn.status).toBe('done')
      await expect(session.chat.getByText('Hello from the CLI', { exact: true })).toBeVisible()
      const calls = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      if (id === 'amp') {
        expect(calls[0].args).toContain('--stream-json')
        expect(calls[0].args).not.toContain('--dangerously-allow-all')
        expect(calls[0].cwd).toBe(session.fixture.root)
        expect(calls[0].prompt).toContain('Hello from Gui')
        const mcpIndex = calls[0].args.indexOf('--mcp-config')
        expect(mcpIndex).toBeGreaterThan(-1)
        expect(Object.keys(JSON.parse(calls[0].args[mcpIndex + 1]))).not.toHaveLength(0)
      } else {
        expect(calls.some((call) => call.args?.[0] === 'acp')).toBe(true)
        expect(
          calls.some(
            (call) => call.method === 'session/new' && call.params.cwd === session.fixture.root,
          ),
        ).toBe(true)
        if (id === 'cursor') {
          expect(
            calls.find((call) => call.response?.id === 100)?.response.result.outcome.outcome,
          ).toBe('skipped')
          expect(
            calls.find((call) => call.response?.id === 101)?.response.result.outcome.outcome,
          ).toBe('accepted')
        }
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
}

// fx refuses to start without a login; Gui offers its sign-in rather than "Try again".
test('an agent that needs a login before it starts reads as signed out', async ({ launch }) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gui-cli-'))
  const cli = join(scratch, 'fx')
  writeFileSync(cli, `#!${process.execPath}\n${SIGNED_OUT_SCRIPT}`)
  chmodSync(cli, 0o755)
  try {
    const session = await launch({
      fixture: 'vite',
      env: { SHELL: fakeShell(scratch), PATH: `${scratch}:${process.env.PATH}` },
    })
    await session.waitForPreview()
    await session.chrome.evaluate(() => window.gui.setAgent('fx'))
    const health = await waitFor(async () => {
      const agent = (await session.state()).agents.find((item) => item.id === 'fx')
      return agent && agent.status !== 'checking' && agent.status !== 'unknown' ? agent : null
    }, 'fx checked')
    expect(health.status).toBe('signed-out')
    expect(health.signIn?.label).toBe('Sign in')
    expect(health.message).toContain('fx login')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

/**
 * A login shell that keeps the test's PATH, so Gui finds the fake CLIs rather than the
 * developer's own installs (Gui reads PATH from the user's login shell).
 */
function fakeShell(scratch: string) {
  const shell = join(scratch, 'shell')
  writeFileSync(
    shell,
    '#!/bin/sh\ncase "$*" in *\'__GUI_ENV__\'*) printf \'__GUI_ENV__\'; /usr/bin/env -0;; *) exec /bin/sh "$@";; esac\n',
  )
  chmodSync(shell, 0o755)
  return shell
}

const SIGNED_OUT_SCRIPT = String.raw`
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue
    const { id } = JSON.parse(line)
    if (id === undefined) continue
    console.log(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32600, message: 'fx needs access to Vercel AI Gateway. Run fx login to sign in, fx setup to use an API key, or set AI_GATEWAY_API_KEY.' } }))
  }
})
`

const AMP_SCRIPT = String.raw`
const { appendFileSync } = require('node:fs')
let prompt = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { prompt += chunk })
process.stdin.on('end', () => {
  appendFileSync(process.env.GUI_CLI_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), prompt }) + '\n')
  console.log(JSON.stringify({ type: 'assistant', session_id: 'thread-1', message: { content: [{ type: 'text', text: 'Hello from the CLI' }] } }))
  console.log(JSON.stringify({ type: 'result', session_id: 'thread-1', is_error: false }))
})
`

const DEVIN_SCRIPT = String.raw`
const { appendFileSync } = require('node:fs')
const cursor = process.argv[1].endsWith('cursor-agent')
appendFileSync(process.env.GUI_CLI_LOG, JSON.stringify({ args: process.argv.slice(2) }) + '\n')
const write = message => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }))
let promptId
let promptSession
const finish = () => {
  write({ method: 'session/update', params: { sessionId: promptSession, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello from the CLI' } } } })
  write({ id: promptId, result: { stopReason: 'end_turn' } })
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    if (!line.trim()) continue
    const response = JSON.parse(line)
    const { id, method, params } = response
    if (id === undefined) continue
    if (method === undefined) {
      appendFileSync(process.env.GUI_CLI_LOG, JSON.stringify({ response }) + '\n')
      if (id === 100) write({ id: 101, method: 'cursor/create_plan', params: { toolCallId: 'plan-1', name: 'Workspace review', plan: 'Review the workspace before editing.', todos: [] } })
      else if (id === 101) finish()
      continue
    }
    appendFileSync(process.env.GUI_CLI_LOG, JSON.stringify({ method, params }) + '\n')
    if (method === 'initialize') write({ id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, authMethods: [] } })
    else if (method === 'session/new') write({ id, result: { sessionId: 'session-1' } })
    else if (method === 'session/prompt') {
      promptId = id
      promptSession = params.sessionId
      if (cursor) write({ id: 100, method: 'cursor/ask_question', params: { toolCallId: 'question-1', questions: [] } })
      else finish()
    } else write({ id, error: { code: -32601, message: 'Method not found' } })
  }
})
`
