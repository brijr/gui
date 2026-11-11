import { describe, expect, test } from 'bun:test'
import type * as acp from '@agentclientprotocol/sdk'
import {
  echoedAnswer,
  messageText,
  overflowingSteps,
  SubagentRouter,
  sessionMessageRole,
  subagentPatch,
} from '../src/main/subagents'
import { MAX_SUBAGENT_SESSIONS } from '../src/shared/bounded'
import type { TurnItem } from '../src/shared/types'

type Update = acp.SessionNotification['update']
type SubagentUpdate = Extract<Update, { sessionUpdate: 'subagent_update' }>
type SessionMessage = Extract<Update, { sessionUpdate: 'session_message' }>

const ROOT = 'root'
const text = (value: string): Update => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: value },
})
const toolCall = (toolCallId: string): Update => ({
  sessionUpdate: 'tool_call',
  toolCallId,
  title: 'Read src/App.tsx',
  kind: 'read',
  status: 'in_progress',
})
// As claude-agent-acp 0.101.1 announces a child (announceNativeSubagent).
const announce = (sessionId: string, title = 'Explore'): SubagentUpdate => ({
  sessionUpdate: 'subagent_update',
  sessionId,
  title,
  description: 'Explore',
  capabilities: { cancel: {} },
  state: { state: 'running' },
})

function router() {
  const routes = new SubagentRouter()
  routes.setRoot(ROOT)
  return routes
}

describe('SubagentRouter', () => {
  test('the agent’s own updates are its own', () => {
    expect(router().route(ROOT, text('hi'), true)).toEqual([{ update: text('hi'), from: null }])
  })

  test('a session it was never told about is dropped, as the RFD has a client do', () => {
    const routes = router()
    expect(routes.route('stranger', toolCall('t1'), true)).toEqual([])
    expect(routes.owner('stranger')).toBeUndefined()
  })

  test('a subagent announced on the root routes its own steps to it', () => {
    const routes = router()
    expect(routes.route(ROOT, announce('child-1'), true)).toEqual([
      { update: announce('child-1'), from: null },
    ])
    expect(routes.route('child-1', toolCall('t1'), true)).toEqual([
      { update: toolCall('t1'), from: 'child-1' },
    ])
    expect(routes.owner('child-1')).toBe('child-1')
    expect(routes.isChild('child-1')).toBe(true)
  })

  test('two subagents in parallel stay apart', () => {
    const routes = router()
    routes.route(ROOT, announce('a', 'Styles'), true)
    routes.route(ROOT, announce('b', 'Routes'), true)
    const from = [
      ...routes.route('a', toolCall('a1'), true),
      ...routes.route('b', toolCall('b1'), true),
      ...routes.route('a', text('found it'), true),
    ].map((delivery) => delivery.from)
    expect(from).toEqual(['a', 'b', 'a'])
  })

  test('a subagent’s settings, commands and usage are not the chat’s', () => {
    const routes = router()
    routes.route(ROOT, announce('child-1'), true)
    const usage = { sessionUpdate: 'usage_update', used: 1, size: 2 } as Update
    const commands: Update = { sessionUpdate: 'available_commands_update', availableCommands: [] }
    const config: Update = { sessionUpdate: 'config_option_update', configOptions: [] }
    for (const update of [usage, commands, config]) {
      expect(routes.route('child-1', update, true)).toEqual([])
    }
  })

  test('Claude’s report of a subagent’s model, on the root, is not the session’s model', () => {
    // NativeSubagentRuntime.reportModel
    const childModel: Update = {
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'haiku',
          options: [{ value: 'haiku', name: 'Haiku' }],
        },
      ],
      _meta: { claudeCode: { parentToolUseId: 'toolu_1' } },
    }
    expect(router().route(ROOT, childModel, true)).toEqual([])
    const own: Update = { sessionUpdate: 'config_option_update', configOptions: [] }
    expect(router().route(ROOT, own, true)).toHaveLength(1)
  })

  test('a subagent’s own subagent is announced on it, and comes from it', () => {
    const routes = router()
    routes.route(ROOT, announce('child'), true)
    expect(routes.route('child', announce('grandchild', 'Deeper'), true)).toEqual([
      { update: announce('grandchild', 'Deeper'), from: 'child' },
    ])
    expect(routes.route('grandchild', text('deep'), true)).toEqual([
      { update: text('deep'), from: 'grandchild' },
    ])
  })

  test('a later update keeps the labels it leaves out, and null clears one', () => {
    const routes = router()
    routes.route(ROOT, announce('child', 'Explore'), true)
    const idle: SubagentUpdate = {
      sessionUpdate: 'subagent_update',
      sessionId: 'child',
      state: { state: 'idle', stopReason: 'end_turn' },
    }
    const [delivery] = routes.route(ROOT, idle, true)
    expect(delivery.update).toMatchObject({ title: 'Explore', description: 'Explore' })
    const cleared = { ...idle, description: null }
    expect(routes.route(ROOT, cleared, true)[0].update).toMatchObject({
      title: 'Explore',
      description: null,
    })
  })

  test('a replay shows nothing, but its subagents are known when handed more work', () => {
    const routes = new SubagentRouter()
    routes.setRoot('old-session')
    // session/load replays the transcript before Gui takes the session as live.
    expect(routes.route('old-session', announce('child', 'Explore'), false)).toEqual([])
    expect(routes.route('child', toolCall('t-old'), false)).toEqual([])
    expect(routes.route('old-session', text('old reply'), false)).toEqual([])
    // Resumed as the same session: what the replay announced stays known.
    routes.setRoot('old-session')
    const [first, second] = routes.route('child', toolCall('t-new'), true)
    // The chat never saw the announcement, so it gets one first, with the labels it had.
    expect(first).toEqual({
      update: {
        sessionUpdate: 'subagent_update',
        sessionId: 'child',
        title: 'Explore',
        description: 'Explore',
      },
      from: null,
    })
    expect(second).toEqual({ update: toolCall('t-new'), from: 'child' })
    // Only once.
    expect(routes.route('child', text('more'), true)).toHaveLength(1)
  })

  test('a new session forgets the last one’s subagents', () => {
    const routes = router()
    routes.route(ROOT, announce('child'), true)
    routes.setRoot('another')
    expect(routes.route('child', text('late'), true)).toEqual([])
  })

  test('it remembers a bounded number of subagents, dropping the oldest', () => {
    const routes = router()
    for (let index = 0; index <= MAX_SUBAGENT_SESSIONS; index++) {
      routes.route(ROOT, announce(`child-${index}`), true)
    }
    expect(routes.isChild('child-0')).toBe(false)
    expect(routes.isChild(`child-${MAX_SUBAGENT_SESSIONS}`)).toBe(true)
  })
})

