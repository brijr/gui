import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitHubRepository, GitHubState } from '../../../shared/github'
import { gui } from '../lib/api'
import { readableError } from '../lib/errors'
import { InlineError } from '../lib/field'
import { GitHubMark } from '../lib/github-mark'
import { ExternalLink } from '../lib/icons'
import { Badge } from '../lib/status'
import { List, ListItem } from '../lib/surface'
import { Button } from '../lib/ui'
import { useAction } from '../settings/use-action'

/** Said when the user closes the browser sign-in themselves: not an error. */
const SIGN_IN_CANCELLED = 'Sign-in was cancelled.'

/**
 * GitHub for the Clone form: the connection and the repositories Gui may see. Read when the
 * form opens, and again when the window comes back into focus from the browser, where the
 * user connects or chooses repositories.
 */
export function useGitHub(active: boolean) {
  const [state, setState] = useState<GitHubState | null>(null)
  const live = useRef(true)
  const reload = useCallback(async (refresh = true) => {
    const next = await gui.getGitHub(refresh)
    if (live.current) setState(next)
  }, [])
  useEffect(() => {
    if (!active) return
    live.current = true
    const read = () => void reload(false).catch(() => undefined)
    const refresh = () => void reload().catch(() => undefined)
    read()
    window.addEventListener('focus', refresh)
    return () => {
      live.current = false
      window.removeEventListener('focus', refresh)
    }
  }, [active, reload])
  return { state, reload }
}

/** `owner/repo`, from what the user typed (`github.com/owner/repo.git` and the like). */
function repositoryName(value: string) {
  return value
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/** A connected repository the typed value names exactly, to clone with GitHub's access. */
export function matchRepository(value: string, state: GitHubState | null) {
  const name = repositoryName(value)
  return state?.repositories.find((repo) => repo.fullName.toLowerCase() === name) ?? null
}

/**
 * Above the Clone form's field: the user's GitHub repositories, filtered by what's typed, each
 * cloned with GitHub's access. Without GitHub connected, a way to connect it here.
 */
export function GitHubRepositories({
  github,
  filter,
  disabled,
  onClone,
}: {
  github: ReturnType<typeof useGitHub>
  filter: string
  disabled: boolean
  onClone: (id: number) => Promise<void>
}) {
  const { state, reload } = github
  const connect = useAction()
  const manage = useAction()
  const clone = useAction()
  const [cloning, setCloning] = useState<number | null>(null)
  if (!state?.configured) return null

  if (!state.profile) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            loading={connect.pending}
            disabled={disabled}
            onClick={() =>
              void connect.run(async () => {
                try {
                  await gui.connectGitHub()
                } catch (err) {
                  if (readableError(err) === SIGN_IN_CANCELLED) return
                  throw err
                }
                await reload()
              })
            }
          >
            <GitHubMark />
            {connect.pending ? 'Waiting for GitHub…' : 'Connect GitHub'}
          </Button>
          {connect.pending && (
            <Button variant="ghost" onClick={() => void gui.cancelAccountSignIn()}>
              Cancel
            </Button>
          )}
        </div>
        <p className="text-small text-muted">
          {connect.pending
            ? 'Sign in to GitHub in your browser and allow Gui, then come back here.'
            : 'Connect GitHub to see your repositories here, private ones included.'}
        </p>
        {connect.error && <InlineError>{connect.error}</InlineError>}
      </div>
    )
  }

  const name = repositoryName(filter)
  const repos = state.repositories.filter((repo) => repo.fullName.toLowerCase().includes(name))
  const choose = (
    <Button
      size="sm"
      variant="ghost"
      trailingIcon={ExternalLink}
      loading={manage.pending}
      onClick={() => void manage.run(() => gui.manageGitHub())}
    >
      Choose on GitHub
    </Button>
  )
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-small font-medium text-muted">Your GitHub repositories</p>
        {choose}
      </div>
      {state.repositories.length === 0 ? (
        <p className="text-small text-muted">
          Choose which repositories Gui can see on GitHub. An organization may need to approve Gui
          first.
        </p>
      ) : repos.length > 0 ? (
        <List className="max-h-48 overflow-y-auto">
          {repos.slice(0, 50).map((repo) => (
            <RepositoryRow
              key={repo.id}
              repo={repo}
              disabled={disabled}
              loading={cloning === repo.id && clone.pending}
              error={cloning === repo.id ? clone.error : null}
              onClone={async (id) => {
                setCloning(id)
                await clone.run(() => onClone(id))
              }}
            />
          ))}
        </List>
      ) : (
        <p className="text-small text-muted">
          None of your repositories match. Clone it by address.
        </p>
      )}
      {repos.length > 50 && (
        <p className="text-small text-muted">
          {repos.length - 50} more match. Type to narrow the list.
        </p>
      )}
      {manage.error && <InlineError>{manage.error}</InlineError>}
    </div>
  )
}

/** One repository: cloning asks where to save it, then opens it. */
function RepositoryRow({
  repo,
  disabled,
  onClone,
  loading,
  error,
}: {
  error: string | null
  loading: boolean
  repo: GitHubRepository
  disabled: boolean
  onClone: (id: number) => Promise<void>
}) {
  return (
    <ListItem
      title={
        <>
          <span className="truncate" title={repo.fullName}>
            {repo.fullName}
          </span>
          {repo.private && <Badge className="shrink-0">Private</Badge>}
        </>
      }
      trailing={
        <Button
          size="sm"
          loading={loading}
          disabled={disabled}
          onClick={() => void onClone(repo.id)}
        >
          Clone…
        </Button>
      }
    >
      {error && <InlineError>{error}</InlineError>}
    </ListItem>
  )
}
