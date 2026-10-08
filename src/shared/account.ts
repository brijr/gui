/** Ways to sign in through the browser. Email is the fourth, through a link or code. */
export type SignInProvider = 'google' | 'apple' | 'github'
export type IdentityProvider = SignInProvider | 'email'

export const SIGN_IN_PROVIDERS: readonly SignInProvider[] = ['google', 'apple', 'github']

export const isSignInProvider = (value: unknown): value is SignInProvider =>
  SIGN_IN_PROVIDERS.includes(value as SignInProvider)

export interface AccountProfile {
  email: string | null
  name: string | null
  updates: boolean
  /** The ways this account signs in */
  providers: IdentityProvider[]
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
