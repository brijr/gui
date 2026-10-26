import type { ReactNode } from 'react'
import type { RecentProject } from '../../../shared/types'

/**
 * A recents row for a worktree Gui made: named "my-app · pricing-page", and said to be a
 * worktree of my-app on its branch.
 */
export function recentTitle(project: RecentProject, title: string) {
  if (!project.worktree || title !== project.name) return title
  return `${project.worktree.of} · ${project.root.split('/').filter(Boolean).at(-1) ?? title}`
}

export function recentDetail(project: RecentProject, detail: ReactNode): ReactNode {
  if (!project.worktree) return detail
  return (
    <span title={project.root}>
      Worktree of {project.worktree.of} ·{' '}
      <span className="font-mono">{project.worktree.branch}</span>
    </span>
  )
}
