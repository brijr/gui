import * as acp from '@agentclientprotocol/sdk'
import type { AgentSetting, ModelSettings } from '../shared/types'
import type { AgentFailure } from './analytics-queue'

// How Gui reads what agents send where they differ from one another. No Electron here,
// so tests can load it on its own.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isChoice = (value: unknown): value is { value: string; name: string } =>
  isRecord(value) && typeof value.value === 'string' && typeof value.name === 'string'

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
 * What the user reads for each failure Gui names, in plain words. A failure without one
 * keeps the agent's own words: they say more than Gui could (which request, which tool).
 */
const PLAIN_MESSAGES: Partial<Record<AgentFailure, string>> = {
  context_too_long: 'This chat is too long for the agent. Start a new chat to keep going.',
  no_credit:
    'Your agent account is out of credit or at its usage limit. Check its plan, then try again.',
  servers_busy: 'The agent’s servers are busy. Try again in a minute.',
  rate_limited: 'The agent is sending too many requests. Wait a minute, then try again.',
  server_error: 'The agent’s servers had a problem. Try again in a minute.',
  offline: 'The agent couldn’t reach its servers. Check your internet connection, then try again.',
  no_model:
    'The agent has no model it can use. Set up a provider or pick another model in the agent, then try again.',
  timeout: 'The agent’s servers stopped answering. Try again in a minute.',
  dropped: 'The agent’s connection dropped partway through its answer. Try again.',
  denied:
    'The agent stopped because you declined what it asked to do. Say what to do instead, and it carries on.',
}

/**
 * Known ways an agent's turn fails, checked in order on the agent's own text, which often
 * carries the provider's raw JSON (`API Error: 529 {"type":"error",…}`): a quota error can
 * come as a 429, so the account's limit is checked before the rate limit.
 */
const PLAIN_ERRORS: [RegExp, AgentFailure][] = [
  [
    /context.?(?:length|window)|prompt is too long|input is too long|too many (?:input )?tokens|maximum context/i,
    'context_too_long',
  ],
  [
    /credit balance|billing|insufficient.?(?:quota|funds|credits?)|quota exceeded|payment required|\b402\b|usage limit/i,
    'no_credit',
  ],
  [/overloaded|\b529\b/i, 'servers_busy'],
  [/rate.?limit|too many requests|\b429\b/i, 'rate_limited'],
  [
    /(?:api error|status(?: code)?|http)[:\s]+5\d\d\b|internal server error|bad gateway|service unavailable|gateway time-?out|"api_error"/i,
    'server_error',
  ],
  [
    /\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ENETUNREACH)\b|socket hang up|network error|fetch failed|connection (?:error|refused|reset)|timed? ?out\b/i,
    'offline',
  ],
]

/**
 * Errors only a message tells apart, each matched from the start on one agent's own fixed
 * text (never the provider's or the user's words, and never sent: only the name it maps to).
 * The ACP SDK's `internalError` puts "Internal error: " before an agent's text.
 */
const AGENT_MESSAGES: [RegExp, AgentFailure][] = [
  // OpenCode 2.x's ACPCatalogNotReadyError, thrown as session/new finds no model enabled
  // (no provider set up): "No models are available".
  [/^(?:Internal error: )?No models are available$/, 'no_model'],
  // claude-agent-acp's SESSION_ENDED_MESSAGE ("The Claude Agent session has ended. Please
  // start a new session.") and its message when Claude Code's process exits under it.
  [
    /^(?:Internal error: )?The Claude Agent (?:session has ended|process exited unexpectedly)\b/,
    'agent_quit',
  ],
]

/**
 * claude-agent-acp's `data.errorKind` on a failed turn: the Claude Agent SDK's
 * SDKAssistantMessageError, or one of the adapter's own kinds.
 */
const CLAUDE_ERROR_KINDS: Record<string, AgentFailure> = {
  authentication_failed: 'signed_out',
  oauth_org_not_allowed: 'signed_out',
  billing_error: 'no_credit',
  account_on_hold: 'no_credit',
  rate_limit: 'rate_limited',
  overloaded: 'servers_busy',
  server_error: 'server_error',
  invalid_request: 'bad_request',
  model_not_found: 'no_model',
  // The adapter lost Claude Code's process, or is shutting down.
  transport_lost: 'agent_quit',
  worker_shutdown: 'agent_quit',
  // The model's stream dropped mid-turn: the turn ended without a result.
  no_result: 'dropped',
  incomplete_tool_call: 'tool_failed',
}

/**
 * codex-acp's `data.codexErrorInfo` (Codex's CodexErrorInfo): a name, or an object keyed by
 * one (`{ responseStreamDisconnected: { httpStatusCode } }`).
 */
