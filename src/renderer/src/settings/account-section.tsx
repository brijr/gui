import { useEffect, useState } from 'react'
import type { AccountProfile } from '../../../shared/account'
import type { SettingsState } from '../../../shared/types'
import { gui } from '../lib/api'
import { readableError } from '../lib/errors'
import { InlineError } from '../lib/field'
import { CircleUser } from '../lib/icons'
import { List, ListItem } from '../lib/surface'
import { Button, Spinner, Switch } from '../lib/ui'
import { useAccount } from '../lib/use-account'
import { IdentityCard, IdentityTile, SettingsGroup } from './settings-group'

/** Said when the user closes the browser sign-in themselves: not an error. */
const SIGN_IN_CANCELLED = 'Sign-in was cancelled.'

/** Settings → Account: the Gui account, and the crash reports Gui sends (signed in or not). */
export function AccountSection({ settings }: { settings: SettingsState }) {
  return (
    <>
      <AccountDetails />
      <SettingsGroup heading="Cost and policies">
        <p className="text-pretty text-small text-muted">
          Gui is free during alpha. Connect your own AI agent account and plan; you pay the agent
          provider directly. Gui adds no AI usage charges.
        </p>
        <p className="flex gap-4 text-small">
          <a
            className="relative rounded-sm text-accent-text underline-offset-2 before:absolute before:-inset-1 hover:underline active:opacity-70 active:transition-none transition-opacity"
            href="https://usegui.com/terms"
            target="_blank"
            rel="noreferrer"
          >
            Terms
          </a>
          <a
            className="relative rounded-sm text-accent-text underline-offset-2 before:absolute before:-inset-1 hover:underline active:opacity-70 active:transition-none transition-opacity"
            href="https://usegui.com/privacy"
            target="_blank"
            rel="noreferrer"
          >
            Privacy policy
          </a>
        </p>
      </SettingsGroup>
      <CrashReports on={settings.crashReports} />
    </>
  )
}

function CrashReports({ on }: { on: boolean }) {
  return (
    <SettingsGroup heading="Privacy">
      <List>
        <ListItem
          heading={<label htmlFor="crash-reports">Send crash reports</label>}
          detail="When Gui has an error, it sends the error and the Gui and macOS versions to the Gui team. Never your code, files, or chats."
          trailing={
            <Switch
              checked={on}
              onCheckedChange={(value) => gui.setCrashReports(value)}
              id="crash-reports"
              label="Send crash reports"
            />
          }
        />
      </List>
    </SettingsGroup>
  )
}

type Profile =
  | { kind: 'loading' }
  /** `signedIn`: the sign-in state it was loaded for; another one's result isn't this one's */
  | { kind: 'loaded'; profile: AccountProfile | null; signedIn: boolean }
  | { kind: 'failed'; message: string }

/**
 * Who's signed in, the product-update emails, and signing out, after which the start screen
 * asks to sign in again. Signed out, it signs in from here too.
 */
