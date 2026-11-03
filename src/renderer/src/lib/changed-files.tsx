import type { FileChange } from '../../../shared/types'
import { cn } from './cn'
import { useReveal } from './disclosure'
import { PathText } from './path-text'

export type ChangeStatus = FileChange['status']

/** How each kind of change reads: its letter, its word (for assistive tech and the tooltip), its color. */
export const CHANGE_STATUS: Record<ChangeStatus, { letter: string; word: string; tone: string }> = {
  added: { letter: 'A', word: 'Added', tone: 'text-success' },
  modified: { letter: 'M', word: 'Changed', tone: 'text-warning' },
  deleted: { letter: 'D', word: 'Deleted', tone: 'text-danger' },
}

/** A file's change as one colored monospace letter in a 12px column; the word for assistive tech. */
export function ChangeMark({ status }: { status: ChangeStatus }) {
  const { letter, word, tone } = CHANGE_STATUS[status]
  return (
    <span className={cn('w-3 shrink-0 font-mono', tone)} title={word}>
      <span aria-hidden="true">{letter}</span>
      <span className="sr-only">{word}</span>
    </span>
  )
}

/** What a turn or a version changed, file by file: the kind of change, the path, lines added and removed. */
export function ChangedFiles({ changes, open }: { changes: FileChange[]; open: boolean }) {
  const reveal = useReveal(open)
  if (!open) return null
  return (
    <ul
      aria-label="Changed files"
      className={cn(reveal, 'flex flex-col gap-1 font-mono text-caption')}
    >
      {changes.map((change) => (
        <li key={change.path} className="flex min-w-0 items-center gap-2">
          <ChangeMark status={change.status} />
          <PathText path={change.path} className="flex-1 text-muted" />
          <span className="min-w-7 shrink-0 text-right text-success tabular-nums">
            +{change.additions}
          </span>
          <span className="min-w-7 shrink-0 text-right text-danger tabular-nums">
            −{change.deletions}
          </span>
        </li>
      ))}
    </ul>
  )
}
