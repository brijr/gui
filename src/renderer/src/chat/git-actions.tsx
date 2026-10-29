import { useId, useState } from 'react'
import { GIT_MESSAGES } from '../../../shared/source-control'
import { gui } from '../lib/api'
import { Dialog } from '../lib/dialog'
import { readableError } from '../lib/errors'
import { Field, InlineError, Input } from '../lib/field'
import { Button } from '../lib/ui'

/**
 * The button a Git error needs instead of instructions: Add name and email… when Git has no
 * identity to commit with (then the action runs again), and GitHub settings when GitHub
 * turned a push away. Nothing for every other error.
 */
export function GitErrorAction({
  error,
  retry,
  onDone,
}: {
  error: string
  /** Runs the failed action again, once the name and email are saved */
  retry: (() => void) | null
  /** Clears the error the button answered */
  onDone: () => void
}) {
  const [asking, setAsking] = useState(false)
  if (error.startsWith(GIT_MESSAGES.signIn))
    return (
      <Button size="sm" onClick={() => void gui.openGitHubSettings()}>
        GitHub settings
      </Button>
    )
  if (!error.startsWith(GIT_MESSAGES.identity)) return null
  return (
    <>
      <Button size="sm" onClick={() => setAsking(true)}>
        Add name and email…
      </Button>
      <IdentityDialog
        open={asking}
        onClose={() => setAsking(false)}
        onSaved={() => {
          setAsking(false)
          onDone()
          retry?.()
        }}
      />
    </>
  )
}

/** Asks once for the name and email Git puts on commits, saved for every project on this Mac. */
function IdentityDialog({
  open,
  onClose,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  const ready = name.trim() !== '' && /^[^\s@]+@[^\s@]+$/.test(email.trim())
  const save = async () => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      await gui.setGitIdentity(name.trim(), email.trim())
      onSaved()
    } catch (failure) {
      setError(readableError(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onClose()
      }}
      title="Add name and email"
      className="flex flex-col gap-3 p-3"
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready} loading={busy} onClick={() => void save()}>
            Save and try again
          </Button>
        </>
      }
    >
      <p className="text-pretty text-small text-muted">
        Git puts these on every commit you make on this Mac, and people see them where you share
        your work. Gui only asks once.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <Field label="Name" htmlFor={`${id}-name`}>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={200}
            disabled={busy}
            autoComplete="name"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Email" htmlFor={`${id}-email`}>
          <Input
            id={`${id}-email`}
            type="email"
            value={email}
            maxLength={320}
            disabled={busy}
            autoComplete="email"
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        {/* Return in either field saves. */}
        <button type="submit" hidden />
      </form>
      {error && <InlineError>{error}</InlineError>}
    </Dialog>
  )
}
