import { useId } from 'react'
import type { SettingsState, StorageKind } from '../../../shared/types'
import { gui } from '../lib/api'
import { Button, Spinner } from '../lib/ui'
import { List } from './controls'
import { useAction } from './use-action'

interface StorageInfo {
  kind: StorageKind
  title: string
  detail: string
}

const ROWS: readonly StorageInfo[] = [
  {
    kind: 'chats',
    title: 'Chat history',
    detail: 'Transcripts and resumable agent sessions',
  },
  {
    kind: 'checkpoints',
    title: 'Checkpoints',
    detail: 'Snapshots that power Undo',
  },
  {
    kind: 'previewData',
    title: 'Preview data',
    detail: 'Cookies and storage of the previewed apps',
  },
]

/** Decimal units, like Finder. */
function formatBytes(bytes: number | null) {
  if (bytes === null) return 'Measuring…'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  // Step up once the rounded value would read as 1000 or more.
  while (value >= 999.5 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  const text = unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)
  return `${text} ${units[unit]}`
}

export function StorageSection({ settings }: { settings: SettingsState }) {
  const { storage, openProjects } = settings
  return (
    <>
      <List>
        {ROWS.map((row) => (
          <StorageRow key={row.kind} row={row} bytes={storage[row.kind]} />
        ))}
      </List>
      {openProjects.length > 0 && (
        <p className="text-pretty text-[11.5px] text-subtle">
          Projects open in a window keep their chat history and checkpoints.
        </p>
      )}
    </>
  )
}

function StorageRow({ row, bytes }: { row: StorageInfo; bytes: number | null }) {
  const titleId = useId()
  const buttonId = useId()
  const clear = useAction()
  const size = formatBytes(bytes)

  return (
    <li className="px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p id={titleId} className="font-medium">
            {row.title}
          </p>
          <p className="text-pretty text-[12px] text-muted">{row.detail}</p>
        </div>
        <span className="shrink-0 text-[12px] tabular-nums text-muted">{size}</span>
        <Button
          id={buttonId}
          aria-labelledby={`${buttonId} ${titleId}`}
          disabled={clear.pending}
          onClick={() => void clear.run(() => gui.clearStorage(row.kind))}
        >
          {clear.pending && <Spinner className="size-2.5" />}
          Clear…
        </Button>
      </div>
      {clear.error && (
        <p role="alert" className="mt-1 select-text text-pretty text-[12px] text-danger">
          {clear.error}
        </p>
      )}
    </li>
  )
}
