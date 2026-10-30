import { useId, useState } from 'react'
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
  const count = recentProjects.length

  return (
    <>
      <section aria-labelledby={trustedId} className="flex flex-col gap-2">
        <GroupLabel as="h2" id={trustedId}>
          Trusted projects
        </GroupLabel>
        <p className="text-pretty text-small text-muted">
          In a trusted project, Gui runs the dev server, and agents use the project's own settings,
          without asking. Revoking makes Gui ask again next time.
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
            Dev server commands
          </GroupLabel>
          <p className="text-pretty text-small text-muted">
            Reset to use the command Gui finds in the project.
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
          <RecentRow count={count} />
        </List>
      </section>
    </>
  )
}

/** How many recent projects, and clearing the list, after asking. */
function RecentRow({ count }: { count: number }) {
  const clear = useAction()
  const [confirming, setConfirming] = useState(false)
  const confirmClear = () =>
    void clear.run(async () => {
      await gui.clearRecent()
      setConfirming(false)
    })
  return (
    <ListItem
      title={<span className="tabular-nums">{recentLabel(count)}</span>}
      trailing={
        confirming && count > 0 ? (
          <>
            <Button variant="ghost" disabled={clear.pending} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={clear.pending} onClick={confirmClear}>
              Clear
            </Button>
          </>
        ) : (
          <Button disabled={count === 0} onClick={() => setConfirming(true)}>
            Clear recent projects
          </Button>
        )
      }
    >
      {confirming && count > 0 && (
        <p className="text-pretty text-small text-muted">
          Clear the list of recent projects? The projects stay on this Mac.
        </p>
      )}
      {clear.error && <InlineError>{clear.error}</InlineError>}
    </ListItem>
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
          aria-label={`Reset the dev server command for ${root}`}
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