const CODEX_ERROR_INFO: Record<string, AgentFailure> = {
  contextWindowExceeded: 'context_too_long',
  usageLimitExceeded: 'no_credit',
  rateLimitExceeded: 'rate_limited',
  serverOverloaded: 'servers_busy',
  internalServerError: 'server_error',
  unauthorized: 'signed_out',
  badRequest: 'bad_request',
  httpConnectionFailed: 'offline',
  responseStreamConnectionFailed: 'offline',
  responseStreamDisconnected: 'dropped',
  responseTooManyFailedAttempts: 'dropped',
}

/**
 * OpenCode 2.x's `data.errorName` on a failed prompt (its ACPServiceFailureError carries the
 * turn's step error type). `provider.auth` comes as ACP's auth_required instead.
 */
const OPENCODE_ERROR_NAMES: Record<string, AgentFailure> = {
  'provider.rate-limit': 'rate_limited',
  'provider.quota': 'no_credit',
  'provider.free-limit': 'no_credit',
  'provider.budget-limit': 'no_credit',
  'provider.model-budget-limit': 'no_credit',
  'provider.go-limit': 'no_credit',
  'provider.chatgpt-limit': 'no_credit',
  'provider.chatgpt-workspace-limit': 'no_credit',
  'provider.transport': 'offline',
  'provider.internal': 'server_error',
  'provider.timeout': 'timeout',
  'provider.invalid-request': 'bad_request',
  'provider.unsupported-operation': 'bad_request',
  // No provider serves the model picked, or the provider isn't one OpenCode knows.
  'provider.no-route': 'no_model',
  'provider.unknown': 'no_model',
  'permission.rejected': 'denied',
  'tool.execution': 'tool_failed',
}

const named = (table: Record<string, AgentFailure>, name: unknown) =>
  typeof name === 'string' && Object.hasOwn(table, name) ? table[name] : null

/** The failure an agent's error code names, from the `data` its ACP error carries. */
function codedFailure(error: unknown): AgentFailure | null {
  if (!(error instanceof acp.RequestError) || !isRecord(error.data)) return null
  const { data } = error
  // OpenCode's ACPInvalidModelError: -32602 with the model it couldn't find.
  if (error.code === -32602 && typeof data.modelId === 'string') return 'no_model'
  const info = data.codexErrorInfo
  const codex = isRecord(info) ? Object.keys(info)[0] : info
  return (
    named(CLAUDE_ERROR_KINDS, data.errorKind) ??
    named(CODEX_ERROR_INFO, codex) ??
    named(OPENCODE_ERROR_NAMES, data.errorName)
  )
}

/**
 * What a failed turn's error means, and its name for usage data; null when it isn't one Gui
 * knows. An agent's own error code wins, except the broad `bad_request`, which a known
 * provider error in its text (a prompt too long comes as a bad request) says more about.
 * `message` is the plain words to show, or null to keep the agent's own.
 */
export function agentFailure(
  error: unknown,
): { failure: AgentFailure; message: string | null } | null {
  const detail = errorDetail(error)
  const coded = codedFailure(error)
  const failure =
    (coded !== 'bad_request' ? coded : null) ??
    PLAIN_ERRORS.find(([pattern]) => pattern.test(detail))?.[1] ??
    coded ??
    AGENT_MESSAGES.find(([pattern]) => pattern.test(detail))?.[1]
  return failure ? { failure, message: PLAIN_MESSAGES[failure] ?? null } : null
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

/**
 * The MCP servers Gui may pass the agent: ACP lets a client send HTTP servers only to an
 * agent that advertises `mcpCapabilities.http`, so one without it gets none of Gui's tools.
 */
export function mcpServersFor(
  capabilities: acp.AgentCapabilities | null | undefined,
  servers: acp.McpServer[],
): acp.McpServer[] {
  const http = capabilities?.mcpCapabilities?.http === true
  return servers.filter((server) => http || !('type' in server && server.type === 'http'))
}

/** A question Gui can ask on its permission card: one pick from a list. */
export interface FormQuestion {
  id: string
  /** The field's title: often a short heading ("Base branch"), sometimes the question */
  title: string | undefined
  /** The field's description: the question in full, when the form says it here */
  description: string | undefined
  /** Each choice's label, and what it means when the agent says (Claude's AskUserQuestion) */
  choices: { value: string; name: string; description?: string }[]
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined)

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
    questions.push({
      id,
      title: isRecord(field) ? text(field.title) : undefined,
      description: isRecord(field) ? text(field.description) : undefined,
      choices,
    })
  }
  return questions.length ? questions : null
}

