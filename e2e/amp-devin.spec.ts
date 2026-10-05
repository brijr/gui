import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './helpers/test'

// Exercise the real launch paths and Amp's bundled adapter with local fake CLIs.
// No credentials, network calls, or paid agent turns are used.
for (const id of ['amp', 'devin'] as const) {
  test(`${id} is selectable and streams a CLI response`, async ({ launch }) => {
    const scratch = mkdtempSync(join(tmpdir(), 'gui-cli-'))
    const log = join(scratch, 'calls.jsonl')
    const shell = join(scratch, 'shell')
    writeFileSync(
      shell,
      '#!/bin/sh\ncase "$*" in *\'__GUI_ENV__\'*) printf \'__GUI_ENV__\'; /usr/bin/env -0;; *) exec /bin/sh "$@";; esac\n',
    )
    chmodSync(shell, 0o755)
    const script = id === 'amp' ? AMP_SCRIPT : DEVIN_SCRIPT
    const cli = join(scratch, id)
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
      expect(health?.command).toBe(id)
      expect(health?.status).not.toBe('not-installed')
      expect(await session.chat.evaluate(() => window.gui.send('Hello from Gui'))).toBe(true)
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
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
}

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
appendFileSync(process.env.GUI_CLI_LOG, JSON.stringify({ args: process.argv.slice(2) }) + '\n')
const write = message => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }))
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    if (!line.trim()) continue
    const { id, method, params } = JSON.parse(line)
    if (id === undefined) continue
    appendFileSync(process.env.GUI_CLI_LOG, JSON.stringify({ method, params }) + '\n')
    if (method === 'initialize') write({ id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } }, authMethods: [] } })
    else if (method === 'session/new') write({ id, result: { sessionId: 'session-1' } })
    else if (method === 'session/prompt') {
      write({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello from the CLI' } } } })
      write({ id, result: { stopReason: 'end_turn' } })
    } else write({ id, error: { code: -32601, message: 'Method not found' } })
  }
})
`
