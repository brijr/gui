import { useEffect, useId, useState } from 'react'
import type { AccountProfile } from '../../../shared/account'
import { gui } from '../lib/api'
import { readableError } from '../lib/errors'
import { InlineError } from '../lib/field'
import { Card, GroupLabel, List, Message } from '../lib/surface'
import { Button, Checkbox, Spinner } from '../lib/ui'
import { useAccount } from '../lib/use-account'

/**
 * Settings → Account: who's signed in, the product-update emails (off until chosen),
 * and signing out, after which the start screen asks to sign in again.
 */
export function AccountSection() {
  const state = useAccount()
  const [profile, setProfile] = useState<AccountProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const emailHeading = useId()

  const signedIn = state?.signedIn ?? false
  useEffect(() => {
    if (!signedIn) {
      setProfile(null)
      setLoading(false)
      return
    }
    let live = true
    setLoading(true)
    gui
      .getAccountProfile()
      .then((value) => live && setProfile(value))
      .catch((err: unknown) => live && setError(readableError(err)))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [signedIn])

  const setUpdates = (updates: boolean) => {
    if (!profile) return
    const previous = profile
    setProfile({ ...profile, updates })
    setBusy(true)
    setError(null)
    gui
      .setAccountUpdates(updates)
      .catch((err: unknown) => {
        setProfile(previous)
        setError(readableError(err))
      })
      .finally(() => setBusy(false))
  }

  const signOut = () => {
    setBusy(true)
    setError(null)
    gui
      .signOutAccount()
      .catch((err: unknown) => setError(readableError(err)))
      .finally(() => setBusy(false))
  }

  if (!state || loading)
    return (
      <div role="status">
        <Message icon={<Spinner size="md" />}>Checking your Gui account…</Message>
      </div>
    )

  if (!state.configured)
    return <p className="text-pretty text-muted">Gui accounts aren’t available in this build.</p>

  if (!profile)
    return (
      <>
        <p className="text-pretty text-muted">
          You’re signed out. Sign in from the start screen in a Gui window.
        </p>
        {error && <InlineError>{error}</InlineError>}
      </>
    )

  return (
    <>
      <Card className="flex items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{profile.name ?? profile.email ?? 'Gui account'}</p>
          {profile.name && profile.email && (
            <p className="truncate text-small text-muted">{profile.email}</p>
          )}
        </div>
        <Button variant="ghost" disabled={busy} onClick={signOut}>
          Sign out
        </Button>
      </Card>
      <section aria-labelledby={emailHeading} className="flex flex-col gap-2">
        <GroupLabel as="h2" id={emailHeading}>
          Email
        </GroupLabel>
        <List>
          {/* A checkbox row: as tall as a ListItem with a button */}
          <li className="px-3 py-1.5">
            <Checkbox
              label={
                profile.email
                  ? `Email me about new Gui features at ${profile.email}`
                  : 'Email me about new Gui features (your account has no email)'
              }
              checked={profile.updates}
              disabled={busy || !profile.email}
              onChange={(event) => setUpdates(event.target.checked)}
            />
          </li>
        </List>
      </section>
      {error && <InlineError>{error}</InlineError>}
    </>
  )
}