/** Not an ACP kind: the tool kind of an agent's own question, whose card shows its title as the question. */
export const QUESTION_KIND = 'question' as acp.ToolKind

/**
 * A permission request, or one of an agent's own questions put as one (`questionRequest`):
 * then what the form says beside the question, and what each choice means.
 */
export type PermissionRequest = Omit<acp.RequestPermissionRequest, 'options'> & {
  message?: string
  options: (acp.PermissionOption & { description?: string })[]
}

/**
 * One of a form's questions as a request for Gui's permission card: the question in full,
 * the form's message beside it when that says something else, and each choice with what it
 * means. Claude's AskUserQuestion puts a lone question in the form's message and only a short
 * heading in the field; with several, each field has its question and the message is the
 * form's own.
 */
export function questionRequest(
  sessionId: string,
  question: FormQuestion,
  message: string | undefined,
  /** One of several in the form: its message speaks for them all ("Please answer…"), so it isn't shown */
  several = false,
): PermissionRequest {
  const said = text(message)?.trim()
  const title = (
    question.description ??
    said ??
    question.title ??
    'The agent has a question'
  ).trim()
  return {
    sessionId,
    toolCall: {
      toolCallId: `question:${question.id}`,
      title,
      kind: QUESTION_KIND,
    },
    ...(said && said !== title && !several ? { message: said } : {}),
    // Skip first, so it reads as the agent's own question; Auto never answers one (`autoApproval`).
    options: [
      { optionId: 'skip', name: 'Skip', kind: 'reject_once' },
      ...question.choices.map((choice, index) => ({
        optionId: String(index),
        name: choice.name,
        kind: 'answer' as acp.PermissionOptionKind,
        ...(choice.description ? { description: choice.description } : {}),
      })),
    ],
  }
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
            ...(text(option.description) ? { description: text(option.description) } : {}),
          },
        ]
      : [],
  )
  if (oneOf.length) return oneOf
  const values = list(field.enum).filter((value): value is string => typeof value === 'string')
  return values.length ? values.map((value) => ({ value, name: value })) : null
}

/**
 * The model, effort and provider settings among an agent's session config options. Found by
 * category, since every agent names them differently (`effort`, `reasoning_effort`, …).
 * An agent may put other settings in the model category too (fx: its provider, and fast
 * mode, before the model), so one with the id `model` wins. The provider is one of those
 * others, named as one, with a choice to make. Null when the agent offers no model choice.
 */
export function parseModelSettings(
  configOptions: acp.SessionConfigOption[] | null | undefined,
): ModelSettings | null {
  const inModels = (option: Record<string, unknown>) => option.category === 'model'
  const named = (option: Record<string, unknown>, name: string) =>
    [option.id, option.name].some((text) => typeof text === 'string' && text.toLowerCase() === name)
  const found =
    findSetting(configOptions, (option) => inModels(option) && option.id === 'provider') ??
    findSetting(configOptions, (option) => inModels(option) && named(option, 'provider'))
  const provider = found && found.options.length > 1 ? found : null
  const model =
    findSetting(configOptions, (option) => inModels(option) && option.id === 'model') ??
    findSetting(configOptions, (option) => inModels(option) && option.id !== found?.id)
  if (!model) return null
  return { model, effort: selectSetting(configOptions, 'thought_level'), provider }
}

export function selectSetting(
  configOptions: acp.SessionConfigOption[] | null | undefined,
  category: string,
): AgentSetting | null {
  return findSetting(configOptions, (option) => option.category === category)
}

/** The first select config option `match` accepts, with its choices flattened. */
export function findSetting(
  configOptions: acp.SessionConfigOption[] | null | undefined,
  match: (option: Record<string, unknown>) => boolean,
): AgentSetting | null {
  // Custom agents can send anything; a malformed list mustn't break the session.
  if (!Array.isArray(configOptions)) return null
  for (const option of configOptions) {
    if (!isRecord(option) || !match(option) || option.type !== 'select') continue
    if (typeof option.currentValue !== 'string' || !Array.isArray(option.options)) continue
    const entries: unknown[] = option.options
    // Grouped lists (e.g. by provider) are flattened; each choice keeps its group's name.
    const options = entries.flatMap((entry): AgentSetting['options'] => {
      if (isChoice(entry)) return [{ value: entry.value, name: entry.name, group: null }]
      if (!isRecord(entry) || !Array.isArray(entry.options)) return []
      const group = typeof entry.name === 'string' ? entry.name : null
      const choices: unknown[] = entry.options
      return choices.filter(isChoice).map(({ value, name }) => ({ value, name, group }))
    })
    return { id: option.id, value: option.currentValue, options }
  }
  return null
}