function AccountDetails() {
  const state = useAccount()
  const [profile, setProfile] = useState<Profile>({ kind: 'loading' })
  // Bumped by Try again, to load the profile once more.
  const [attempt, setAttempt] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)

  const signedIn = state?.signedIn ?? false
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is how Try again reloads
  useEffect(() => {
    if (!signedIn) {
      setProfile({ kind: 'loaded', profile: null, signedIn: false })
      return
    }
    let live = true
    setProfile({ kind: 'loading' })
    gui
      .getAccountProfile()
      .then((value) => live && setProfile({ kind: 'loaded', profile: value, signedIn: true }))
      .catch((err: unknown) => live && setProfile({ kind: 'failed', message: readableError(err) }))
    return () => {
      live = false
    }
  }, [signedIn, attempt])

  // Until the profile is the one for this sign-in state: just signed in, the signed-out result
  // from a moment ago would otherwise say the sign-in expired.
  const stale = profile.kind === 'loaded' && profile.signedIn !== signedIn
  if (!state || profile.kind === 'loading' || stale)
    return (
      // The signed-in card's shape, so what's below doesn't move much when it loads.
      <div role="status">
        <IdentityCard
          leading={
            <IdentityTile>
              <Spinner />
            </IdentityTile>
          }
          heading="Checking your Gui account…"
        />
      </div>
    )

  if (!state.configured)
    return <p className="text-pretty text-muted">Gui accounts aren’t available in this build.</p>

  // Signed in, but the account didn't load (offline, the service down): not signed out.
  if (profile.kind === 'failed')
    return (
      <IdentityCard
        leading={
          <IdentityTile>
            <CircleUser className="size-4" aria-hidden="true" />
          </IdentityTile>
        }
        heading="Your account didn’t load"
        detail="You’re still signed in. Check your connection, then try again."
      >
        <InlineError>{profile.message}</InlineError>
        <Button className="self-start" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </IdentityCard>
    )

  if (!profile.profile)
    return (
      <SignedOut
        // A saved session the account service no longer accepts.
        expired={signedIn}
      />
    )

  const account = profile.profile

  const setUpdates = (updates: boolean) => {
    const previous = account
    setProfile({ kind: 'loaded', profile: { ...account, updates }, signedIn: true })
    setSaving(true)
    setSaveError(null)
    gui
      .setAccountUpdates(updates)
      .catch((err: unknown) => {
        // Only while still signed in: signing out meanwhile already cleared it.
        setProfile((now) =>
          now.kind === 'loaded' && now.signedIn ? { ...now, profile: previous } : now,
        )
        setSaveError(readableError(err))
      })
      .finally(() => setSaving(false))
  }

  const signOut = () => {
    setSigningOut(true)
    setSignOutError(null)
    gui
      .signOutAccount()
      .catch((err: unknown) => setSignOutError(readableError(err)))
      .finally(() => setSigningOut(false))
  }

  return (
    <>
      <IdentityCard
        leading={
          <IdentityTile>
            <CircleUser className="size-4" aria-hidden="true" />
          </IdentityTile>
        }
        heading={account.name ?? account.email ?? 'Gui account'}
        detail={account.name && account.email ? account.email : undefined}
        trailing={
          <Button variant="ghost" loading={signingOut} onClick={signOut}>
            Sign out
          </Button>
        }
      >
        {signOutError && <InlineError>{signOutError}</InlineError>}
      </IdentityCard>
      <SettingsGroup heading="Email">
        <List>
          {/* Applies at once, so a switch, like every other setting */}
          <ListItem
            heading={<label htmlFor="email-updates">Email me about new Gui features</label>}
            detail={account.email ? undefined : 'Your account has no email.'}
            trailing={
              <Switch
                checked={account.updates}
                disabled={saving || signingOut || !account.email}
                onCheckedChange={setUpdates}
                id="email-updates"
                label="Email me about new Gui features"
              />
            }
          />
        </List>
        {saveError && <InlineError>{saveError}</InlineError>}
      </SettingsGroup>
    </>
  )
}

/** Signed out: sign in here, in the browser, as the start screen does. */
function SignedOut({ expired }: { expired: boolean }) {
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Once it's done, main tells every window, and this section shows the account.
  const signIn = () => {
    setError(null)
    setWaiting(true)
    gui.accountSignIn().catch((err: unknown) => {
      const message = readableError(err)
      if (message !== SIGN_IN_CANCELLED) setError(message)
      setWaiting(false)
    })
  }

  const cancel = () => {
    setError(null)
    setWaiting(false)
    void gui.cancelAccountSignIn().catch(() => undefined)
  }

  return (
    <IdentityCard
      leading={
        <IdentityTile>
          <CircleUser className="size-4" aria-hidden="true" />
        </IdentityTile>
      }
      heading={expired ? 'Sign in again' : 'You’re signed out'}
      detail={
        expired ? 'Your Gui sign-in has expired.' : 'Sign in with Google, GitHub, or your email.'
      }
      trailing={
        !waiting && (
          <Button variant="primary" onClick={signIn}>
            Sign in
          </Button>
        )
      }
    >
      {waiting && (
        <>
          <p role="status" className="flex items-center gap-2 text-small text-muted">
            <Spinner />
            Finish signing in with your browser…
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={signIn}>Open browser again</Button>
            <Button variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </>
      )}
      {error && <InlineError>{error}</InlineError>}
    </IdentityCard>
  )
}
