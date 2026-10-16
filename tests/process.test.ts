import { describe, expect, test } from 'bun:test'
import { childEnv, isInheritedAgentMarker, scrubInheritedEnv } from '../src/main/process'

describe('child process env', () => {
  test('inherited agent session vars are stripped before a login shell', () => {
    expect(isInheritedAgentMarker('CLAUDECODE')).toBe(true)
    expect(isInheritedAgentMarker('CODEX_THREAD_ID')).toBe(true)
    expect(isInheritedAgentMarker('CODEX_HOME')).toBe(true)
    expect(isInheritedAgentMarker('PATH')).toBe(false)
    const env = scrubInheritedEnv({
      PATH: '/usr/bin',
      CLAUDECODE: '1',
      CODEX_THREAD_ID: 't',
      CLAUDE_CODE_USE_BEDROCK: '1',
    })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CODEX_THREAD_ID).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
  })

  test('spawn env drops session markers and Electron flags, keeps profile agent settings', () => {
    const env = childEnv(
      {
        PATH: '/usr/bin',
        CLAUDECODE: '1',
        CLAUDE_CODE_USE_BEDROCK: '1',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--inspect',
      },
      { CODEX_PATH: '/opt/codex' },
      { browser: 'none' },
    )
    expect(env.PATH).toBe('/usr/bin')
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
    expect(env.CODEX_PATH).toBe('/opt/codex')
    expect(env.BROWSER).toBe('none')
  })

  test('sign-in spawn does not block the browser', () => {
    const env = childEnv({ PATH: '/usr/bin' }, {}, { browser: false })
    expect(env.BROWSER).toBeUndefined()
  })
})
