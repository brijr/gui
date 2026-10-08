import { useEffect, useState } from 'react'
import type { AccountState } from '../../../shared/account'
import { gui } from './api'

/** Whether Gui needs an account and has one; null until main answers. Follows sign-in and out. */
export function useAccount() {
  const [state, setState] = useState<AccountState | null>(null)
  useEffect(() => {
    let live = true
    const off = gui.onAccount(setState)
    void gui
      .getAccount()
      .then((value) => {
        if (live) setState(value)
      })
      .catch(() => undefined)
    return () => {
      live = false
      off()
    }
  }, [])
  return state
}

/** The start screen asks for an account before anything else. */
export const needsSignIn = (state: AccountState) => state.required && !state.signedIn
