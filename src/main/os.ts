import { join } from 'node:path'
import type { BrowserWindowConstructorOptions } from 'electron'
import { TRAFFIC_LIGHTS } from '../shared/layout'
import { IS_MAC, IS_WINDOWS } from '../shared/platform'
import { findExecutable } from './executables'
import { comSpec } from './windows-cmd'

export const DEFAULT_SHELL = IS_MAC ? '/bin/zsh' : '/bin/bash'

const systemRoot = () => process.env.SystemRoot ?? 'C:\\Windows'

/** bsdtar: macOS's and Windows 10's (System32\tar.exe, which also unpacks .zip). */
export const tarPath = () => (IS_WINDOWS ? `${systemRoot()}\\System32\\tar.exe` : '/usr/bin/tar')

/** A program and its arguments for spawnPty. Windows takes a command line as one string. */
export interface ShellLaunch {
  file: string
  args: string[] | string
}

/**
 * The shell for a terminal in the drawer: the user's login shell on a Mac and Linux. On
 * Windows, PowerShell 7 when it's installed, else the Windows PowerShell every Windows has.
 * $SHELL is not used there: Git Bash sets it to a path only its own programs understand.
 */
export async function terminalShell(env: NodeJS.ProcessEnv): Promise<ShellLaunch> {
  if (!IS_WINDOWS) return { file: env.SHELL || DEFAULT_SHELL, args: ['-l'] }
  const pwsh = await findExecutable('pwsh.exe', env.PATH)
  const file = pwsh ?? join(systemRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return { file, args: ['-NoLogo'] }
}

/**
 * The shell that runs a project's command (its dev server, an install): the user's login
 * shell on a Mac and Linux. On Windows cmd.exe, which is what npm runs scripts with, and
 * what `npm run dev` and the like expect. The command is the user's own, shell syntax and
 * all, so it is passed on as written; `/s` keeps cmd.exe from changing its quotes.
 */
export function commandShell(env: NodeJS.ProcessEnv, command: string): ShellLaunch {
  if (!IS_WINDOWS) return { file: env.SHELL || DEFAULT_SHELL, args: ['-lc', command] }
  return { file: comSpec(env), args: `/d /s /c "${command}"` }
}

export function windowChrome(): BrowserWindowConstructorOptions {
  return IS_MAC
    ? { titleBarStyle: 'hiddenInset', trafficLightPosition: TRAFFIC_LIGHTS }
    : { autoHideMenuBar: true }
}
