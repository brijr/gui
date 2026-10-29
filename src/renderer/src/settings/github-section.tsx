import { useEffect, useRef, useState } from 'react'
import type { GitHubState } from '../../../shared/github'
import { gui } from '../lib/api'
import { readableError } from '../lib/errors'
import { Field, InlineError, Input } from '../lib/field'
import { GitHubMark } from '../lib/github-mark'
import { ExternalLink } from '../lib/icons'
import { Message } from '../lib/surface'
import { Button, Spinner } from '../lib/ui'
import { IdentityCard, IdentityTile, SettingsCard, SettingsGroup } from './settings-group'
import { useAction } from './use-action'

/** Said when the user closes the browser sign-in themselves: not an error. */
const SIGN_IN_CANCELLED = 'Sign-in was cancelled.'

type Repository = GitHubState['repositories'][number]

/**
 * Settings → GitHub: connect GitHub to the Gui account (in the browser), choose which
 * repositories Gui can see, and create a new one. Cloning is the start screen's Clone…, which
 * lists them. Local projects never need it. Each action has its own progress and its own
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
      <GitHubMark className="size-5" />
    </IdentityTile>
  )

  if (!state) {
    return loadError ? (
      <IdentityCard
        leading={mark}
        title="GitHub didn’t load"
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
        <Message icon={<Spinner size="md" />}>Checking your GitHub connection…</Message>
      </div>
    )
  }

  if (!state.configured) {
    return (
      <IdentityCard
        leading={mark}
        title="GitHub isn’t available in this build"
        detail="You can still clone a repository by its address with Clone… on the start screen, using your own git credentials."
      />
    )
  }

  if (connecting) {
    return (
      <IdentityCard
        leading={mark}
        title="Finish connecting in your browser"
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
        title="Connect your GitHub account"
        detail="Clone your repositories, private ones included, and create new ones. Local projects never need GitHub."
      >
        <Button variant="primary" className="self-start" onClick={connect}>
          Connect GitHub
        </Button>
        {connectError && <InlineError>{connectError}</InlineError>}
      </IdentityCard>
    )
  }

  return (
    <>
      <IdentityCard
        leading={mark}
        title={profile.name ?? profile.login}
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
        <p className="text-small text-muted">
          Choose which repositories Gui can see. Clone them with Clone… on the start screen.
        </p>
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
      <NewProject login={profile.login} />
    </>
  )
}

/** A new private repository with a README, then Open… clones it and opens it as a project. */
function NewProject({ login }: { login: string }) {
  const [name, setName] = useState('')
  const [created, setCreated] = useState<Repository | null>(null)
  const create = useAction()
  const open = useAction()
  return (
    <SettingsGroup title="New project">
      <SettingsCard>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (create.pending || !name.trim()) return
            setCreated(null)
            void create.run(async () => {
              const repository = await gui.createGitHub(name.trim())
              setCreated(repository)
              setName('')
            })
          }}
        >
          <Field
            label="Repository name"
            htmlFor="github-project-name"
            hint={`A private repository under @${login}, with a README. Gui needs access to your personal account first: Choose on GitHub.`}
          >
            <Input
              id="github-project-name"
              aria-describedby="github-project-name-hint"
              placeholder="my-design-project"
              value={name}
              maxLength={100}
              disabled={create.pending}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Button
            type="submit"
            loading={create.pending}
            disabled={!name.trim()}
            className="self-start"
          >
            Create private repository
          </Button>
          {create.error && <InlineError>{create.error}</InlineError>}
          {created && (
            <div className="flex flex-wrap items-center gap-2">
              <p role="status" className="text-small text-muted">
                Created {created.fullName}.
              </p>
              <Button
                size="sm"
                loading={open.pending}
                onClick={() => void open.run(() => gui.cloneGitHub(created.id))}
              >
                Open…
              </Button>
            </div>
          )}
          {open.error && <InlineError>{open.error}</InlineError>}
        </form>
      </SettingsCard>
    </SettingsGroup>
  )
}
