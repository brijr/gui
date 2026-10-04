import { useId } from 'react'
import type { SettingsState } from '../../../shared/types'
import { grat } from '../lib/api'
import { Button } from '../lib/ui'
import { GroupHeading, List } from './controls'
import { useAction } from './use-action'

function recentLabel(count: number) {
  if (count === 0) return 'No recent projects'
  if (count === 1) return '1 recent project'
  return `${count} recent projects`
}

export function ProjectsSection({ settings }: { settings: SettingsState }) {
  const { trustedProjects, recentProjects } = settings
  const trustedId = useId()
  const recentId = useId()
  const clear = useAction()
  const count = recentProjects.length

  return (
    <>
      <section aria-labelledby={trustedId} className="flex flex-col gap-2">
        <GroupHeading id={trustedId}>Trusted projects</GroupHeading>
        <p className="text-pretty text-[12px] text-muted">
          Grat runs a trusted project's dev script without asking. Revoking makes it ask again next
          time.
        </p>
        {trustedProjects.length > 0 ? (
          <List>
            {trustedProjects.map((root) => (
              <TrustedRow key={root} root={root} />
            ))}
          </List>
        ) : (
          <p className="text-muted">No trusted projects.</p>
        )}
      </section>

      <section aria-labelledby={recentId} className="flex flex-col gap-2">
        <GroupHeading id={recentId}>Recent projects</GroupHeading>
        <List>
          <li className="flex items-center justify-between gap-3 px-3 py-2.5">
            <p className="tabular-nums text-muted">{recentLabel(count)}</p>
            <Button
              disabled={count === 0 || clear.pending}
              onClick={() => void clear.run(() => grat.clearRecent())}
            >
              Clear recent projects
            </Button>
          </li>
        </List>
        {clear.error && (
          <p role="alert" className="select-text text-pretty text-[12px] text-danger">
            {clear.error}
          </p>
        )}
      </section>
    </>
  )
}

function TrustedRow({ root }: { root: string }) {
  const revoke = useAction()
  return (
    <li className="px-3 py-2">
      <div className="flex items-center gap-3">
        {/* The folder name leads, since long paths would otherwise truncate it away. */}
        <div className="min-w-0 flex-1" title={root}>
          <p className="truncate font-medium">{root.split('/').filter(Boolean).at(-1) ?? root}</p>
          <p className="select-text truncate font-mono text-[11px] text-subtle">{root}</p>
        </div>
        <Button
          aria-label={`Revoke trust for ${root}`}
          disabled={revoke.pending}
          onClick={() => void revoke.run(() => grat.untrustProject(root))}
        >
          Revoke
        </Button>
      </div>
      {revoke.error && (
        <p role="alert" className="mt-1 select-text text-pretty text-[12px] text-danger">
          {revoke.error}
        </p>
      )}
    </li>
  )
}
