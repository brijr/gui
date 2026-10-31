import { useEffect, useRef, useState } from 'react'
import type { GitHubState } from '../../../shared/github'
import { gui } from '../lib/api'
import { readableError } from '../lib/errors'
import { InlineError } from '../lib/field'
import { GitHubMark } from '../lib/github-mark'
import { ExternalLink } from '../lib/icons'
import { Message } from '../lib/surface'
import { Button, Spinner } from '../lib/ui'
import { IdentityCard, IdentityTile } from './settings-group'
import { useAction } from './use-action'

/** Said when the user closes the browser sign-in themselves: not an error. */
const SIGN_IN_CANCELLED = 'Sign-in was cancelled.'

/**
 * Settings → GitHub: connect GitHub to the Gui account (in the browser) and choose which
 * repositories Gui can see. Cloning is the start screen's Clone…, which lists them. Local projects never need it. Each action has its own progress and its own
 * error, shown where it was chosen.
 */
export function GitHubSection() {
  const [state, setState] = useState<GitHubState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const reload = useAction()
  const disconnect = useAction()
  const manage = useAction()
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    void gui
      .getGitHub()
      .then(setState)
      .catch((err: unknown) => setLoadError(readableError(err)))
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = async () => {
    const next = await gui.getGitHub(true)
    if (mounted.current) setState(next)
  }
  // Choosing Connect again while it waits opens the browser again on the same sign-in.
  const connect = () => {
    setConnecting(true)
    setConnectError(null)
    gui
      .connectGitHub()
      .then(refresh)
      .catch((err: unknown) => {
        const message = readableError(err)
        if (mounted.current && message !== SIGN_IN_CANCELLED) setConnectError(message)
      })
      .finally(() => mounted.current && setConnecting(false))
  }
  const cancel = () => void gui.cancelAccountSignIn().catch(() => undefined)

  const profile = state?.profile ?? null
  const mark = (
    <IdentityTile tone="brand">
      <GitHubMark className="size-4" />
    </IdentityTile>
  )

  if (!state) {
    return loadError ? (
      <IdentityCard
        leading={mark}
        heading="GitHub didn’t load"
        detail="Check your connection, then try again."
      >
        <InlineError>{reload.error ?? loadError}</InlineError>
        <Button
          loading={reload.pending}
          className="self-start"
          onClick={() => void reload.run(refresh)}
        >
          Try again
        </Button>
      </IdentityCard>
    ) : (
      <div role="status">
        <Message icon="loading">Checking your GitHub connection…</Message>
      </div>
    )
  }

  if (!state.configured) {
    return (
      <IdentityCard
        leading={mark}
        heading="GitHub isn’t available in this build"
        detail="You can still clone a repository by its address with Clone… on the start screen, using your own git credentials."
      />
    )
  }

  if (connecting) {
    return (
      <IdentityCard
        leading={mark}
        heading="Finish connecting in your browser"
        detail="Sign in to GitHub there and allow Gui. Then come back here."
      >
        <p role="status" className="flex items-center gap-2 text-small text-muted">
          <Spinner />
          Waiting for GitHub…
        </p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={connect}>Open GitHub again</Button>
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        </div>
      </IdentityCard>
    )
  }

  if (!profile) {
    return (
      <IdentityCard
        leading={mark}
        heading="Connect your GitHub account"
        detail="Clone your repositories, private ones included. Local projects never need GitHub."
      >
        <Button variant="primary" className="self-start" onClick={connect}>
          Connect GitHub
        </Button>
        {connectError && <InlineError>{connectError}</InlineError>}
      </IdentityCard>
    )
  }

  return (
    <IdentityCard
      leading={mark}
      heading={profile.name ?? profile.login}
      detail={`@${profile.login}`}
      trailing={
        <Button
          variant="ghost"
          loading={disconnect.pending}
          onClick={() =>
            void disconnect.run(async () => {
              await gui.disconnectGitHub()
              if (mounted.current) setState({ configured: true, profile: null, repositories: [] })
            })
          }
        >
          Disconnect
        </Button>
      }
    >
      <p className="text-small text-muted">Choose which repositories Gui can see.</p>
      {/* Opens GitHub in the browser */}
      <Button
        trailingIcon={ExternalLink}
        loading={manage.pending}
        className="self-start"
        onClick={() => void manage.run(() => gui.manageGitHub())}
      >
        Choose on GitHub
      </Button>
      {manage.error && <InlineError>{manage.error}</InlineError>}
      {disconnect.error && <InlineError>{disconnect.error}</InlineError>}
    </IdentityCard>
  )
}
