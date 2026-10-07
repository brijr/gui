import { useEffect, useId, useState } from 'react'
import type { GitHubState } from '../../../shared/github'
import { gui } from '../lib/api'
import { InlineError } from '../lib/field'
import { GroupLabel, List } from '../lib/surface'
import { Checkbox } from '../lib/ui'

/**
 * Settings → Advanced: the product-update emails, which go to the GitHub account's verified
 * primary email. New accounts start subscribed (the terms say so); this is where to opt out.
 */
export function AdvancedSection() {
  const [state, setState] = useState<GitHubState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const headingId = useId()

  useEffect(() => {
    void gui
      .getGitHub()
      .then(setState)
      .catch((err: Error) => setError(err.message))
  }, [])

  const profile = state?.profile ?? null
  const setUpdates = (updates: boolean) => {
    if (!state || !profile) return
    const previous = state
    setState({ ...state, profile: { ...profile, updates } })
    setBusy(true)
    setError(null)
    gui
      .gitHubUpdates(updates)
      .then(() => gui.getGitHub())
      .then(setState)
      .catch((err: Error) => {
        setState(previous)
        setError(err.message)
      })
      .finally(() => setBusy(false))
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <GroupLabel as="h2" id={headingId}>
        Email
      </GroupLabel>
      {profile ? (
        <List>
          {/* A checkbox row: as tall as a ListItem with a button */}
          <li className="px-3 py-1.5">
            <Checkbox
              label={
                profile.email
                  ? `Email me Gui product updates at ${profile.email}`
                  : 'Email me Gui product updates (add a verified primary email on GitHub first)'
              }
              checked={profile.updates}
              disabled={busy || !profile.email}
              onChange={(event) => setUpdates(event.target.checked)}
            />
          </li>
        </List>
      ) : (
        state && (
          <p className="text-pretty text-small text-muted">
            Product updates go to the email on your GitHub account. Connect GitHub to choose whether
            you get them.
          </p>
        )
      )}
      {error && <InlineError>{error}</InlineError>}
    </section>
  )
}