describe('subagentPatch', () => {
  const update = (state: unknown, extra: Partial<SubagentUpdate> = {}) =>
    ({ sessionUpdate: 'subagent_update', sessionId: 'child', state, ...extra }) as SubagentUpdate

  test('running, and waiting while one of its requests is open', () => {
    expect(subagentPatch(update({ state: 'running' }), 5)).toEqual({
      status: 'running',
      error: null,
      endedAt: null,
    })
    expect(subagentPatch(update({ state: 'requires_action' }), 5)).toMatchObject({
      status: 'waiting',
      endedAt: null,
    })
  })

  test('idle ends its work: done, stopped, or failed with why', () => {
    expect(subagentPatch(update({ state: 'idle', stopReason: 'end_turn' }), 5)).toEqual({
      status: 'done',
      error: null,
      endedAt: 5,
    })
    expect(subagentPatch(update({ state: 'idle', stopReason: 'cancelled' }), 5)).toMatchObject({
      status: 'stopped',
    })
    // rfdEndState: the README calls it the error text, the code sends a JSON-RPC error.
    const failed = { state: 'idle', stopReason: 'error', error: { code: -32603, message: 'Boom' } }
    expect(subagentPatch(update(failed), 5)).toEqual({
      status: 'failed',
      error: 'Boom',
      endedAt: 5,
    })
    expect(
      subagentPatch(update({ state: 'idle', stopReason: 'error', error: 'Out of tokens' }), 5),
    ).toMatchObject({ status: 'failed', error: 'Out of tokens' })
    // Ended without a reason the agent saw (a worker restart): done, not failed.
    expect(subagentPatch(update({ state: 'idle' }), 5)).toMatchObject({ status: 'done' })
  })

  test('a subagent the agent can no longer see is not shown as working', () => {
    expect(subagentPatch(update({ state: 'unknown' }), 5)).toMatchObject({ status: 'stopped' })
  })

  test('an omitted or cleared state changes nothing; an unknown one is ignored', () => {
    expect(subagentPatch(update(undefined), 5)).toEqual({})
    expect(subagentPatch(update(null), 5)).toEqual({})
    expect(subagentPatch(update({ state: 'paused' }), 5)).toEqual({})
  })

  test('whether the user can stop it alone follows its cancel capability', () => {
    expect(subagentPatch(update(undefined, { capabilities: { cancel: {} } }), 5)).toEqual({
      canStop: true,
    })
    // Codex withdraws it between turns.
    expect(subagentPatch(update(undefined, { capabilities: { cancel: null } }), 5)).toEqual({
      canStop: false,
    })
    expect(subagentPatch(update(undefined, { capabilities: null }), 5)).toEqual({ canStop: false })
  })
})

