import { describe, expect, test } from 'bun:test'
import * as acp from '@agentclientprotocol/sdk'

import {
  agentFailure,
  displayedModes,
  errorDetail,
  formQuestions,
  mcpServersFor,
  questionRequest,
  resumeMethods,
} from '../src/main/agent-protocol'
import type { AgentFailure } from '../src/main/analytics-queue'

const select = (
  id: string,
  category: string,
  currentValue: string,
  values: string[],
): acp.SessionConfigOption =>
  ({
    id,
    name: id,
    category,
    type: 'select',
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  }) as acp.SessionConfigOption

describe('displayedModes', () => {
  // As pi-acp 0.0.34 reports a new session.
  const piModes: acp.SessionModeState = {
    currentModeId: 'high',
    availableModes: ['low', 'high', 'max'].map((id) => ({ id, name: `Thinking: ${id}` })),
  }
  const piOptions = [
    select('model', 'model', 'kimi', ['kimi', 'claude']),
    select('thought_level', 'thought_level', 'high', ['low', 'high', 'max']),
  ]

  test('modes that mirror another setting (pi’s thinking levels) are no mode', () => {
    expect(displayedModes(piModes, piOptions)).toBeNull()
  })

  test('a thinking level changed through the modes still counts as the mirror', () => {
    const options = [select('thought_level', 'thought_level', 'max', ['low', 'high', 'max'])]
    expect(displayedModes({ ...piModes, currentModeId: 'max' }, options)).toBeNull()
  })

  test('real modes stay, including ones the mode option also lists', () => {
    const modes: acp.SessionModeState = {
      currentModeId: 'plan',
      availableModes: [
        { id: 'build', name: 'Build' },
        { id: 'plan', name: 'Plan' },
      ],
    }
    expect(displayedModes(modes, [])).toBe(modes)
    expect(displayedModes(modes, [select('mode', 'mode', 'plan', ['build', 'plan'])])).toBe(modes)
    // A setting sharing only some values is not a mirror.
    expect(displayedModes(modes, [select('x', 'other', 'plan', ['plan', 'other'])])).toBe(modes)
  })

  test('no modes, or a malformed list from a custom agent', () => {
    expect(displayedModes(null, piOptions)).toBeNull()
    const odd = { currentModeId: 'a', availableModes: null } as unknown as acp.SessionModeState
    expect(displayedModes(odd, piOptions)).toBe(odd)
  })
})

