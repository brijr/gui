import { useEffect, useRef, useState } from 'react'
import type { GitHubLogin, GitHubState } from '../../../shared/github'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { Field, InlineError, Input } from '../lib/field'
import { ArrowLeft, GitBranch, Search } from '../lib/icons'
import { Badge } from '../lib/status'
import { Card, GroupLabel, List, ListItem, Message } from '../lib/surface'
import { Button, Checkbox, Code, Spinner } from '../lib/ui'

export function GitHubProjects({
  onClose,
  onOpened,
}: {
  onClose?: () => void
  onOpened?: () => void
}) {
  const [state, setState] = useState<GitHubState | null>(null)
  const [login, setLogin] = useState<GitHubLogin | null>(null)
  const [search, setSearch] = useState('')
  const [projectName, setProjectName] = useState('')
  const [created, setCreated] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const signingIn = useRef(false)

  useEffect(() => {
    mounted.current = true
    void gui
      .getGitHub()
      .then(setState)
      .catch((err: Error) => setError(err.message))
    return () => {
      mounted.current = false
      if (signingIn.current) void gui.cancelGitHub().catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    if (!login) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await gui.pollGitHub()
        if (!active) return
        if (result.pending) timer = setTimeout(poll, login.interval * 1000)
        else {
          signingIn.current = false
          setLogin(null)
          setState(await gui.getGitHub())
        }
      } catch (err) {
        if (active) {
          signingIn.current = false
          setLogin(null)
          setError(err instanceof Error ? err.message : 'Could not connect GitHub.')
        }
      }
    }
    timer = setTimeout(poll, login.interval * 1000)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [login])

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
  const start = async () => {
    signingIn.current = true
    try {
      setLogin(await gui.startGitHub())
    } catch (err) {
      signingIn.current = false
      throw err
    }
  }
  const cancel = async () => {
    signingIn.current = false
    setLogin(null)
    await gui.cancelGitHub()
  }
  const profile = state?.profile
  const repos =
    state?.repositories.filter((repo) =>
      repo.fullName.toLowerCase().includes(search.toLowerCase()),
    ) ?? []
  const close = () => {
    void run(async () => {
      if (signingIn.current) await cancel()
      onClose?.()
    })
  }
  return (
    <section
      aria-label="GitHub projects"
      className={cn('flex w-full max-w-lg flex-col', onClose ? 'gap-3' : 'gap-2')}
    >
      {onClose && (
        <Button
          variant="ghost"
          icon={ArrowLeft}
          disabled={busy}
          // Its arrow lines up with the text below it, as a ghost button in running content.
          className="-ml-2.5 self-start"
          onClick={close}
        >
          Back
        </Button>
      )}
      {/* Under the start screen's title, a semibold title over its explanation as the start
          screen has; in Settings, a group among the others. */}
      <div className="flex flex-col gap-1">
        {onClose ? (
          <h2 className="font-semibold">GitHub projects</h2>
        ) : (
          <GroupLabel as="h2">GitHub projects</GroupLabel>
        )}
        <p className={cn('text-pretty text-muted', !onClose && 'text-small')}>
          Connect GitHub to create projects or open your repositories in Gui. You can always open
          local projects without signing in.
        </p>
      </div>
      {!state && !error && (
        <div role="status">
          <Message icon={<Spinner size="md" />}>Checking GitHub connection…</Message>
        </div>
      )}
      {state && !state.configured && (
        <p className="text-small text-muted">
          GitHub connection is not available in this build yet. You can still clone by URL using
          your existing git credentials.
        </p>
      )}
      {state?.configured && !profile && !login && (
        <Button
          variant="primary"
          disabled={busy}
          className="self-start"
          onClick={() => void run(start)}
        >
          Connect GitHub
        </Button>
      )}
      {login && (
        <div className="flex flex-col gap-2" role="status">
          <p>Enter this code at github.com/login/device:</p>
          <Code className="select-text text-title">{login.code}</Code>
          <p className="text-small text-muted">
            Waiting for GitHub authorization. This code expires in a few minutes.
          </p>
          <Button disabled={busy} className="self-start" onClick={() => void run(cancel)}>
            Cancel sign-in
          </Button>
        </div>
      )}
      {profile && (
        <>
          <p className="text-small text-muted">
            Connected as{' '}
            <span className="font-medium text-fg">{profile.name ?? profile.login}</span> · @
            {profile.login}
          </p>
          <Checkbox
            className="text-small"
            label={`Email me Gui product updates${
              profile.email
                ? ` at ${profile.email}`
                : '. Add a verified primary email in GitHub to subscribe.'
            }`}
            checked={profile.updates}
            disabled={busy || !profile.email}
            onChange={(event) => {
              const checked = event.target.checked
              const previous = state
              if (state) setState({ ...state, profile: { ...profile, updates: checked } })
              void run(async () => {
                try {
                  await gui.gitHubUpdates(checked)
                  await refresh()
                } catch (err) {
                  setState(previous)
                  throw err
                }
              })
            }}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void run(() => gui.manageGitHub())}
            >
              Choose repositories on GitHub
            </Button>
            <Button disabled={busy} onClick={() => void run(refresh)}>
              Refresh repositories
            </Button>
            <Button
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
          </div>
          <Card>
            <form
              className="flex flex-col gap-2 p-3"
              onSubmit={(event) => {
                event.preventDefault()
                if (busy || !projectName.trim()) return
                void run(async () => {
                  const repository = await gui.createGitHub(projectName.trim())
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
                  setCreated(repository.fullName)
                  setProjectName('')
                  setSearch('')
                })
              }}
            >
              <Field
                label="New GitHub project"
                htmlFor="github-project-name"
                hint={`Creates a private repository under @${profile.login} with a README. Install Gui on your personal GitHub account using “Choose repositories on GitHub” first.`}
              >
                <Input
                  id="github-project-name"
                  aria-describedby="github-project-name-hint"
                  placeholder="my-design-project"
                  value={projectName}
                  maxLength={100}
                  disabled={busy}
                  onChange={(event) => setProjectName(event.target.value)}
                />
              </Field>
              <Button type="submit" disabled={busy || !projectName.trim()} className="self-start">
                Create private project
              </Button>
              {created && (
                <p role="status" className="text-small text-muted">
                  Created {created}. Choose “Clone &amp; open” below to start designing.
                </p>
              )}
            </form>
          </Card>
          {state && state.repositories.length === 0 ? (
            <Message icon={<GitBranch className="size-4" aria-hidden="true" />}>
              Choose repositories on GitHub, then refresh here. An organization may need to approve
              Gui before its repositories appear.
            </Message>
          ) : (
            <>
              <Input
                aria-label="Search GitHub repositories"
                placeholder="Search repositories…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {repos.length > 0 && (
                <List className="max-h-64 overflow-y-auto">
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
                          onClick={() =>
                            void run(async () => {
                              await gui.cloneGitHub(repo.id)
                              onOpened?.()
                            })
                          }
                        >
                          Clone & open
                        </Button>
                      }
                    />
                  ))}
                </List>
              )}
              {repos.length === 0 && (
                <Message icon={<Search className="size-4" aria-hidden="true" />}>
                  No repositories match your search.
                </Message>
              )}
            </>
          )}
        </>
      )}
      {error && <InlineError>{error}</InlineError>}
      {error && !state && (
        <Button disabled={busy} className="self-start" onClick={() => void run(refresh)}>
          Try again
        </Button>
      )}
    </section>
  )
}
