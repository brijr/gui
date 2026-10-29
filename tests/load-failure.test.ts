import { describe, expect, test } from 'bun:test'
import { crashFailure, loadFailure } from '../src/main/load-failure'

describe('preview load failures', () => {
  test('say what happened in plain words and keep the code for Details', () => {
    const failure = loadFailure('ERR_CONNECTION_REFUSED', 'http://localhost:5173/')
    expect(failure.message).toBe(
      'Nothing is answering at localhost:5173. Your app may have stopped or moved.',
    )
    expect(failure.detail).toBe('ERR_CONNECTION_REFUSED — http://localhost:5173/')
  })

  test('an unknown code still reads plainly', () => {
    expect(loadFailure('ERR_SOMETHING_NEW', 'https://example.com/a').message).toBe(
      "Couldn't load example.com.",
    )
  })

  test('a crash names memory only when that was the reason', () => {
    expect(crashFailure('oom').message).toContain('ran out of memory')
    expect(crashFailure('crashed').message).toBe('The preview stopped unexpectedly.')
    expect(crashFailure('crashed').detail).toContain('crashed')
  })
})
