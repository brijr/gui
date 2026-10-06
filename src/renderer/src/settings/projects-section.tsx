import { useId } from 'react'
import type { SettingsState } from '../../../shared/types'
import { GitHubProjects } from '../app/github-projects'
import { gui } from '../lib/api'
import { PathText } from '../lib/path-text'
import { GroupLabel, List, ListItem } from '../lib/surface'
import { Button } from '../lib/ui'
import { useAction } from './use-action'

function recentLabel(count: number) {
  if (count === 0) return 'No recent projects'
  if (count === 1) return '1 recent project'
  return `${count} recent projects`
}

export function ProjectsSection({ settings }: { settings: SettingsState }) {
  const { trustedProjects, recentProjects, home } = settings
  const trustedId = useId()
  const recentId = useId()
  const clear = useAction()
  const count = recentProjects.length

  return (
    <>
      <GitHubProjects />
      <section aria-labelledby={trustedId} className="flex flex-col gap-2">
        <GroupLabel as="h2" id={trustedId}>
          Trusted projects
        </GroupLabel>
        <p className="text-pretty text-small text-muted">
          Gui runs a trusted project's dev script without asking. Revoking makes it ask again next
          time.
        </p>
        {trustedProjects.length > 0 ? (
          <List>
            {trustedProjects.map((root) => (
              <TrustedRow key={root} root={root} home={home} />
            ))}
          </List>
        ) : (
          <p className="text-muted">No trusted projects.</p>
        )}
      </section>

      <section aria-labelledby={recentId} className="flex flex-col gap-2">
        <GroupLabel as="h2" id={recentId}>
          Recent projects
        </GroupLabel>
        <List>
          <ListItem
            title={<span className="tabular-nums">{recentLabel(count)}</span>}
            trailing={
              <Button
                disabled={count === 0 || clear.pending}
                onClick={() => void clear.run(() => gui.clearRecent())}
              >
                Clear recent projects
              </Button>
            }
          />
        </List>
        {clear.error && (
          <p role="alert" className="select-text text-pretty text-small text-danger">
            {clear.error}
          </p>
        )}
      </section>
    </>
  )
}

function TrustedRow({ root, home }: { root: string; home: string }) {
  const revoke = useAction()
  return (
    <ListItem
      // The folder name leads, since the path below it truncates in the middle.
      title={<span className="truncate">{root.split('/').filter(Boolean).at(-1) ?? root}</span>}
      detail={<PathText path={root} home={home} className="select-text text-caption text-subtle" />}
      trailing={
        <Button
          aria-label={`Revoke trust for ${root}`}
          disabled={revoke.pending}
          onClick={() => void revoke.run(() => gui.untrustProject(root))}
        >
          Revoke
        </Button>
      }
    >
      {revoke.error && (
        <p role="alert" className="select-text text-pretty text-small text-danger">
          {revoke.error}
        </p>
      )}
    </ListItem>
  )
}
