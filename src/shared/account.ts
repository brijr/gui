export interface AccountProfile {
  email: string | null
  name: string | null
  updates: boolean
}

/**
 * Whether Gui has an account service (`configured`), needs an account before it opens
 * projects (`required`), and has a saved session (`signedIn`). Read without the network or
 * the Keychain, so the start screen knows at once.
 */
export interface AccountState {
  configured: boolean
  required: boolean
  signedIn: boolean
}

/** Session failures and provider reconnection belong to separate authentication domains. */
export type AccountErrorCode = 'account_session_invalid' | 'github_reconnect_required'

/** Older services have ambiguous provider 401s; only account routes can invalidate a session. */
export function invalidatesAccountSession(status: number, code: unknown, path: string) {
  return (
    status === 401 &&
    !path.startsWith('/auth/') &&
    (code === 'account_session_invalid' ||
      (code === undefined && (path === '/account' || path.startsWith('/account/'))))
  )
}
