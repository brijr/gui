import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchTerminal, type TerminalApp } from '../src/main/terminal-launch'

const bin = mkdtempSync(join(tmpdir(), 'gui-terminals-'))
const log = join(bin, 'opened.log')
afterAll(() => rmSync(bin, { recursive: true, force: true }))

function fake(name: string, body: string) {
  const path = join(bin, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}
fake('broken-terminal', '#!/nonexistent/interpreter\n')
fake('quitting-terminal', '#!/bin/sh\nexit 3\n')
fake('working-terminal', `#!/bin/sh\nprintf '%s' "$*" > '${log}'\n`)

const app = (command: string): TerminalApp => ({ command, args: (file) => ['-e', file] })
const env = { PATH: bin }

// The Linux terminal apps (x-terminal-emulator, gnome-terminal…); sign-in in a terminal
// window on Windows is a later step.
describe.skipIf(process.platform === 'win32')('opening a terminal for sign-in', () => {
  test('a terminal that fails to start or quits at once is skipped for the next one', async () => {
    const opened = await launchTerminal('/tmp/sign-in.sh', env, [
      app('missing-terminal'),
      app('broken-terminal'),
      app('quitting-terminal'),
      app('working-terminal'),
    ])
    expect(opened).toBe('working-terminal')
    expect(readFileSync(log, 'utf8')).toBe('-e /tmp/sign-in.sh')
  })

  test('when every terminal fails, it says which ones did', async () => {
    const attempt = launchTerminal('/tmp/sign-in.sh', env, [
      app('broken-terminal'),
      app('quitting-terminal'),
    ])
    await expect(attempt).rejects.toThrow(
      "Couldn't open a terminal: broken-terminal, quitting-terminal failed to start.",
    )
  })

  test('without any terminal app, it says none was found', async () => {
    await expect(launchTerminal('/tmp/sign-in.sh', env, [app('missing-terminal')])).rejects.toThrow(
      "Couldn't find a terminal app.",
    )
  })
})
