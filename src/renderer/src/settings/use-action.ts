import { useState } from 'react'
import { readableError } from '../lib/errors'

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
      setState({ kind: 'error', message: readableError(err) })
    }
  }

  return {
    pending: state.kind === 'pending',
    error: state.kind === 'error' ? state.message : null,
    run,
  }
}
