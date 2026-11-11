import * as acp from '@agentclientprotocol/sdk'

// How Gui reads what agents send where they differ from one another. No Electron here,
// so tests can load it on its own.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The values a select config option offers, with grouped lists flattened. */
function selectValues(option: unknown): string[] {
  if (!isRecord(option) || option.type !== 'select' || !Array.isArray(option.options)) return []
  const entries: unknown[] = option.options
  return entries.flatMap((entry) => {
    if (!isRecord(entry)) return []
    if (typeof entry.value === 'string') return [entry.value]
    const choices: unknown[] = Array.isArray(entry.options) ? entry.options : []
    return choices.flatMap((choice) =>
      isRecord(choice) && typeof choice.value === 'string' ? [choice.value] : [],
    )
  })
}

/**
 * The session's ACP modes, unless they only mirror another of its settings: pi's adapter
 * reports its thinking levels as modes ("Thinking: high") as well as a `thought_level`
 * option, which the effort picker shows. Such modes aren't a mode to name in the header.
 */
export function displayedModes(
  modes: acp.SessionModeState | null | undefined,
  configOptions: acp.SessionConfigOption[] | null | undefined,
): acp.SessionModeState | null {
  if (!modes || !Array.isArray(modes.availableModes)) return modes ?? null
  const ids = modes.availableModes.map((mode) => mode.id)
  const options: unknown[] = Array.isArray(configOptions) ? configOptions : []
  const mirrored = options.some((option) => {
    if (!isRecord(option) || option.category === 'mode') return false
    if (option.currentValue !== modes.currentModeId) return false
    const values = selectValues(option)
    return values.length === ids.length && ids.every((id) => values.includes(id))
  })
  return mirrored ? null : modes
}

/**
 * How Gemini CLI says its mode changed: `[MODE_UPDATE] plan`, as a whole message chunk,
 * whenever it changes, Gui's own switch included.
 */
export const GEMINI_MODE_NOTICE = /^\[MODE_UPDATE\] (\S+)$/

/**
 * A mode change the agent says as a message of its own (AgentDefinition.modeNotice), as the
 * `current_mode_update` it stands for; null for any other update.
 */
export function modeNoticeUpdate(
  update: acp.SessionNotification['update'],
  notice: RegExp | undefined,
): Extract<acp.SessionNotification['update'], { sessionUpdate: 'current_mode_update' }> | null {
  if (!notice || update.sessionUpdate !== 'agent_message_chunk') return null
  if (update.content.type !== 'text') return null
  const modeId = notice.exec(update.content.text.trim())?.[1]
  return modeId ? { sessionUpdate: 'current_mode_update', currentModeId: modeId } : null
}

/**
 * The useful part of an agent's error. Many put it in `data` behind a generic "Internal
 * error": the ACP TypeScript SDK wraps anything an agent throws as `{ details }` (Codex),
 * the Go SDK as `{ error }` (jcode), and Codex reports a failed turn as `{ message }`.
 */
export function errorDetail(error: unknown): string {
  if (error instanceof acp.RequestError) {
    const { data } = error
    const fields = isRecord(data) ? [data.details, data.error, data.message] : [data]
    const detail = fields.find(
      (field): field is string => typeof field === 'string' && !!field.trim(),
    )
    if (detail) return detail.trim()
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Known ways an agent's turn fails, in plain words, checked in order: a quota error can come
 * as a 429, so the account's limit is checked before the rate limit. Matched on the agent's
 * own text, which often carries the provider's raw JSON (`API Error: 529 {"type":"error",…}`).
 */
const PLAIN_ERRORS: [RegExp, string][] = [
  [
    /context.?(?:length|window)|prompt is too long|input is too long|too many (?:input )?tokens|maximum context/i,
    'This chat is too long for the agent. Start a new chat to keep going.',
  ],
  [
    /credit balance|billing|insufficient.?(?:quota|funds|credits?)|quota exceeded|payment required|\b402\b|usage limit/i,
    'Your agent account is out of credit or at its usage limit. Check its plan, then try again.',
  ],
  [/overloaded|\b529\b/i, 'The agent’s servers are busy. Try again in a minute.'],
  [
    /rate.?limit|too many requests|\b429\b/i,
    'The agent is sending too many requests. Wait a minute, then try again.',
  ],
  [
    /(?:api error|status(?: code)?|http)[:\s]+5\d\d\b|internal server error|bad gateway|service unavailable|gateway time-?out|"api_error"/i,
    'The agent’s servers had a problem. Try again in a minute.',
  ],
  [
    /\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH)\b|socket hang up|network error|fetch failed|connection (?:error|refused|reset)|timed? ?out\b/i,
    'The agent couldn’t reach its servers. Check your internet connection, then try again.',
  ],
]

/** What a failed turn's error means, in plain words; null when it isn't one Gui knows. */
export function plainAgentError(detail: string): string | null {
  return PLAIN_ERRORS.find(([pattern]) => pattern.test(detail))?.[1] ?? null
}

/**
 * How the agent can pick an earlier session back up, best first. session/resume continues
 * it without sending the history again; session/load replays every message, which Gui
 * (keeping its own transcript) only drops.
 */
export function resumeMethods(
  capabilities: acp.AgentCapabilities | null | undefined,
): ('resume' | 'load')[] {
  const methods: ('resume' | 'load')[] = []
  if (isRecord(capabilities?.sessionCapabilities?.resume)) methods.push('resume')
  if (capabilities?.loadSession === true) methods.push('load')
  return methods
}

/** A question Gui can ask on its permission card: one pick from a list. */
export interface FormQuestion {
  id: string
  /** What the card shows as the question, when the field says */
  title: string | undefined
  choices: { value: string; name: string }[]
}

/**
 * The questions in an elicitation form, or null when Gui can't ask them. Gui's card offers
 * buttons, not fields, so each question must be a single pick from a list. An optional field
 * without choices (OpenCode's "type your own answer" beside its choices) is left out, since
 * leaving it empty is a valid answer; a required one, or a multi-pick, makes the form one
 * Gui can't ask.
 */
export function formQuestions(requestedSchema: unknown): FormQuestion[] | null {
  if (!isRecord(requestedSchema) || !isRecord(requestedSchema.properties)) return null
  const required = new Set(
    Array.isArray(requestedSchema.required)
      ? requestedSchema.required.filter((key): key is string => typeof key === 'string')
      : [],
  )
  const questions: FormQuestion[] = []
  for (const [id, field] of Object.entries(requestedSchema.properties)) {
    const choices = isRecord(field) ? fieldChoices(field) : null
    if (!choices) {
      if (required.has(id)) return null
      continue
    }
    const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)
    questions.push({
      id,
      title: isRecord(field) ? (text(field.description) ?? text(field.title)) : undefined,
      choices,
    })
  }
  return questions.length ? questions : null
}

/** A field's choices, when it asks for a single pick from a list; otherwise null. */
function fieldChoices(field: Record<string, unknown>) {
  if (field.type !== 'string') return null
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
  const oneOf = list(field.oneOf).flatMap((option) =>
    isRecord(option) && typeof option.const === 'string'
      ? [
          {
            value: option.const,
            name: typeof option.title === 'string' ? option.title : option.const,
          },
        ]
      : [],
  )
  if (oneOf.length) return oneOf
  const values = list(field.enum).filter((value): value is string => typeof value === 'string')
  return values.length ? values.map((value) => ({ value, name: value })) : null
}
