import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, shell } from 'electron'

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

/**
 * Opens a Terminal window that runs `command` in the user's login shell, under a short
 * explanation. Only ever called with commands from Grat's own agent catalog.
 */
export async function runInTerminal(command: string, intro: string) {
  const dir = join(app.getPath('userData'), 'terminal')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, 'sign-in.command')
  const done = 'echo; echo "All done. You can close this window and go back to Grat."'
  const script = [
    '#!/bin/sh',
    'clear',
    `printf '%s\\n\\n' ${quote(intro)}`,
    `exec "\${SHELL:-/bin/zsh}" -lic ${quote(`${command}; ${done}`)}`,
    '',
  ].join('\n')
  await writeFile(file, script, { mode: 0o700 })
  const error = await shell.openPath(file)
  if (error) throw new Error(`Couldn't open Terminal: ${error}`)
}
