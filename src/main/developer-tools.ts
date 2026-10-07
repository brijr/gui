import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { findExecutable } from './agents'
import { getShellEnv } from './shell-env'

/** What the user sees when Gui needs git and this Mac can't run it yet. */
export const GIT_TOOLS_MISSING =
  'Git needs Apple’s developer tools, which aren’t installed on this Mac yet. Install them from the banner above the preview, then try again.'

/**
 * Whether git can run here. On a Mac without Apple's developer tools, `/usr/bin/git` is a
 * stand-in that pops up macOS's offer to install them, out of nowhere, the first time
 * anything runs it. Gui asks first (`xcode-select -p`) and offers the install itself when
 * the user can see why (`install`). A git from elsewhere (Homebrew) needs none of this.
 * 'installing' lasts until the user comes back to Gui with it done.
 */
class DeveloperTools extends EventEmitter<{ change: [status: DeveloperToolsStatus] }> {
  private status: DeveloperToolsStatus = 'unknown'
  private checking: Promise<boolean> | null = null

  constructor() {
    super()
    // Every tab listens.
    this.setMaxListeners(0)
  }

  get state() {
    return this.status
  }

  /** Whether git runs; checked once, then again only after `recheck`. */
  gitAvailable(): Promise<boolean> {
    if (this.status === 'ok') return Promise.resolve(true)
    if (this.status === 'missing' || this.status === 'installing') return Promise.resolve(false)
    this.checking ??= this.check().finally(() => {
      this.checking = null
    })
    return this.checking
  }

  /** Throws a message fit for the user when git can't run yet. */
  async requireGit() {
    if (!(await this.gitAvailable())) throw new Error(GIT_TOOLS_MISSING)
  }

  /** Opens macOS's installer for the developer tools; Gui checks again on its own after. */
  install() {
    if (this.status !== 'missing' && this.status !== 'installing') return
    execFile('/usr/bin/xcode-select', ['--install'], () => undefined)
    this.set('installing')
  }

  /** The user came back to Gui: if git wasn't there, see whether it is now. */
  async recheck() {
    if (this.status === 'missing' || this.status === 'installing') await this.check()
  }

  private async check() {
    const env = await getShellEnv()
    const git = await findExecutable('git', env.PATH)
    const ok = git !== null && (git !== '/usr/bin/git' || (await this.hasAppleTools()))
    if (ok) this.set('ok')
    else if (this.status !== 'installing') this.set('missing')
    return ok
  }

  /** The active developer folder (Command Line Tools or Xcode), with its git in it. */
  private hasAppleTools() {
    return new Promise<boolean>((resolve) => {
      execFile('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' }, (error, stdout) => {
        const dir = stdout.trim()
        resolve(!error && dir !== '' && existsSync(join(dir, 'usr', 'bin', 'git')))
      })
    })
  }

  private set(status: DeveloperToolsStatus) {
    if (status === this.status) return
    this.status = status
    this.emit('change', status)
  }
}

export type DeveloperToolsStatus = 'unknown' | 'ok' | 'missing' | 'installing'

export const developerTools = new DeveloperTools()
