import { describe, expect, test } from 'bun:test'
import * as acp from '@agentclientprotocol/sdk'

import { displayedModes, errorDetail, resumeMethods } from '../src/main/agent-protocol'

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
