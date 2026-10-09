import { useId } from 'react'
import type { SettingsState, StartCommand } from '../../../shared/types'
import { gui } from '../lib/api'
import { InlineError } from '../lib/field'
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
  const { trustedProjects, startCommands, recentProjects, home } = settings
  const trustedId = useId()
  const startId = useId()
  const recentId = useId()
  const clear = useAction()
  const count = recentProjects.length

  return (
    <>
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
          <p className="text-pretty text-small text-muted">No trusted projects.</p>
        )}
      </section>

      {startCommands.length > 0 && (
        <section aria-labelledby={startId} className="flex flex-col gap-2">
          <GroupLabel as="h2" id={startId}>
            Start commands
          </GroupLabel>
          <p className="text-pretty text-small text-muted">
            These projects start with a command set in Gui instead of the one Gui found. Resetting
            goes back to the one it finds.
          </p>
          <List>
            {startCommands.map(({ root, start }) => (
              <StartCommandRow key={root} root={root} start={start} home={home} />
            ))}
          </List>
        </section>
      )}

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
        {clear.error && <InlineError>{clear.error}</InlineError>}
      </section>
    </>
  )
}

function StartCommandRow({
  root,
  start,
  home,
}: {
  root: string
  start: StartCommand
  home: string
}) {
  const reset = useAction()
  const where = [start.dir, start.url].filter(Boolean).join(' · ')
  return (
    <ListItem
      title={<span className="truncate">{root.split('/').filter(Boolean).at(-1) ?? root}</span>}
      detail={
        <span className="flex min-w-0 flex-col">
          <span className="truncate select-text font-mono text-caption" title={start.command}>
            {start.command}
            {where && <span className="text-subtle"> ({where})</span>}
          </span>
          <PathText path={root} home={home} className="select-text text-caption text-subtle" />
        </span>
      }
      trailing={
        <Button
          aria-label={`Reset the start command for ${root}`}
          disabled={reset.pending}
          onClick={() => void reset.run(() => gui.resetStartCommand(root))}
        >
          Reset
        </Button>
      }
    >
      {reset.error && <InlineError>{reset.error}</InlineError>}
    </ListItem>
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
      {revoke.error && <InlineError>{revoke.error}</InlineError>}
    </ListItem>
  )
}
