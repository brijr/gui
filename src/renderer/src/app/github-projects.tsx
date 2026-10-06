import { useEffect, useRef, useState } from 'react'
import type { GitHubLogin, GitHubState } from '../../../shared/github'
import { gui } from '../lib/api'
import { Input } from '../lib/field'
import { Button, Code } from '../lib/ui'

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
  return (
    <section aria-label="GitHub projects" className="flex w-full max-w-lg flex-col gap-3">
      <h2 className="text-body font-semibold">GitHub projects</h2>
      <p className="text-small text-muted">
        Connect GitHub to create projects or open your repositories in Gui. You can always open
        local projects without signing in.
      </p>
      {!state && !error && <p role="status">Checking GitHub connection…</p>}
      {state && !state.configured && (
        <p className="text-small text-muted">
          GitHub connection is not available in this build yet. You can still clone by URL using
          your existing git credentials.
        </p>
      )}
      {state?.configured && !profile && !login && (
        <Button variant="primary" disabled={busy} onClick={() => void run(start)}>
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
          <Button disabled={busy} onClick={() => void run(cancel)}>
            Cancel sign-in
          </Button>
        </div>
      )}
      {profile && (
        <>
          <p className="text-small">
            Connected as <strong>{profile.name ?? profile.login}</strong> · @{profile.login}
          </p>
          <label className="flex items-start gap-2 text-small">
            <input
              type="checkbox"
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
            <span>
              Email me Gui product updates
              {profile.email
                ? ` at ${profile.email}`
                : '. Add a verified primary email in GitHub to subscribe.'}
            </span>
          </label>
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
          <form
            className="flex flex-col gap-2 rounded-md border border-line p-3"
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
            <label className="text-small" htmlFor="github-project-name">
              New GitHub project
            </label>
            <Input
              id="github-project-name"
              placeholder="my-design-project"
              value={projectName}
              maxLength={100}
              disabled={busy}
              onChange={(event) => setProjectName(event.target.value)}
            />
            <p className="text-small text-muted">
              Creates a private repository under @{profile.login} with a README. Install Gui on your
              personal GitHub account using “Choose repositories on GitHub” first.
            </p>
            <Button type="submit" disabled={busy || !projectName.trim()}>
              Create private project
            </Button>
            {created && (
              <p role="status" className="text-small">
                Created {created}. Choose “Clone &amp; open” below to start designing.
              </p>
            )}
          </form>
          {state && state.repositories.length === 0 ? (
            <p className="text-small text-muted">
              Choose repositories on GitHub, then refresh here. An organization may need to approve
              Gui before its repositories appear.
            </p>
          ) : (
            <>
              <Input
                aria-label="Search GitHub repositories"
                placeholder="Search repositories…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                {repos.map((repo) => (
                  <li
                    key={repo.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-line p-2"
                  >
                    <span className="min-w-0 truncate text-small">
                      {repo.fullName}
                      {repo.private && ' · Private'}
                    </span>
                    <Button
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
                  </li>
                ))}
              </ul>
              {repos.length === 0 && (
                <p className="text-small text-muted">No repositories match your search.</p>
              )}
            </>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="select-text text-small text-danger">
          {error}
        </p>
      )}
      {error && !state && (
        <Button disabled={busy} onClick={() => void run(refresh)}>
          Try again
        </Button>
      )}
      {onClose && (
        <Button
          disabled={busy}
          onClick={() => {
            void run(async () => {
              if (signingIn.current) await cancel()
              onClose()
            })
          }}
        >
          Back
        </Button>
      )}
    </section>
  )
}