describe('errorDetail', () => {
  test('Codex’s reason behind "Internal error" (as codex-acp 2.6.0 sends a failed session/load)', () => {
    const error = new acp.RequestError(-32603, 'Internal error', {
      details: 'no rollout found for thread id 01a1c178',
    })
    expect(errorDetail(error)).toBe('no rollout found for thread id 01a1c178')
  })

  test('Codex’s failed turn, the Go SDK’s wrapper, and plain string data', () => {
    const turn = { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' }
    expect(errorDetail(new acp.RequestError(-32603, 'Internal error', turn))).toBe(
      'You have hit your usage limit.',
    )
    const go = new acp.RequestError(-32603, 'Internal error', { error: 'please run setup first' })
    expect(errorDetail(go)).toBe('please run setup first')
    expect(errorDetail(new acp.RequestError(-32603, 'Internal error', ' Logged out. '))).toBe(
      'Logged out.',
    )
  })

  test('the message when data says nothing more', () => {
    expect(errorDetail(new acp.RequestError(-32602, 'Invalid params', { issues: [] }))).toBe(
      'Invalid params',
    )
    expect(errorDetail(new acp.RequestError(-32603, 'Internal error', { details: ' ' }))).toBe(
      'Internal error',
    )
    expect(errorDetail(new Error('Agent is not running'))).toBe('Agent is not running')
  })
})

describe('resumeMethods', () => {
  test('session/resume first, which sends no replay, then session/load', () => {
    // As Claude, Codex, Amp, Muse, Grok, fx and OpenCode advertise them.
    expect(resumeMethods({ loadSession: true, sessionCapabilities: { resume: {} } })).toEqual([
      'resume',
      'load',
    ])
  })

  test('only what the agent advertises', () => {
    // pi-acp 0.0.34: load, no resume.
    expect(resumeMethods({ loadSession: true, sessionCapabilities: { list: {} } })).toEqual([
      'load',
    ])
    expect(resumeMethods({ sessionCapabilities: { resume: {} } })).toEqual(['resume'])
    expect(resumeMethods({ sessionCapabilities: { resume: null } })).toEqual([])
    expect(resumeMethods({})).toEqual([])
    expect(resumeMethods(undefined)).toEqual([])
  })
})

describe('formQuestions', () => {
  const pick = {
    type: 'string',
    title: 'Base branch',
    description: 'Which branch should the pull request target?',
    oneOf: [
      { const: 'main', title: 'main' },
      { const: 'dev', title: 'dev' },
    ],
  }

  test('asks a single pick, leaving out an optional answer of your own beside it', () => {
    // OpenCode's question tool with `custom`: the choices, plus a free-text "other" field.
    expect(
      formQuestions({
        type: 'object',
        properties: {
          base: pick,
          'base:other': { type: 'string', title: 'Base branch (other)' },
        },
        required: ['base'],
      }),
    ).toEqual([
      {
        id: 'base',
        title: 'Base branch',
        description: 'Which branch should the pull request target?',
        choices: [
          { value: 'main', name: 'main' },
          { value: 'dev', name: 'dev' },
        ],
      },
    ])
  })

  test('reads plain enums', () => {
    expect(
      formQuestions({ properties: { size: { type: 'string', enum: ['S', 'L'] } } })?.[0].choices,
    ).toEqual([
      { value: 'S', name: 'S' },
      { value: 'L', name: 'L' },
    ])
  })

  test('keeps what each choice means', () => {
    expect(
      formQuestions({
        properties: {
          q0: {
            type: 'string',
            title: 'Cleanup',
            oneOf: [
              { const: 'Remove', title: 'Remove', description: 'Delete `/dev/styleguide`' },
              { const: 'Keep', title: 'Keep', description: '' },
            ],
          },
        },
      }),
    ).toEqual([
      {
        id: 'q0',
        title: 'Cleanup',
        description: undefined,
        choices: [
          { value: 'Remove', name: 'Remove', description: 'Delete `/dev/styleguide`' },
          { value: 'Keep', name: 'Keep' },
        ],
      },
    ])
  })

  test("can't ask a required field without choices, a multi-pick alone, or nothing", () => {
    expect(
      formQuestions({
        properties: { base: pick, reason: { type: 'string' } },
        required: ['reason'],
      }),
    ).toBeNull()
    expect(
      formQuestions({
        properties: { files: { type: 'array', items: { anyOf: [{ const: 'a', title: 'a' }] } } },
        required: ['files'],
      }),
    ).toBeNull()
    expect(formQuestions({ properties: { note: { type: 'string' } } })).toBeNull()
    expect(formQuestions(undefined)).toBeNull()
  })
})

describe('questionRequest', () => {
  const choices = [
    { value: 'a', name: 'Remove the page', description: 'Delete `/dev/styleguide` for good' },
    { value: 'b', name: 'Keep it' },
  ]

  test("a lone question in the form's message (Claude): the message is the question", () => {
    const question = { id: 'q0', title: 'Cleanup', description: undefined, choices }
    const request = questionRequest('s1', question, 'What should happen to the styleguide?')
    expect(request.toolCall).toMatchObject({
      toolCallId: 'question:q0',
      title: 'What should happen to the styleguide?',
      kind: 'question',
    })
    expect(request.message).toBeUndefined()
    // Skip first for Auto mode; each choice keeps what it means.
    expect(request.options as unknown[]).toEqual([
      { optionId: 'skip', name: 'Skip', kind: 'reject_once' },
      {
        optionId: '0',
        name: 'Remove the page',
        kind: 'answer',
        description: 'Delete `/dev/styleguide` for good',
      },
      { optionId: '1', name: 'Keep it', kind: 'answer' },
    ])
  })

  test("a question of its own keeps the form's message beside it, never twice", () => {
    const question = {
      id: 'q1',
      title: 'Cleanup',
      description: 'What should happen to the styleguide?',
      choices,
    }
    const several = questionRequest('s1', question, 'Before I tidy up, two questions.')
    expect(several.toolCall.title).toBe('What should happen to the styleguide?')
    expect(several.message).toBe('Before I tidy up, two questions.')
    const same = questionRequest('s1', question, 'What should happen to the styleguide?')
    expect(same.message).toBeUndefined()
    // One of several: the form's message is for them all ("Please answer the following questions.").
    const one = questionRequest('s1', question, 'Please answer the following questions.', true)
    expect(one.toolCall.title).toBe('What should happen to the styleguide?')
    expect(one.message).toBeUndefined()
  })

  test('falls back to the field title, then plain words', () => {
    expect(
      questionRequest('s1', { id: 'q', title: 'Size', description: undefined, choices }, '')
        .toolCall.title,
    ).toBe('Size')
    expect(
      questionRequest('s1', { id: 'q', title: undefined, description: undefined, choices }, '')
        .toolCall.title,
    ).toBe('The agent has a question')
  })
})

describe('agentFailure', () => {
  const plain = (raw: string) => agentFailure(new Error(raw))

  test('known failures in the agent’s text read in plain words, each with its name for usage data', () => {
    const cases: [string, RegExp, AgentFailure][] = [
      [
        'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_1"}',
        /servers are busy/,
        'servers_busy',
      ],
      [
        'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
        /too many requests/,
        'rate_limited',
      ],
      ['429 You exceeded your current quota (insufficient_quota)', /out of credit/, 'no_credit'],
      ['Your credit balance is too low to access the Anthropic API.', /out of credit/, 'no_credit'],
      [
        'API Error: 500 {"type":"error","error":{"type":"api_error"}}',
        /servers had a problem/,
        'server_error',
      ],
      ['503 Service Unavailable', /servers had a problem/, 'server_error'],
      [
        'request to https://api.example.com failed, reason: getaddrinfo ENOTFOUND',
        /internet/,
        'offline',
      ],
      ['The request timed out', /internet/, 'offline'],
      ['prompt is too long: 210000 tokens > 200000 maximum', /too long/, 'context_too_long'],
    ]
    for (const [raw, message, failure] of cases) {
      expect(plain(raw)?.message).toMatch(message)
      expect(plain(raw)?.failure).toBe(failure)
    }
  })

  test('Claude’s errorKind (claude-agent-acp), behind "Internal error: <the CLI’s text>"', () => {
    const claude = (errorKind: string, text: string) =>
      agentFailure(new acp.RequestError(-32603, `Internal error: ${text}`, { errorKind }))
    expect(
      claude(
        'model_not_found',
        'API Error: 404 {"type":"error","error":{"type":"not_found_error"}}',
      ),
    ).toEqual({ failure: 'no_model', message: expect.stringMatching(/no model it can use/) })
    expect(
      claude(
        'invalid_request',
        'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1.content.0.image.source: image exceeds 5 MB maximum"}}',
      ),
    ).toEqual({ failure: 'bad_request', message: null })
    // A bad request whose text names a known failure is that failure.
    expect(
      claude(
        'invalid_request',
        'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}',
      )?.failure,
    ).toBe('context_too_long')
    expect(
      claude(
        'no_result',
        'The turn ended without a result: the agent went idle while this prompt was still in flight (e.g. the model stream dropped mid-turn). Any partial output may be incomplete; please retry.',
      ),
    ).toEqual({ failure: 'dropped', message: expect.stringMatching(/dropped partway/) })
    expect(claude('incomplete_tool_call', 'The Write tool call never finished.')).toEqual({
      failure: 'tool_failed',
      message: null,
    })
    expect(claude('transport_lost', 'transport lost')?.failure).toBe('agent_quit')
    expect(claude('billing_error', 'Credit balance is too low')?.failure).toBe('no_credit')
    expect(claude('overloaded', 'Overloaded')?.failure).toBe('servers_busy')
    // A kind Gui doesn't name falls back to the text.
    expect(claude('unknown', 'Something broke')).toBeNull()
  })

  test('Codex’s codexErrorInfo (codex-acp), as a name or keyed object', () => {
    const codex = (codexErrorInfo: unknown) =>
      agentFailure(
        new acp.RequestError(-32603, 'Internal error', {
          message: 'You have hit your usage limit.',
          codexErrorInfo,
        }),
      )
    expect(codex('usageLimitExceeded')?.failure).toBe('no_credit')
    expect(codex({ responseStreamDisconnected: { httpStatusCode: null } })).toEqual({
      failure: 'dropped',
      message: expect.stringMatching(/dropped partway/),
    })
    expect(codex({ httpConnectionFailed: { httpStatusCode: null } })?.failure).toBe('offline')
  })

  test('OpenCode’s errorName and its own fixed texts', () => {
    const opencode = (errorName: string, text: string) =>
      agentFailure(
        new acp.RequestError(-32603, `Internal error: ${text}`, { service: 'session', errorName }),
      )
    expect(opencode('provider.no-route', 'Model not found: acme/big-model')?.failure).toBe(
      'no_model',
    )
    expect(
      opencode('permission.rejected', 'The user rejected permission to use this tool'),
    ).toEqual({ failure: 'denied', message: expect.stringMatching(/you declined/) })
    expect(opencode('tool.execution', 'bash exited with code 2')).toEqual({
      failure: 'tool_failed',
      message: null,
    })
    expect(opencode('provider.go-limit', 'OpenCode Go usage limit reached.')?.failure).toBe(
      'no_credit',
    )
    expect(opencode('provider.timeout', 'Request timed out')?.failure).toBe('timeout')
    // session/new with no provider set up: the SDK wraps the agent's error as `{ details }`.
    expect(
      agentFailure(
        new acp.RequestError(-32603, 'Internal error', { details: 'No models are available' }),
      ),
    ).toEqual({ failure: 'no_model', message: expect.stringMatching(/no model it can use/) })
    // ACPInvalidModelError, as session/set_config_option or a prompt refuses a model.
    expect(
      agentFailure(
        new acp.RequestError(-32602, 'Invalid params: model not found: big-model', {
          providerId: 'acme',
          modelId: 'big-model',
        }),
      )?.failure,
    ).toBe('no_model')
  })

  test('claude-agent-acp’s ended session reads in its own words', () => {
    expect(
      agentFailure(
        new acp.RequestError(
          -32603,
          'Internal error: The Claude Agent session has ended. Please start a new session.',
        ),
      ),
    ).toEqual({ failure: 'agent_quit', message: null })
  })

  test('anything else is null, and keeps the agent’s own words', () => {
    expect(plain('Tool execution failed: no such file src/App.tsx')).toBeNull()
    expect(plain('Port 5173 is in use')).toBeNull()
    // The fixed texts match whole: the same words inside a reply aren't the agent's.
    expect(plain('I found that No models are available in your config')).toBeNull()
    expect(
      agentFailure(new acp.RequestError(-32603, 'Internal error', { errorName: 'unknown' })),
    ).toBeNull()
    expect(agentFailure(null)).toBeNull()
  })
})

describe('mcpServersFor', () => {
  const http: acp.McpServer = {
    type: 'http',
    name: 'gui',
    url: 'http://127.0.0.1:1/mcp',
    headers: [{ name: 'Authorization', value: 'Bearer t' }],
  }
  const stdio: acp.McpServer = { name: 'local', command: 'tool', args: [], env: [] }

  test('HTTP servers go to an agent that advertises them', () => {
    // As `muse acp` 1.4.23 advertises { http: true, sse: false }.
    expect(mcpServersFor({ mcpCapabilities: { http: true } }, [http, stdio])).toEqual([http, stdio])
  })

  test('none to an agent that turns HTTP off or says nothing', () => {
    // pi-acp 0.0.34 advertises { http: false, sse: false }.
    expect(mcpServersFor({ mcpCapabilities: { http: false, sse: false } }, [http])).toEqual([])
    expect(mcpServersFor(undefined, [http, stdio])).toEqual([stdio])
  })
})
