import { describe, expect, test } from 'bun:test'
import type { PermissionControls } from '../src/main/agents'
import {
  type OfferedControls,
  ownPermissions,
  permissionChanges,
} from '../src/main/permission-modes'
import type { AgentSetting } from '../src/shared/types'

const setting = (id: string, value: string, values: string[]): AgentSetting => ({
  id,
  value,
  options: values.map((v) => ({ value: v, name: v, group: null })),
})

/** A session offering a `mode` config option and, optionally, other options. */
const withModeOption = (value: string, values: string[], others: AgentSetting[] = []) =>
  ({
    modeOption: setting('mode', value, values),
    modes: null,
    option: (id) => others.find((other) => other.id === id) ?? null,
  }) satisfies OfferedControls

/** A session offering ACP session modes only. */
const withModes = (current: string, offered: string[]): OfferedControls => ({
  modeOption: null,
  modes: { current, offered },
  option: () => null,
})

const nothing: OfferedControls = { modeOption: null, modes: null, option: () => null }

// As declared in src/main/agents.ts, and as each agent advertised it on session/new.
const claude: PermissionControls = { mode: { ask: ['default'], auto: ['auto', 'acceptEdits'] } }
const codex: PermissionControls = { mode: { ask: ['read-only'], auto: ['agent'] } }
const grok: PermissionControls = {
  sessionMeta: { ask: { yoloMode: false, autoMode: false }, auto: { autoMode: true } },
}
const muse: PermissionControls = {
  mode: { ask: ['default'], auto: ['bypassApprovals'] },
  options: { nativeApprovalPolicy: { ask: ['promptUnmatched', 'onRequest'], auto: ['onRequest'] } },
}
const gemini: PermissionControls = { mode: { ask: ['default'], auto: ['default'] } }
const GEMINI_MODES = ['default', 'autoEdit', 'yolo', 'plan']
const CLAUDE_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']

describe('ownPermissions: does the agent decide what it asks, rather than Gui?', () => {
  const decides = (permissions: PermissionControls | undefined, offered: OfferedControls | null) =>
    ownPermissions({ permissions }, offered)

  test('no when the session offers the mode Ask wants', () => {
    expect(decides(claude, withModeOption('default', CLAUDE_MODES))).toBe(false)
    expect(decides(codex, withModes('agent', ['read-only', 'workspace-write', 'agent']))).toBe(
      false,
    )
  })

  test('no for an agent that takes Ask as the session starts (Grok)', () => {
    expect(decides(grok, nothing)).toBe(false)
  })

  test('no when only another option offers an ask-first value', () => {
    const policy = setting('nativeApprovalPolicy', 'onRequest', ['onRequest', 'allowAll'])
    expect(decides(muse, withModeOption('plan', ['plan'], [policy]))).toBe(false)
  })

  test('yes when the mode Ask wants is renamed or missing', () => {
    expect(decides(claude, withModeOption('manual', ['manual', 'auto']))).toBe(true)
    expect(decides(codex, nothing)).toBe(true)
  })

  test('before a session starts, the definition decides', () => {
    expect(decides(claude, null)).toBe(false)
    expect(ownPermissions({ ownPermissions: true }, null)).toBe(true)
  })

  test('yes for an agent declared to have no ask-first mode, whatever it offers', () => {
    // fx (it does offer `ask`, but choosing it saves it for every fx session), OpenCode, Pi.
    const declared = { ownPermissions: true } as const
    expect(ownPermissions(declared, withModeOption('auto', ['auto', 'ask', 'full-access']))).toBe(
      true,
    )
    expect(ownPermissions(declared, withModeOption('build', ['build', 'plan']))).toBe(true)
    expect(ownPermissions(declared, withModes('high', ['low', 'high', 'max']))).toBe(true)
  })

  test('no for an agent Gui knows nothing about: its answers to what it asks are all there is', () => {
    expect(decides(undefined, nothing)).toBe(false)
    expect(decides(undefined, withModes('agent', ['agent', 'plan', 'ask']))).toBe(false)
  })
})

describe('permissionChanges', () => {
  test('switches to the first wanted mode the session offers', () => {
    expect(permissionChanges(claude, 'auto', withModeOption('default', CLAUDE_MODES))).toEqual({
      changes: [{ kind: 'option', configId: 'mode', value: 'auto' }],
      missing: [],
    })
    // Models without Auto fall back to Accept edits.
    const noAuto = CLAUDE_MODES.filter((mode) => mode !== 'auto')
    expect(permissionChanges(claude, 'auto', withModeOption('default', noAuto)).changes).toEqual([
      { kind: 'option', configId: 'mode', value: 'acceptEdits' },
    ])
  })

  test('uses session/set_mode when there is no mode option', () => {
    expect(permissionChanges(codex, 'ask', withModes('agent', ['read-only', 'agent']))).toEqual({
      changes: [{ kind: 'mode', modeId: 'read-only' }],
      missing: [],
    })
  })

  test('changes nothing when the mode is already set', () => {
    expect(permissionChanges(claude, 'ask', withModeOption('default', CLAUDE_MODES))).toEqual({
      changes: [],
      missing: [],
    })
  })

  test('reports a wanted mode the session does not offer', () => {
    const result = permissionChanges(claude, 'auto', withModeOption('default', ['default', 'plan']))
    expect(result.changes).toEqual([])
    expect(result.missing).toEqual(['No auto or acceptEdits mode offered.'])
    expect(permissionChanges(codex, 'ask', nothing).missing).toEqual(['No read-only mode offered.'])
  })

  test('Gemini goes back to Default, which asks first, from whatever its own settings picked', () => {
    for (const policy of ['ask', 'auto'] as const) {
      expect(permissionChanges(gemini, policy, withModes('yolo', GEMINI_MODES))).toEqual({
        changes: [{ kind: 'mode', modeId: 'default' }],
        missing: [],
      })
      expect(permissionChanges(gemini, policy, withModes('default', GEMINI_MODES)).changes).toEqual(
        [],
      )
    }
    expect(ownPermissions({ permissions: gemini }, withModes('autoEdit', GEMINI_MODES))).toBe(false)
  })

  test('skips an option the session lacks, but sets one it has', () => {
    const modes = ['default', 'bypassApprovals']
    expect(permissionChanges(muse, 'auto', withModeOption('default', modes))).toEqual({
      changes: [{ kind: 'option', configId: 'mode', value: 'bypassApprovals' }],
      missing: [],
    })
    const policy = setting('nativeApprovalPolicy', 'onRequest', ['onRequest', 'promptUnmatched'])
    expect(permissionChanges(muse, 'ask', withModeOption('default', modes, [policy]))).toEqual({
      changes: [{ kind: 'option', configId: 'nativeApprovalPolicy', value: 'promptUnmatched' }],
      missing: [],
    })
  })
})
