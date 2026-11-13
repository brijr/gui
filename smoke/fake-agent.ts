import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { electronExecutable } from '../e2e/helpers/env'
import { AGENTS, type AgentId } from '../src/shared/types'

/**
 * How a fake agent behaves, to prove each path of the smoke test without a real agent:
 *
 *   pass         lists Gui's tools, screenshots the preview, replies with the page title
 *   list-only    lists Gui's tools but calls none
 *   no-mcp       says it can't take HTTP MCP servers, so Gui's tools never reach it
 *   turn-error   fails the prompt with an error
 *   hang         never finishes the prompt (the turn times out)
 *   crash        exits as soon as it starts (Gui's own check fails)
 *   signed-out   says sign-in is required (skipped)
 *   missing      its command isn't on PATH (skipped)
 */
export const FAKE_BEHAVIORS = [
  'pass',
  'list-only',
  'no-mcp',
  'turn-error',
  'hang',
  'crash',
  'signed-out',
  'missing',
] as const
export type FakeBehavior = (typeof FAKE_BEHAVIORS)[number]

/**
 * GUI_SMOKE_FAKE, `agent=behavior` pairs separated by commas (`grok=pass,kiro=hang`): those
 * agents are replaced by fakes. Null when it isn't set.
 */
export function parseFakes(spec: string | undefined): Map<AgentId, FakeBehavior> | null {
  if (!spec) return null
  const fakes = new Map<AgentId, FakeBehavior>()
  for (const pair of spec.split(',')) {
    const [id = '', behavior = ''] = pair.split('=').map((part) => part.trim())
    if (!AGENTS.some((agent) => agent.id === id))
      throw new Error(`GUI_SMOKE_FAKE: unknown agent "${id}"`)
    if (!FAKE_BEHAVIORS.includes(behavior as FakeBehavior)) {
      throw new Error(`GUI_SMOKE_FAKE: "${behavior}" isn't one of ${FAKE_BEHAVIORS.join(', ')}`)
    }
    fakes.set(id as AgentId, behavior as FakeBehavior)
  }
  return fakes
}

/**
 * Speaks ACP (ndjson JSON-RPC) on stdio and calls Gui's MCP server over HTTP, as `behavior`
 * says. It offers two models, so the smoke test's pick of the cheaper one shows.
 */
const SCRIPT = String.raw`
const behavior = process.argv[2]
const TITLE = process.argv[3]
if (behavior === 'crash') {
  process.stderr.write('fake agent: crashed on start\n')
  process.exit(3)
}
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const notify = (sessionId, update) => write({ method: 'session/update', params: { sessionId, update } })
let mcp = null
let model = 'fake-large'
const configOptions = () => [{
  id: 'model', name: 'Model', type: 'select', category: 'model', currentValue: model,
  options: [{ value: 'fake-large', name: 'Fake Large' }, { value: 'fake-mini', name: 'Fake Mini' }],
}]
const mcpRequest = async (method, params) => {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  for (const header of mcp.headers) headers[header.name] = header.value
  const response = await fetch(mcp.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const reply = await response.json()
  if (reply.error) throw new Error(reply.error.message)
  return reply.result
}
const prompt = async ({ sessionId }) => {
  if (behavior === 'hang') return new Promise(() => {})
  if (behavior === 'turn-error') throw new Error('fake agent: the model refused')
  if (behavior === 'pass' || behavior === 'list-only') {
    const { tools } = await mcpRequest('tools/list', {})
    if (!tools.some((tool) => tool.name === 'preview_screenshot')) throw new Error('no preview_screenshot tool')
  }
  if (behavior === 'pass') {
    const toolCallId = 'shot-1'
    notify(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: 'mcp__gui__preview_screenshot', kind: 'other', status: 'in_progress' })
    const result = await mcpRequest('tools/call', { name: 'preview_screenshot', arguments: {} })
    if (result.isError) throw new Error('preview_screenshot failed')
    notify(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' })
  }
  const text = behavior === 'pass' ? TITLE : 'I did not look at the page. (' + model + ')'
  notify(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
  return { stopReason: 'end_turn' }
}
const handle = ({ id, method, params }) => {
  if (id === undefined || !method) return
  if (method === 'initialize') {
    const mcpCapabilities = { http: behavior !== 'no-mcp' }
    return write({ id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities }, authMethods: [{ id: 'login', name: 'Log in' }] } })
  }
  if (method === 'session/new') {
    if (behavior === 'signed-out') return write({ id, error: { code: -32000, message: 'Authentication required' } })
    mcp = params.mcpServers.find((server) => server.url) || null
    return write({ id, result: { sessionId: 'smoke-1', configOptions: configOptions() } })
  }
  if (method === 'session/set_config_option') {
    if (params.configId === 'model') model = params.value
    return write({ id, result: { configOptions: configOptions() } })
  }
  if (method === 'session/prompt') {
    return void prompt(params).then(
      (result) => write({ id, result }),
      (error) => write({ id, error: { code: -32603, message: error.message } }),
    )
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

/**
 * Writes the fake agent into `dir` and the GUI_AGENT_STAND_INS file that launches it in place
 * of each faked agent (agents.ts `builtInAgents`). A `missing` one gets a command that
 * isn't on PATH.
 */
export function writeFakeStandIns(
  file: string,
  dir: string,
  fakes: Map<AgentId, FakeBehavior>,
  title: string,
) {
  const script = join(dir, 'smoke-fake-agent.cjs')
  writeFileSync(script, SCRIPT)
  const standIns: Record<string, unknown> = {}
  for (const [id, behavior] of fakes) {
    standIns[id] =
      behavior === 'missing'
        ? { command: 'gui-smoke-agent-not-installed' }
        : {
            command: electronExecutable(),
            args: [script, behavior, title],
            env: { ELECTRON_RUN_AS_NODE: '1' },
          }
  }
  writeFileSync(file, JSON.stringify(standIns))
}
