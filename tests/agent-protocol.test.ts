import { describe, expect, test } from 'bun:test'
import type * as acp from '@agentclientprotocol/sdk'

import { displayedModes } from '../src/main/agent-protocol'

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
