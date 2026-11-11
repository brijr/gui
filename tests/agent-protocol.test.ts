import { describe, expect, test } from 'bun:test'
import * as acp from '@agentclientprotocol/sdk'

import {
  displayedModes,
  errorDetail,
  formQuestions,
  GEMINI_MODE_NOTICE,
  modeNoticeUpdate,
  plainAgentError,
  resumeMethods,
} from '../src/main/agent-protocol'

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

describe('modeNoticeUpdate', () => {
  const said = (text: string): acp.SessionNotification['update'] => ({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text },
  })

  test('Gemini’s mode message stands for the mode change it reports', () => {
    // As Gemini CLI sends it when entering Plan, or when Gui sets Default.
    expect(modeNoticeUpdate(said('[MODE_UPDATE] plan'), GEMINI_MODE_NOTICE)).toEqual({
      sessionUpdate: 'current_mode_update',
      currentModeId: 'plan',
    })
    expect(modeNoticeUpdate(said('[MODE_UPDATE] default\n'), GEMINI_MODE_NOTICE)).toEqual({
      sessionUpdate: 'current_mode_update',
      currentModeId: 'default',
    })
  })

  test('the reply itself, and agents that say no such thing, are left alone', () => {
    expect(modeNoticeUpdate(said('Switched. [MODE_UPDATE] plan'), GEMINI_MODE_NOTICE)).toBeNull()
    expect(modeNoticeUpdate(said('[MODE_UPDATE]'), GEMINI_MODE_NOTICE)).toBeNull()
    expect(modeNoticeUpdate(said('[MODE_UPDATE] plan'), undefined)).toBeNull()
    const thought: acp.SessionNotification['update'] = {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: '[MODE_UPDATE] plan' },
    }
    expect(modeNoticeUpdate(thought, GEMINI_MODE_NOTICE)).toBeNull()
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
        title: 'Which branch should the pull request target?',
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

describe('plainAgentError', () => {
  test('known failures read in plain words', () => {
    const cases: [string, RegExp][] = [
      [
        'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_1"}',
        /servers are busy/,
      ],
      ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}', /too many requests/],
      ['429 You exceeded your current quota (insufficient_quota)', /out of credit/],
      ['Your credit balance is too low to access the Anthropic API.', /out of credit/],
      ['API Error: 500 {"type":"error","error":{"type":"api_error"}}', /servers had a problem/],
      ['503 Service Unavailable', /servers had a problem/],
      ['request to https://api.example.com failed, reason: getaddrinfo ENOTFOUND', /internet/],
      ['The request timed out', /internet/],
      ['prompt is too long: 210000 tokens > 200000 maximum', /too long/],
    ]
    for (const [raw, plain] of cases) expect(plainAgentError(raw)).toMatch(plain)
  })

  test('anything else keeps the agent\u2019s own words', () => {
    expect(plainAgentError('Tool execution failed: no such file src/App.tsx')).toBeNull()
    expect(plainAgentError('Port 5173 is in use')).toBeNull()
  })
})
