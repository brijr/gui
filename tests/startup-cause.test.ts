import { describe, expect, test } from 'bun:test'
import { isRunnerLine, looksLikeError } from '../src/main/startup'

// "Your app stopped" says why in the output's own words: the first line that reads like the
// cause, never the package manager's line about the script it ran.
describe('the line a failed start shows', () => {
  const first = (lines: string[]) => lines.find(looksLikeError) ?? null

  test('Node: the module error, not the loader frame or bun’s exit line', () => {
    expect(
      first([
        'node:internal/modules/cjs/loader:1228',
        '  throw err;',
        "Error: Cannot find module './config'",
        '    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)',
        'error: script "dev" exited with code 1',
      ]),
    ).toBe("Error: Cannot find module './config'")
  })

  test('npm and pnpm say the script failed; that is never the cause', () => {
    for (const line of [
      'error: script "dev" exited with code 1',
      'npm ERR! code ELIFECYCLE',
      'npm error command failed',
      'npm ERR! Failed at the app@1.0.0 dev script.',
      ' ELIFECYCLE  Command failed with exit code 1.',
      'error Command failed with exit code 1.',
      'at Object.<anonymous> (/app/server.js:3:1)',
    ]) {
      expect(isRunnerLine(line.trim()), line).toBe(true)
      expect(looksLikeError(line.trim()), line).toBe(false)
    }
  })

  test('a port in use and a missing command read as the cause', () => {
    expect(looksLikeError('Error: listen EADDRINUSE: address already in use :::3000')).toBe(true)
    expect(looksLikeError('sh: vite: command not found')).toBe(true)
    expect(looksLikeError('  VITE v6.0.0  ready in 300 ms')).toBe(false)
  })
})
