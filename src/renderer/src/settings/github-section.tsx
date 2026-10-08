import { type ReactNode, useEffect, useId, useRef, useState } from 'react'
import type { GitHubState } from '../../../shared/github'
import { gui } from '../lib/api'
import { readableError } from '../lib/errors'
import { Field, InlineError, Input } from '../lib/field'
import { GitHubMark } from '../lib/github-mark'
import { GitBranch, RotateCw, Search } from '../lib/icons'
import { Badge } from '../lib/status'
import { Card, GroupLabel, List, ListItem, Message } from '../lib/surface'
import { Button, Spinner } from '../lib/ui'

/**
 * Settings → GitHub: connect GitHub to the Gui account (in the browser), then open its
 * repositories in Gui or create a new one. Local projects never need it.
 */
export function GitHubSection() {
  const [state, setState] = useState<GitHubState | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    void gui
      .getGitHub()
      .then(setState)
      .catch((err: Error) => setError(err.message))
    return () => {
      mounted.current = false
    }
  }, [])

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      if (mounted.current)
        setError(err instanceof Error ? err.message : 'Could not connect GitHub.')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const refresh = async () => setState(await gui.getGitHub())
  // Choosing Connect again while it waits opens the browser again on the same sign-in.
  const connect = () => {
    setConnecting(true)
    setError(null)
    gui
      .connectGitHub()
      .then(refresh)
      .catch((err: unknown) => {
        const message = readableError(err)
        if (mounted.current && message !== 'Sign-in was cancelled.') setError(message)
      })
      .finally(() => mounted.current && setConnecting(false))
  }
  const cancel = () => void gui.cancelAccountSignIn().catch(() => undefined)

  const profile = state?.profile ?? null
  const failed = error && <InlineError>{error}</InlineError>

  if (!state) {
    return error ? (
      <>
        {failed}
        <Button disabled={busy} className="self-start" onClick={() => void run(refresh)}>
          Try again
        </Button>
      </>
    ) : (
      <div role="status">
        <Message icon={<Spinner size="md" />}>Checking your GitHub connection…</Message>
      </div>
    )
  }

  if (!state.configured) {
    return (
      <AccountCard
        title="GitHub isn’t available in this build"
        detail="You can still clone a repository by its URL from the start screen, with your own git credentials."
      />
    )
  }

  if (connecting) {
    return (
      <AccountCard
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
      </AccountCard>
    )
  }

  if (!profile) {
    return (
      <>
        <AccountCard
          title="Connect your GitHub account"
          detail="Open your repositories in Gui and create new projects. Local projects never need GitHub."
        >
          <Button variant="primary" disabled={busy} className="self-start" onClick={connect}>
            Connect GitHub
          </Button>
        </AccountCard>
        {failed}
      </>
    )
  }

  return (
    <>
      <AccountCard
        title={profile.name ?? profile.login}
        detail={`@${profile.login}`}
        trailing={
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await gui.disconnectGitHub()
                setState({ configured: true, profile: null, repositories: [] })
              })
            }
          >
            Disconnect
          </Button>
        }
      />
      {failed}
      <Repositories state={state} busy={busy} run={run} refresh={refresh} />
      <NewProject
        login={profile.login}
        busy={busy}
        run={run}
        onCreated={(repository) =>
          setState(
            (current) =>
              current && {
                ...current,
                repositories: [
                  ...current.repositories.filter((repo) => repo.id !== repository.id),
                  repository,
                ],
              },
          )
        }
      />
    </>
  )
}

/** The account at the top of the page: GitHub's mark, who (or what to do), and actions. */
function AccountCard({
  title,
  detail,
  trailing,
  children,
}: {
  title: ReactNode
  detail: ReactNode
  trailing?: ReactNode
  children?: ReactNode
}) {
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#000] text-[#fff]"
        >
          <GitHubMark className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{title}</p>
          <p className="text-pretty text-small text-muted">{detail}</p>
        </div>
        {trailing}
      </div>
      {children}
    </Card>
  )
}

type Run = (action: () => Promise<unknown>) => Promise<void>

/** The repositories Gui may see, searchable, each to clone and open as a project. */
function Repositories({
  state,
  busy,
  run,
  refresh,
}: {
  state: GitHubState
  busy: boolean
  run: Run
  refresh: () => Promise<void>
}) {
  const [search, setSearch] = useState('')
  const headingId = useId()
  const repos = state.repositories.filter((repo) =>
    repo.fullName.toLowerCase().includes(search.toLowerCase()),
  )
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <GroupLabel as="h2" id={headingId}>
          Repositories
        </GroupLabel>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            icon={RotateCw}
            disabled={busy}
            onClick={() => void run(refresh)}
          >
            Refresh
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void run(() => gui.manageGitHub())}
          >
            Choose on GitHub
          </Button>
        </div>
      </div>
      {state.repositories.length === 0 ? (
        <Message icon={<GitBranch className="size-4" aria-hidden="true" />}>
          Choose which repositories Gui can see on GitHub, then refresh here. An organization may
          need to approve Gui before its repositories appear.
        </Message>
      ) : (
        <>
          <Input
            aria-label="Search GitHub repositories"
            placeholder="Search repositories…"
            leading={
              <span className="flex shrink-0 pr-1.5 pl-2.5">
                <Search className="size-3.5 text-subtle" aria-hidden="true" />
              </span>
            }
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {repos.length > 0 ? (
            <List className="max-h-72 overflow-y-auto">
              {repos.map((repo) => (
                <ListItem
                  key={repo.id}
                  title={
                    <>
                      <span className="truncate">{repo.fullName}</span>
                      {repo.private && <Badge className="shrink-0">Private</Badge>}
                    </>
                  }
                  trailing={
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void run(() => gui.cloneGitHub(repo.id))}
                    >
                      Clone & open
                    </Button>
                  }
                />
              ))}
            </List>
          ) : (
            <p className="text-small text-muted">No repositories match “{search}”.</p>
          )}
        </>
      )}
    </section>
  )
}

/** A new private repository with a README, then listed above to clone and open. */
function NewProject({
  login,
  busy,
  run,
  onCreated,
}: {
  login: string
  busy: boolean
  run: Run
  onCreated: (repository: GitHubState['repositories'][number]) => void
}) {
  const [name, setName] = useState('')
  const [created, setCreated] = useState<string | null>(null)
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <GroupLabel as="h2" id={headingId}>
        New project
      </GroupLabel>
      <Card>
        <form
          className="flex flex-col gap-3 p-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (busy || !name.trim()) return
            void run(async () => {
              const repository = await gui.createGitHub(name.trim())
              onCreated(repository)
              setCreated(repository.fullName)
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
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Button type="submit" disabled={busy || !name.trim()} className="self-start">
            Create private repository
          </Button>
          {created && (
            <p role="status" className="text-small text-muted">
              Created {created}. Clone & open it from Repositories above.
            </p>
          )}
        </form>
      </Card>
    </section>
  )
}
