import type { WindowState } from '../../../shared/types'
import type { Status } from '../lib/status'

/**
 * Interrupted or terminated (SIGINT, SIGTERM: 128 + the signal, as shells and package managers
 * report it): something outside Gui stopped the app (Ctrl-C in another terminal, `kill`).
 */
const STOPPED_OUTSIDE = [130, 143]

/** The dev server was stopped from outside Gui: not a crash, but the preview won't update. */
export function stoppedOutside({ devServer }: WindowState) {
  return devServer.status === 'exited' && STOPPED_OUTSIDE.includes(devServer.exitCode ?? -1)
}

/**
 * The dev server quit on its own with an error, or before the app ever came up in this run
 * (a failed start, whatever its exit code), or never started. A clean exit once the app was
 * up isn't a crash, and nor is being stopped from outside.
 */
export function crashed(state: WindowState) {
  const { devServer } = state
  if (devServer.status !== 'exited' || stoppedOutside(state)) return false
  return devServer.exitCode !== 0 || !devServer.cameUp
}

/**
 * Where the project's app is, as the address bar's status shows it: its dot, and the words
 * for it (the status's name, and the field's placeholder until there's an address). The
 * install runs before the dev server, in the same terminal, so it's reported here too.
 */
export function serverStatus(state: WindowState): { status: Status; label: string } {
  const { setup, devServer } = state
  if (setup?.dependencies === 'installing') {
    return { status: 'busy', label: 'Installing dependencies…' }
  }
  if (setup?.dependencies === 'failed') {
    return { status: 'error', label: 'Couldn’t install dependencies' }
  }
  switch (devServer.status) {
    case 'running':
      return { status: 'ready', label: 'Running' }
    case 'starting':
      return { status: 'busy', label: 'Starting…' }
    case 'exited':
      return crashed(state)
        ? { status: 'error', label: 'Stopped with an error' }
        : { status: 'idle', label: 'Stopped' }
    case 'idle':
      return { status: 'idle', label: 'Not running' }
  }
}