describe('sessionMessageRole', () => {
  const known = (id: string) => id === 'child'
  // linkedSessionMessages: the parent's outgoing view and the child's incoming one.
  const prompt = (extra: Record<string, unknown>) =>
    ({
      sessionUpdate: 'session_message',
      messageId: 'toolu_1',
      senderSessionId: ROOT,
      recipientSessionId: 'child',
      content: [{ type: 'text', text: 'Find the styles' }],
      ...extra,
    }) as SessionMessage

  test('the task sent to a subagent, in either copy', () => {
    expect(sessionMessageRole(prompt({ recipientMessageId: 'toolu_1' }), known)).toEqual({
      subagent: 'child',
      role: 'prompt',
    })
    expect(sessionMessageRole(prompt({ senderMessageId: 'toolu_1' }), known)).toEqual({
      subagent: 'child',
      role: 'prompt',
    })
  })

  test('what a subagent answered (launchReply)', () => {
    const reply = {
      sessionUpdate: 'session_message',
      messageId: 'toolu_1:reply',
      senderSessionId: 'child',
      recipientSessionId: ROOT,
      content: [{ type: 'text', text: 'Tailwind, in src/styles.css' }],
    } as SessionMessage
    expect(sessionMessageRole(reply, known)).toEqual({ subagent: 'child', role: 'answer' })
  })

  test('a message between sessions it doesn’t know as subagents is nothing', () => {
    const other = prompt({ recipientSessionId: 'stranger' })
    expect(sessionMessageRole(other, known)).toBeNull()
  })

  test('messageText joins text blocks and ignores others', () => {
    expect(
      messageText([
        { type: 'text', text: 'One' },
        { type: 'image', data: '', mimeType: 'image/png' },
        { type: 'text', text: 'Two ' },
      ]),
    ).toBe('One\n\nTwo')
    expect(messageText([])).toBeNull()
    expect(messageText(null)).toBeNull()
  })
})

describe('a subagent’s items', () => {
  const step = (id: string, subagent?: string): TurnItem => ({
    kind: 'tool',
    id,
    title: id,
    toolKind: 'read',
    status: 'completed',
    locations: [],
    ...(subagent ? { subagent } : {}),
  })

  test('past the cap, its oldest steps go; the agent’s, other subagents’ and questions stay', () => {
    const question: TurnItem = {
      kind: 'permission',
      id: 'q',
      title: 'npm test',
      toolKind: 'execute',
      locations: [],
      sensitive: false,
      options: [],
      resolved: null,
      subagent: 'a',
    }
    const items = [step('own'), step('a1', 'a'), question, step('b1', 'b'), step('a2', 'a')]
    items.push(step('a3', 'a'))
    expect(overflowingSteps(items, 'a', 2)).toEqual([1])
    expect(overflowingSteps(items, 'a', 3)).toEqual([])
  })

  test('its closing words, when they are the answer it handed back, show once', () => {
    const items: TurnItem[] = [
      step('a1', 'a'),
      { kind: 'text', id: 't', text: 'The answer.\n', subagent: 'a' },
      step('b1', 'b'),
    ]
    expect(echoedAnswer(items, 'a', 'The answer.')).toBe(1)
    expect(echoedAnswer(items, 'a', 'Something else')).toBe(-1)
    expect(echoedAnswer([step('a1', 'a')], 'a', 'The answer.')).toBe(-1)
  })
})
