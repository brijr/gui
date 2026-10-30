import type { BranchStatus } from '../../../shared/types'
import { cn } from '../lib/cn'
import { GitBranch } from '../lib/icons'

/**
 * The project's branch, next to its name in the toolbar, so a switch (by the agent, or in the
 * terminal) doesn't go unnoticed. Read only: Git is the agent's and the terminal's.
 */
export function BranchLabel({
  branch,
  compact = false,
}: {
  branch: BranchStatus
  /** Short of room in the toolbar: just the mark, with the name in its tooltip */
  compact?: boolean
}) {
  const name = branch.branch ?? 'No branch'
  return (
    // Out of the window's drag region, so its tooltip shows.
    <span
      title={`Branch ${name}`}
      className="no-drag inline-flex h-7 max-w-56 shrink-0 items-center gap-1.5 px-2.5 text-small text-muted"
    >
      <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
      <span className={cn('min-w-0 truncate font-mono text-fg', compact && 'sr-only')}>{name}</span>
    </span>
  )
}
