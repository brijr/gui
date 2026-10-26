import type { BranchStatus } from '../../../shared/types'
import { gui } from '../lib/api'
import { ChevronDown, GitBranch, SquareStack } from '../lib/icons'
import { Button } from '../lib/ui'

/**
 * The project's branch, next to its name in the toolbar, with a worktree's mark in a worktree.
 * It's the way into source control: its menu (main's `showBranchMenu`) switches branches,
 * makes a branch or a worktree, lists the repository's worktrees, and opens Source Control.
 */
export function BranchButton({
  branch,
  compact = false,
}: {
  branch: BranchStatus
  /** Short of room in the toolbar: just the mark, with the name in its tooltip */
  compact?: boolean
}) {
  const name = branch.branch ?? 'No branch'
  const { worktree } = branch
  return (
    <Button
      variant="ghost"
      icon={worktree ? SquareStack : GitBranch}
      trailingIcon={ChevronDown}
      aria-haspopup="menu"
      aria-label={worktree ? `Branch ${name}, in the worktree ${worktree.name}` : `Branch ${name}`}
      title={
        worktree
          ? `${name}, in the worktree ${worktree.name}: a separate copy of ${worktree.of} on its own branch`
          : name
      }
      className="max-w-56 shrink-0"
      onClick={() => gui.showBranchMenu()}
    >
      {!compact && <span className="min-w-0 truncate font-mono text-fg">{name}</span>}
    </Button>
  )
}
