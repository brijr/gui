import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import type { CustomAgentEntry } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { readableError } from '../lib/errors'
import { Button, Spinner } from '../lib/ui'

interface Draft {
  name: string
  command: string
  /** One argument per line */
  args: string
  /** KEY=value per line */
  env: string
}

type Status = { kind: 'idle' } | { kind: 'saving' } | { kind: 'error'; message: string }
type ParsedEnv = { ok: true; env: Record<string, string> } | { ok: false; message: string }

const FIELD = cn(
  'w-full rounded-md border border-line-strong bg-raised px-2.5 text-fg',
  'outline-none placeholder:text-subtle focus:border-accent',
)
const TEXTAREA = cn(
  FIELD,
  'field-sizing-content max-h-40 min-h-16 resize-none py-1.5 font-mono text-[11.5px]',
)

function toDraft(entry: CustomAgentEntry | null): Draft {
  if (!entry) return { name: '', command: '', args: '', env: '' }
  const env = Object.entries(entry.env).map(([key, value]) => `${key}=${value}`)
  return {
    name: entry.name,
    command: entry.command,
    args: entry.args.join('\n'),
    env: env.join('\n'),
  }
}

/** Non-blank lines, trimmed. */
function lines(text: string) {
  const trimmed = text.split('\n').map((line) => line.trim())
  return trimmed.filter(Boolean)
}

function parseEnv(text: string): ParsedEnv {
  const entries: [string, string][] = []
  for (const line of lines(text)) {
    const eq = line.indexOf('=')
    const key = eq > 0 ? line.slice(0, eq).trim() : ''
    if (!key) {
      const message = `Environment line "${line}" needs the form KEY=value.`
      return { ok: false, message }
    }
    entries.push([key, line.slice(eq + 1).trim()])
  }
  return { ok: true, env: Object.fromEntries(entries) }
}

interface CustomAgentFormProps {
  /** The entry being edited; null when adding a new one */
  original: CustomAgentEntry | null
  onDone: () => void
}

export function CustomAgentForm({ original, onDone }: CustomAgentFormProps) {
  const id = useId()
  const nameRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(() => toDraft(original))
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const saving = status.kind === 'saving'

  useEffect(() => nameRef.current?.focus(), [])

  const edit = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }))
    if (status.kind === 'error') setStatus({ kind: 'idle' })
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving) return
    const fail = (message: string) => setStatus({ kind: 'error', message })
    const name = draft.name.trim()
    const command = draft.command.trim()
    if (!name) return fail('Give the agent a name.')
    if (!command) return fail('Enter the command that starts the agent.')
    const env = parseEnv(draft.env)
    if (!env.ok) return fail(env.message)

    setStatus({ kind: 'saving' })
    try {
      const entry: CustomAgentEntry = { name, command, args: lines(draft.args), env: env.env }
      await gui.saveCustomAgent(original?.name ?? null, entry)
      onDone()
    } catch (err) {
      setStatus({ kind: 'error', message: readableError(err) })
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-3">
      <Field label="Name" htmlFor={`${id}-name`}>
        <input
          ref={nameRef}
          id={`${id}-name`}
          value={draft.name}
          required
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => edit({ name: event.target.value })}
          className={cn(FIELD, 'h-7 text-[12px]')}
        />
      </Field>
      <Field label="Command" htmlFor={`${id}-command`}>
        <input
          id={`${id}-command`}
          value={draft.command}
          required
          spellCheck={false}
          autoComplete="off"
          placeholder="amp-acp or /path/to/agent"
          onChange={(event) => edit({ command: event.target.value })}
          className={cn(FIELD, 'h-7 font-mono text-[11.5px]')}
        />
      </Field>
      <Field label="Arguments" htmlFor={`${id}-args`} hint="One argument per line.">
        <textarea
          id={`${id}-args`}
          value={draft.args}
          rows={3}
          spellCheck={false}
          aria-describedby={`${id}-args-hint`}
          onChange={(event) => edit({ args: event.target.value })}
          className={TEXTAREA}
        />
      </Field>
      <Field label="Environment" htmlFor={`${id}-env`} hint="KEY=value, one per line.">
        <textarea
          id={`${id}-env`}
          value={draft.env}
          rows={3}
          spellCheck={false}
          aria-describedby={`${id}-env-hint`}
          onChange={(event) => edit({ env: event.target.value })}
          className={TEXTAREA}
        />
      </Field>

      {status.kind === 'error' && (
        <p role="alert" className="select-text text-pretty text-[12px] text-danger">
          {status.message}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" disabled={saving}>
          {saving && <Spinner className="size-2.5" />}
          {original ? 'Save' : 'Add agent'}
        </Button>
        <Button variant="ghost" disabled={saving} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

interface FieldProps {
  label: string
  htmlFor: string
  hint?: string
  children: ReactNode
}

function Field({ label, htmlFor, hint, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="font-medium text-[12px]">
        {label}
      </label>
      {children}
      {hint && (
        <p id={`${htmlFor}-hint`} className="text-[11.5px] text-subtle">
          {hint}
        </p>
      )}
    </div>
  )
}
