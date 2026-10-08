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
