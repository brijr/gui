/** Snapshot a mutation is based on. Main rechecks it against the open project. */
export interface GitContext {
  root: string
  branch: string | null
  head: string | null
}

export interface GitBranchInfo {
  name: string
  remote: string | null
  checkedOutElsewhere: boolean
  /** The worktree folder it's checked out in, when that's another one that still exists */
  worktree: string | null
}

export interface SourceControlWorkspace extends GitContext {
  defaultBranch: string | null
  branches: GitBranchInfo[]
  destination: { remote: string; branch: string } | null
  ahead: number
  published: boolean
  /** Repository problems restrict actions without hiding status or the draft. */
  writeBlocked: string | null
  /** This is a worktree: its folder, and the main checkout's; null in the main checkout */
  worktree: { path: string; main: string } | null
}

export type SourceControlAction =
  | { kind: 'switch'; branch: string; remote: string | null }
  | { kind: 'create'; branch: string; base: string | null }
  | { kind: 'commit'; files: string[]; title: string; body: string }
  | { kind: 'push' }
  | { kind: 'pull'; title: string; body: string }

export type SourceControlRequest = { expected: GitContext } & SourceControlAction

export interface SourceControlResult {
  outcome:
    | 'switched'
    | 'created-branch'
    | 'committed'
    | 'pushed'
    | 'created'
    | 'compare'
    | 'cancelled'
    | 'branch-required'
  branch: string | null
  commit?: string
  url?: string | null
}

const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max && !value.includes('\0')

/** Validate before a request reaches Git; a push has no renderer approval flag. */
export function isSourceControlRequest(value: unknown): value is SourceControlRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Record<string, unknown>
  if (!request.expected || typeof request.expected !== 'object') return false
  const expected = request.expected as Record<string, unknown>
  if (
    !bounded(expected.root, 4096) ||
    !(expected.branch === null || bounded(expected.branch, 200)) ||
    !(expected.head === null || (bounded(expected.head, 64) && /^[a-f0-9]+$/.test(expected.head)))
  )
    return false
  switch (request.kind) {
    case 'switch':
      return (
        bounded(request.branch, 200) && (request.remote === null || bounded(request.remote, 200))
      )
    case 'create':
      return bounded(request.branch, 200) && (request.base === null || bounded(request.base, 400))
    case 'commit':
      return (
        Array.isArray(request.files) &&
        request.files.length <= 100_000 &&
        request.files.every((path) => bounded(path, 4096)) &&
        bounded(request.title, 500) &&
        bounded(request.body, 20_000)
      )
    case 'pull':
      return bounded(request.title, 500) && bounded(request.body, 20_000)
    case 'push':
      return true
    default:
      return false
  }
}
