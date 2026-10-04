import { useState } from 'react'

/** Electron prefixes rejected invoke() messages; users only need the part main wrote. */
const IPC_PREFIX = /^(?:Error: )?Error invoking remote method '[^']*': (?:Error: )?/

export function errorMessage(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(IPC_PREFIX, '')
}

type ActionState = { kind: 'idle' } | { kind: 'pending' } | { kind: 'error'; message: string }

/** Tracks one async IPC call so its button can show progress and its row can show a failure. */
export function useAction() {
  const [state, setState] = useState<ActionState>({ kind: 'idle' })

  const run = async (action: () => Promise<unknown>) => {
    setState({ kind: 'pending' })
    try {
      await action()
      setState({ kind: 'idle' })
    } catch (err) {
      setState({ kind: 'error', message: errorMessage(err) })
    }
  }

  return {
    pending: state.kind === 'pending',
    error: state.kind === 'error' ? state.message : null,
    run,
  }
}
