import { type FormEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { Version } from '../../../shared/types'
import { ChangedFiles } from '../lib/changed-files'
import { Disclosure } from '../lib/disclosure'
import { Field, InlineError, Input } from '../lib/field'
import { ArrowLeft, History, Info, TriangleAlert, Undo2 } from '../lib/icons'
import { Badge } from '../lib/status'
import { Message, PanelHeader } from '../lib/surface'
import { timeAgo } from '../lib/time'
import { Button, IconButton, Skeleton, TIGHT_HIT_AREA } from '../lib/ui'
import { useChat } from './store'
import {
  closeVersions,
  loadVersions,
  restoreVersion,
  saveVersion,
  useVersions,
} from './versions-state'

export { closeVersions, toggleVersions, useVersions } from './versions-state'

const PAGE = 50

function plural(count: number, one: string) {
  return `${count} ${count === 1 ? one : `${one}s`}`
}

/** Replaces the transcript and composer with this chat's versions of the project's files. */
export function VersionsSheet() {
  const versions = useVersions((s) => s.versions)
  const blocked = useVersions((s) => s.blocked)
  const busy = useVersions((s) => s.busy)
  const error = useVersions((s) => s.error)
  const running = useChat((s) => s.turns.some((turn) => turn.status === 'running'))
  const root = useRef<HTMLDivElement>(null)

  // The keyboard comes in with the sheet, on Back. Closed with the keyboard in it, it goes on
  // to the message box that takes the sheet's place, as after a morph (FloatingChat). A layout
  // effect, so the sheet is still in the page when it's checked.
  useLayoutEffect(() => {
    const sheet = root.current
    if (document.hasFocus()) sheet?.querySelector('button')?.focus({ preventScroll: true })
    return () => {
      if (!sheet?.contains(document.activeElement)) return
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[data-composer]')?.focus({ preventScroll: true }),
      )
    }
  }, [])

  // Also on remount (docking, minimizing), so the list and its Current mark are fresh.
  useEffect(() => {
    void loadVersions()
  }, [])

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) closeVersions()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div ref={root} className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title="Versions"
        leading={
          <IconButton
            size="sm"
            className={TIGHT_HIT_AREA}
            label="Back to chat"
            icon={ArrowLeft}
            disabled={busy !== null}
            onClick={closeVersions}
          />
        }
      />
      {blocked ? (
        <Message fill icon={Info} actions={<Button onClick={closeVersions}>Back to chat</Button>}>
          {blocked}
        </Message>
      ) : versions === null ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
          <span role="status" className="sr-only">
            Loading
          </span>
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto scroll-stable scroll-fade p-3">
            <SaveVersion disabled={busy !== null || running} saving={busy === 'save'} />
            {versions.length === 0 ? (
              <Message fill icon={History} tone="accent" title="No versions yet">
                Gui saves a version after each message.
              </Message>
            ) : (
              <VersionList versions={versions} busy={busy} running={running} />
            )}
          </div>
          {error && (
            <div className="shrink-0 border-t border-line p-2">
              <InlineError className="flex max-h-40 gap-1.5 overflow-y-auto scroll-stable px-1">
                <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 whitespace-pre-wrap break-words">{error}</span>
              </InlineError>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Naming the files as they are now, so this point is easy to find again. */
function SaveVersion({ disabled, saving }: { disabled: boolean; saving: boolean }) {
  const id = useId()
  const [name, setName] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || disabled) return
    if (await saveVersion(name)) setName('')
  }
  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-1.5">
      <Field
        label="Save a version"
        htmlFor={`${id}-name`}
        hint="Gui also saves one after every message."
      >
        <div className="flex items-start gap-1.5">
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={200}
            disabled={disabled}
            placeholder="Name this version"
            aria-describedby={`${id}-name-hint`}
            onChange={(event) => setName(event.target.value)}
            className="min-w-0 flex-1"
          />
          <Button
            type="submit"
            disabled={disabled || !name.trim()}
            loading={saving}
            className="shrink-0"
          >
            Save version
          </Button>
        </div>
      </Field>
    </form>
  )
}

function VersionList({
  versions,
  busy,
  running,
}: {
  versions: Version[]
  busy: string | null
  running: boolean
}) {
  const [limit, setLimit] = useState(PAGE)
  const more = versions.length - limit
  return (
    <ul aria-label="Versions" className="flex flex-col gap-2">
      {versions.slice(0, limit).map((version) => (
        <VersionRow key={version.id} version={version} busy={busy} running={running} />
      ))}
      {more > 0 && (
        <li>
          <Button
            size="sm"
            variant="ghost"
            className="tabular-nums"
            onClick={() => setLimit(limit + PAGE)}
          >
            Show more ({more} remaining)
          </Button>
        </li>
      )}
    </ul>
  )
}

function VersionRow({
  version,
  busy,
  running,
}: {
  version: Version
  busy: string | null
  running: boolean
}) {
  const [open, setOpen] = useState(false)
  const changes = version.changes ?? []
  const additions = changes.reduce((sum, change) => sum + change.additions, 0)
  const deletions = changes.reduce((sum, change) => sum + change.deletions, 0)
  const restoring = busy === version.id
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line p-3">
      {/* The name gets the card's full width; badges and time go under it, so a long
          request or name stays readable instead of being cut short by its badges. */}
      <div className="flex flex-col gap-1">
        <span className="line-clamp-2 text-small font-medium break-words" title={version.name}>
          {version.name}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          {version.current && (
            <Badge tone="success" className="shrink-0">
              Current
            </Badge>
          )}
          {version.reverted && <Badge className="shrink-0">Undone</Badge>}
          <span className="ml-auto shrink-0 text-caption text-subtle tabular-nums">
            {timeAgo(version.createdAt)}
          </span>
        </span>
      </div>
      {changes.length > 0 ? (
        <Disclosure open={open} onOpenChange={setOpen} className="self-start tabular-nums">
          {plural(changes.length, 'file')} changed
          <span className="font-mono text-success tabular-nums"> +{additions}</span>
          <span className="font-mono text-danger tabular-nums"> −{deletions}</span>
        </Disclosure>
      ) : (
        version.changes === null &&
        version.kind === 'turn' && (
          <span className="text-caption text-subtle">Changes not recorded</span>
        )
      )}
      {open && changes.length > 0 && <ChangedFiles changes={changes} />}
      {!version.current && (
        <div>
          <Button
            size="sm"
            icon={Undo2}
            disabled={busy !== null || running}
            loading={restoring}
            title="Put the project's files back to this version; how they are now is saved first"
            aria-label={`Restore ${version.name}`}
            onClick={() => void restoreVersion(version.id)}
          >
            Restore
          </Button>
        </div>
      )}
    </li>
  )
}
