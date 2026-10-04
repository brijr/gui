import type { WindowState } from '../../../shared/types'
import type { Status } from '../lib/status'

/** The dev server quit on its own with an error, or never started; a clean exit isn't a crash. */
export function crashed({ devServer }: WindowState) {
  return devServer.status === 'exited' && devServer.exitCode !== 0
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
    return { status: 'error', label: "Couldn't install dependencies" }
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
