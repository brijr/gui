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
      // Amp and fx have no mode that asks first Gui can switch to: their own settings decide,
      // and the control says so rather than offering Ask. Devin and Cursor keep Ask and Auto.
      const own = id === 'amp' || id === 'fx'
      expect((await session.chatSnapshot()).meta.ownPermissions).toBe(own)
      const name = id === 'amp' ? 'Amp' : 'fx'
      if (own) await expect(session.chat.getByText(`${name}'s own setting`)).toBeVisible()
      await expect(session.chat.getByRole('button', { name: 'Auto mode' })).toHaveCount(own ? 0 : 1)
      const calls = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      if (id === 'amp') {
        // The adapter also asks the CLI for Amp's plugin modes (`amp plugins list`) as each
        // session starts. The chat's own CLI is the one it runs the turn in.
        const turns = calls.filter((call) => call.args.includes('--execute'))
        expect(turns).toHaveLength(1)
        const [run] = turns
        expect(run.args).toContain('--stream-json-thinking')
        expect(run.args).toContain('--stream-json-input')
        expect(run.args).not.toContain('--dangerously-allow-all')
        expect(run.cwd).toBe(session.fixture.root)
        expect(run.prompt).toContain('Hello from Gui')
        const mcpIndex = run.args.indexOf('--mcp-config')
        expect(mcpIndex).toBeGreaterThan(-1)
        expect(Object.keys(JSON.parse(run.args[mcpIndex + 1]))).not.toHaveLength(0)
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

// Gemini CLI runs as `gemini --acp`, takes Gui's preview tools over HTTP, and is set to its
// Default mode, which asks first. It says that mode change as a message of its own, which
// mustn't reach the chat.
test('gemini is selectable, starts in the mode that asks first, and streams a CLI response', async ({
  launch,
}) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gui-cli-'))
  const log = join(scratch, 'calls.jsonl')
  const cli = join(scratch, 'gemini')
  writeFileSync(cli, `#!${process.execPath}\n${GEMINI_SCRIPT}`)
  chmodSync(cli, 0o755)
  try {
    const session = await launch({
      fixture: 'vite',
      env: { SHELL: fakeShell(scratch), PATH: `${scratch}:${process.env.PATH}`, GUI_CLI_LOG: log },
    })
    await session.waitForPreview()
    await session.chrome.evaluate(() => window.gui.setAgent('gemini'))
    const health = (await session.state()).agents.find((agent) => agent.id === 'gemini')
    expect(health?.name).toBe('Gemini CLI')
    expect(health?.command).toBe('gemini')
    expect(health?.status).not.toBe('not-installed')
    expect(await session.chat.evaluate(() => window.gui.send('Hello from Gui'))).toBe(true)
    const { turn } = await session.waitForTurn(0)
    expect(turn.status).toBe('done')
    await expect(session.chat.getByText('Hello from the CLI', { exact: true })).toBeVisible()
    await expect(session.chat.getByText(/MODE_UPDATE/)).toHaveCount(0)
    const meta = (await session.chatSnapshot()).meta
    expect(meta.ownPermissions).toBe(false)
    expect(meta.modeName).toBe('Default')
    await expect(session.chat.getByRole('button', { name: 'Auto mode' })).toHaveCount(1)

    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(calls.some((call) => call.args?.[0] === '--acp')).toBe(true)
    const chat = calls.filter((call) => call.params?.cwd === session.fixture.root)
    const opened = chat.find((call) => call.method === 'session/new')
    expect(
      opened?.params.mcpServers.some((server: { type?: string }) => server.type === 'http'),
    ).toBe(true)
    const steps = calls
      .filter((call) => call.method === 'session/set_mode' || call.method === 'session/prompt')
      .map((call) => (call.method === 'session/prompt' ? 'prompt' : call.params.modeId))
    expect(steps).toEqual(['default', 'prompt'])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('gemini reads as not installed, with its install page, until it is on the PATH', async ({
  launch,
}) => {
  // A Mac with no gemini anywhere (GUI_PATH is the whole PATH). Nor bun, so the fixture's
  // dev server doesn't start; the agent list doesn't need it.
  const session = await launch({ fixture: 'vite', env: { GUI_PATH: '/usr/bin:/bin' } })
  const health = await waitFor(async () => {
    const agent = (await session.state()).agents.find((item) => item.id === 'gemini')
    return agent?.status === 'not-installed' ? agent : null
  }, 'gemini to read as not installed')
  expect(health.installUrl).toBe('https://geminicli.com/docs/get-started/installation')
})

// fx refuses to start without a login; jcode starts but fails each session until its setup
// has run, behind the Go ACP SDK's "Internal error"; Gemini starts but refuses a session
// with ACP's auth_required when it has no login or API key. Gui offers their sign-in rather
// than "Try again".
for (const [id, says] of [
  ['fx', 'fx login'],
  ['jcode', 'please run setup first'],
  ['gemini', 'Gemini API key is missing or not configured.'],
] as const) {
  test(`${id}: an agent that needs a login before it starts reads as signed out`, async ({
    launch,
  }) => {
    const scratch = mkdtempSync(join(tmpdir(), 'gui-cli-'))
    const cli = join(scratch, id)
    const script =
      id === 'fx'
        ? SIGNED_OUT_SCRIPT
        : id === 'jcode'
          ? NOT_SET_UP_SCRIPT
          : GEMINI_SIGNED_OUT_SCRIPT
    writeFileSync(cli, `#!${process.execPath}\n${script}`)
    chmodSync(cli, 0o755)
    try {
      const session = await launch({
        fixture: 'vite',
        env: { SHELL: fakeShell(scratch), PATH: `${scratch}:${process.env.PATH}` },
      })
      await session.waitForPreview()
      await session.chrome.evaluate((agentId) => window.gui.setAgent(agentId), id)
      const health = await waitFor(async () => {
        const agent = (await session.state()).agents.find((item) => item.id === id)
        return agent && agent.status !== 'checking' && agent.status !== 'unknown' ? agent : null
      }, `${id} checked`)
      expect(health.status).toBe('signed-out')
      expect(health.signIn?.label).toBe('Sign in')
      expect(health.message).toContain(says)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
}

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

const NOT_SET_UP_SCRIPT = String.raw`
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue
    const { id, method } = JSON.parse(line)
    if (id === undefined) continue
    if (method === 'initialize') {
      console.log(JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } }))
      continue
    }
    console.log(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error', data: { error: 'config error: config file not found at /Users/me/.jcode/config.json, please run setup first: open /Users/me/.jcode/config.json: no such file or directory' } } }))
  }
})
`

/**
 * Gemini CLI's ACP mode without a login: `initialize` works, and session/new fails with
 * auth_required and the reason, as its AcpSessionManager does when there's no API key.
 */
const GEMINI_SIGNED_OUT_SCRIPT = String.raw`
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue
    const { id, method } = JSON.parse(line)
    if (id === undefined) continue
    if (method === 'initialize') {
      const authMethods = [{ id: 'oauth-personal', name: 'Log in with Google' }, { id: 'gemini-api-key', name: 'Gemini API key' }]
      console.log(JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods } }))
      continue
    }
    console.log(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Gemini API key is missing or not configured.' } }))
  }
})
`

/**
 * Gemini CLI's ACP mode as its source has it: Google's sign-in methods, HTTP MCP servers,
 * and its approval levels as session modes, here starting in Auto Edit as a user's own
 * settings may pick. Changing the mode sends `[MODE_UPDATE] <mode>` as a message chunk
 * before the answer, as Gemini's ApprovalModeChanged handler does.
 */
const GEMINI_SCRIPT = String.raw`
const { appendFileSync } = require('node:fs')
const log = call => appendFileSync(process.env.GUI_CLI_LOG, JSON.stringify(call) + '\n')
log({ args: process.argv.slice(2) })
const write = message => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }))
const notify = (sessionId, update) => write({ method: 'session/update', params: { sessionId, update } })
const availableModes = [
  { id: 'default', name: 'Default', description: 'Prompts for approval' },
  { id: 'autoEdit', name: 'Auto Edit', description: 'Auto-approves edit tools' },
  { id: 'yolo', name: 'YOLO', description: 'Auto-approves all tools' },
  { id: 'plan', name: 'Plan', description: 'Read-only mode' },
]
let mode = 'autoEdit'
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    if (!line.trim()) continue
    const { id, method, params } = JSON.parse(line)
    if (id === undefined || method === undefined) continue
    log({ method, params })
    if (method === 'initialize') {
      const agentCapabilities = { loadSession: true, promptCapabilities: { image: true, audio: true, embeddedContext: true }, mcpCapabilities: { http: true, sse: true } }
      const authMethods = [{ id: 'oauth-personal', name: 'Log in with Google' }, { id: 'gemini-api-key', name: 'Gemini API key' }]
      write({ id, result: { protocolVersion: 1, agentCapabilities, authMethods, agentInfo: { name: 'gemini-cli', title: 'Gemini CLI', version: '0.70.0' } } })
    } else if (method === 'session/new') {
      write({ id, result: { sessionId: 'session-1', modes: { availableModes, currentModeId: mode } } })
    } else if (method === 'session/set_mode') {
      if (params.modeId !== mode) notify(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '[MODE_UPDATE] ' + params.modeId } })
      mode = params.modeId
      write({ id, result: {} })
    } else if (method === 'session/prompt') {
      notify(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello from the CLI' } })
      write({ id, result: { stopReason: 'end_turn' } })
    } else write({ id, error: { code: -32601, message: 'Method not found' } })
  }
})
`

/**
 * Amp's CLI as amp-acp 0.12 drives it: `amp plugins list` as a session starts, then one
 * `amp --execute --stream-json-thinking --stream-json-input` per session. That one reads
 * each prompt as a line of JSON on stdin, echoes it back as the turn starts, and stays up
 * until stdin closes (https://ampcode.com/docs/cli/streaming-json).
 */
const AMP_SCRIPT = String.raw`
const { appendFileSync } = require('node:fs')
const { createInterface } = require('node:readline')
const args = process.argv.slice(2)
const log = call => appendFileSync(process.env.GUI_CLI_LOG, JSON.stringify({ args, cwd: process.cwd(), ...call }) + '\n')
const fail = message => {
  console.error(message)
  process.exit(1)
}
if (args[0] === 'plugins') {
  log({})
  process.exit(0)
}
if (!args.includes('--stream-json-input')) fail('This stand-in only reads prompts with --stream-json-input')
if (!args.includes('--execute')) fail('The --stream-json-input flag requires --execute mode')
if (!args.includes('--stream-json') && !args.includes('--stream-json-thinking')) fail('The --stream-json-input flag requires --stream-json')
const session_id = 'T-01a03c00-e608-7007-8181-5c1cc56757be'
const write = message => console.log(JSON.stringify({ ...message, session_id }))
let started = false
createInterface({ input: process.stdin })
  .on('line', line => {
    if (!line.trim()) return
    const { type, message } = JSON.parse(line)
    if (type !== 'user' || message.role !== 'user') fail('Expected a user message, got ' + line)
    log({ prompt: message.content.map(part => part.text ?? '').join('') })
    if (!started) write({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: [], mcp_servers: [] })
    started = true
    write({ type: 'user', message: { role: 'user', content: message.content }, parent_tool_use_id: null })
    write({ type: 'assistant', message: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Hello from the CLI' }], stop_reason: 'end_turn' }, parent_tool_use_id: null })
  })
  .on('close', () => write({ type: 'result', subtype: 'success', is_error: false, result: 'Hello from the CLI' }))
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
