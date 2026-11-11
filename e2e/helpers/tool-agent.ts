import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { electronExecutable, waitFor } from './env'
import { type GuiSession, standInsFile } from './session'
import { expect } from './test'

// Calls the real MCP server through a stand-in agent: no agent login or paid usage.
const AGENT_SCRIPT = String.raw`
const { appendFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const write = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
let mcp, cwd
const call = async (name, args, save) => {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  for (const header of mcp.headers) headers[header.name] = header.value
  const response = await fetch(mcp.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  const reply = await response.json()
  if (reply.error) throw new Error(reply.error.message)
  const image = save && reply.result.content.find(item => item.type === 'image')
  if (image) writeFileSync(save, Buffer.from(image.data, 'base64'))
  return { ...reply.result, content: reply.result.content.map(item => item.type === 'image' ? { type: 'image', bytes: item.data.length } : item) }
}
const prompt = async params => {
  const request = params.prompt.filter(block => block.type === 'text').map(block => block.text).find(text => text.startsWith('TOOLS '))
  const results = []
  for (const step of JSON.parse(request.slice(6))) {
    if (step.wait) await new Promise(resolve => setTimeout(resolve, step.wait))
    else if (step.css) {
      appendFileSync(join(cwd, 'src', 'index.css'), '\n' + step.css + '\n')
      // The real agent would observe hot reload and retry its checks as needed.
      await new Promise(resolve => setTimeout(resolve, 800))
    } else if (step.write) {
      writeFileSync(join(cwd, step.write.path), step.write.text)
      await new Promise(resolve => setTimeout(resolve, 800))
    } else if (step.context) {
      const texts = params.prompt.filter(block => block.type === 'text' && block.text.startsWith(step.context))
      results.push({ content: texts.map(block => ({ type: 'text', text: block.text })) })
    } else results.push(await call(step.name, step.args || {}, step.save))
  }
  write({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(results) } } } })
  return { stopReason: 'end_turn' }
}
const handle = ({ id, method, params }) => {
  if (id === undefined || !method) return
  if (method === 'initialize') return write({ id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true }, promptCapabilities: { image: true } }, authMethods: [] } })
  if (method === 'session/new') { cwd = params.cwd; mcp = params.mcpServers.find(server => server.url); return write({ id, result: { sessionId: 'interactions' } }) }
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

/** Makes the chat's agent a stand-in that runs `TOOLS [...]` messages as real MCP tool calls. */
export async function installToolAgent(session: GuiSession) {
  const script = join(session.fixture.base, 'interactions-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  writeFileSync(
    standInsFile(session.fixture),
    JSON.stringify({
      grok: {
        command: electronExecutable(),
        args: [script],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      },
    }),
  )
  await session.chrome.evaluate(() => window.gui.setAgent('grok'))
  await waitFor(
    async () => (await session.chatSnapshot()).meta.agentId === 'grok',
    'the stand-in agent',
  )
}

export interface ToolResult {
  isError?: boolean
  content: { type: string; text?: string; bytes?: number }[]
}
export interface Step {
  name?: string
  args?: Record<string, unknown>
  css?: string
  /** Writes a project file, as an agent's edit would */
  write?: { path: string; text: string }
  /** Waits this many ms, as an agent thinking between calls would */
  wait?: number
  /** Echoes the message's text blocks that start with this, as the agent received them */
  context?: string
  /** Writes the result's first image to this path */
  save?: string
}
/** Sends `steps` as one message; `during` acts as the user while its turn runs. */
export async function ask(
  session: GuiSession,
  steps: Step[],
  during?: () => Promise<void>,
): Promise<ToolResult[]> {
  const index = (await session.chatSnapshot()).turns.length
  expect(
    await session.chat.evaluate((text) => window.gui.send(text), `TOOLS ${JSON.stringify(steps)}`),
  ).toBe(true)
  await during?.()
  const { turn } = await session.waitForTurn(index)
  expect(turn.error).toBeNull()
  expect(turn.status).toBe('done')
  return JSON.parse(
    turn.items.flatMap((item) => (item.kind === 'text' ? [item.text] : [])).join(''),
  )
}

export function pageData(result: ToolResult) {
  const fenced = result.content.find((item) => item.type === 'text')?.text ?? ''
  return JSON.parse(fenced.slice(fenced.indexOf('{'), fenced.lastIndexOf('}') + 1))
}
