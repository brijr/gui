import { useId } from 'react'
import type { SettingsState, StorageKind } from '../../../shared/types'
import { gui } from '../lib/api'
import { InlineError } from '../lib/field'
import { List, ListItem } from '../lib/surface'
import { Button } from '../lib/ui'
import { SettingsGroup } from './settings-group'
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
    detail: 'Your chats, and what lets an agent pick one back up',
  },
  {
    kind: 'checkpoints',
    title: 'Versions',
    detail: 'Saved states that power Undo',
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
    <SettingsGroup heading="Stored on this Mac">
      <List>
        {ROWS.map((row) => (
          <StorageRow key={row.kind} row={row} bytes={storage[row.kind]} />
        ))}
      </List>
      {openProjects.length > 0 && (
        <p className="text-pretty text-caption text-subtle">
          Projects open in a window keep their chat history and versions.
        </p>
      )}
    </SettingsGroup>
  )
}

function StorageRow({ row, bytes }: { row: StorageInfo; bytes: number | null }) {
  const titleId = useId()
  const buttonId = useId()
  const clear = useAction()
  const size = formatBytes(bytes)

  return (
    <ListItem
      heading={row.title}
      titleId={titleId}
      detail={row.detail}
      trailing={
        <>
          <span className="text-small tabular-nums text-muted">{size}</span>
          <Button
            id={buttonId}
            aria-labelledby={`${buttonId} ${titleId}`}
            loading={clear.pending}
            onClick={() => void clear.run(() => gui.clearStorage(row.kind))}
          >
            Clear…
          </Button>
        </>
      }
    >
      {clear.error && <InlineError>{clear.error}</InlineError>}
    </ListItem>
  )
}
