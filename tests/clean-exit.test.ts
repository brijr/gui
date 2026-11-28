import { describe, expect, test } from 'bun:test'
import { startupFailure } from '../src/main/startup'
import { crashed, serverStatus } from '../src/renderer/src/app/server-status'
import type { DevServerState, ProjectInfo, WindowState } from '../src/shared/types'

const server = (patch: Partial<DevServerState>): DevServerState => ({
  status: 'exited',
  command: 'npm run dev',
  url: null,
  exitCode: 0,
  lastLine: '',
  errorLine: '',
  slow: false,
  cameUp: false,
  ...patch,
})
const windowWith = (devServer: DevServerState) => ({ devServer, setup: null }) as WindowState

describe('an exit before the app came up is a failed start', () => {
  test('exit 0 before the app came up: a crash, with its help', () => {
    const state = windowWith(server({ exitCode: 0, cameUp: false }))
    expect(crashed(state)).toBe(true)
    expect(serverStatus(state).label).toBe('Stopped with an error')
  })

  test('exit 0 once the app was up: stopped on its own, as before', () => {
    const state = windowWith(server({ exitCode: 0, cameUp: true }))
    expect(crashed(state)).toBe(false)
    expect(serverStatus(state).label).toBe('Stopped')
  })

  test('an error exit is a crash either way; stopped from outside never is', () => {
    expect(crashed(windowWith(server({ exitCode: 1, cameUp: true })))).toBe(true)
    expect(crashed(windowWith(server({ exitCode: null })))).toBe(true)
    expect(crashed(windowWith(server({ exitCode: 143, cameUp: false })))).toBe(false)
    expect(crashed(windowWith(server({ exitCode: 130, cameUp: true })))).toBe(false)
  })

  test('not exited is not a crash', () => {
    expect(crashed(windowWith(server({ status: 'starting', exitCode: null })))).toBe(false)
    expect(crashed(windowWith(server({ status: 'running', exitCode: null, cameUp: true })))).toBe(
      false,
    )
  })

  test('the agent hears which it was', () => {
    const project = { root: '/p', devCommand: 'npm run dev' } as ProjectInfo
    const failure = (devServer: DevServerState) =>
      startupFailure({ project, setup: null, devServer, preview: { url: null, error: null } })
    expect(failure(server({ cameUp: false }))).toContain('before the app came up')
    expect(failure(server({ cameUp: true }))).toContain('stopped on its own, without an error')
    expect(failure(server({ exitCode: 1 }))).toContain('quit with an error (exit code 1)')
  })
})
