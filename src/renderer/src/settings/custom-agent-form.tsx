import { type FormEvent, useEffect, useId, useRef, useState } from 'react'
import type { CustomAgentEntry } from '../../../shared/types'
import { gui } from '../lib/api'
import { readableError } from '../lib/errors'
import { Field, InlineError, Input, Textarea } from '../lib/field'
import { Button } from '../lib/ui'

interface Draft {
  name: string
  command: string
  /** One argument per line */
  args: string
  /** KEY=value per line */
  env: string
}

/** An error names the field it's about, so it shows under that field; without one, under the form. */
type Status =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string; field?: 'name' | 'command' | 'env' }
type ParsedEnv = { ok: true; env: Record<string, string> } | { ok: false; message: string }

/** Arguments and environment: a line each, growing with the text */
const LINES = 'field-sizing-content max-h-40 min-h-16'

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
  const errorFor = (field: 'name' | 'command' | 'env') =>
    status.kind === 'error' && status.field === field ? status.message : undefined

  useEffect(() => nameRef.current?.focus(), [])

  const edit = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }))
    if (status.kind === 'error') setStatus({ kind: 'idle' })
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving) return
    const fail = (field: 'name' | 'command' | 'env', message: string) =>
      setStatus({ kind: 'error', message, field })
    const name = draft.name.trim()
    const command = draft.command.trim()
    if (!name) return fail('name', 'Give the agent a name.')
    if (!command) return fail('command', 'Enter the command that starts the agent.')
    const env = parseEnv(draft.env)
    if (!env.ok) return fail('env', env.message)

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
      <Field label="Name" htmlFor={`${id}-name`} error={errorFor('name')}>
        <Input
          ref={nameRef}
          id={`${id}-name`}
          aria-invalid={errorFor('name') ? true : undefined}
          aria-describedby={errorFor('name') ? `${id}-name-error` : undefined}
          value={draft.name}
          required
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => edit({ name: event.target.value })}
        />
      </Field>
      <Field label="Command" htmlFor={`${id}-command`} error={errorFor('command')}>
        <Input
          id={`${id}-command`}
          aria-invalid={errorFor('command') ? true : undefined}
          aria-describedby={errorFor('command') ? `${id}-command-error` : undefined}
          mono
          value={draft.command}
          required
          spellCheck={false}
          autoComplete="off"
          placeholder="amp-acp or /path/to/agent"
          onChange={(event) => edit({ command: event.target.value })}
        />
      </Field>
      <Field label="Arguments" htmlFor={`${id}-args`} hint="One argument per line.">
        <Textarea
          id={`${id}-args`}
          mono
          value={draft.args}
          rows={3}
          spellCheck={false}
          aria-describedby={`${id}-args-hint`}
          onChange={(event) => edit({ args: event.target.value })}
          className={LINES}
        />
      </Field>
      <Field
        label="Environment"
        htmlFor={`${id}-env`}
        hint="KEY=value, one per line."
        error={errorFor('env')}
      >
        <Textarea
          id={`${id}-env`}
          mono
          value={draft.env}
          rows={3}
          spellCheck={false}
          aria-invalid={errorFor('env') ? true : undefined}
          aria-describedby={errorFor('env') ? `${id}-env-error` : `${id}-env-hint`}
          onChange={(event) => edit({ env: event.target.value })}
          className={LINES}
        />
      </Field>

      {status.kind === 'error' && !status.field && <InlineError>{status.message}</InlineError>}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" loading={saving}>
          {original ? 'Save' : 'Add agent'}
        </Button>
        <Button variant="ghost" disabled={saving} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
