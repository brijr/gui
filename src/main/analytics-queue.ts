import { bounded, MAX_QUEUED_USAGE_EVENTS, USAGE_BATCH } from '../shared/bounded'
import { AGENTS, type AgentId, type TurnStatus } from '../shared/types'
import { TimeoutError } from './errors'

/**
 * Why an agent failed, as Gui tells it apart (errors.ts `AgentError`, agent.ts, and
 * agent-protocol.ts `agentFailure`, which reads the agents' own error codes first): signed
 * out, a CLI too old for Gui, the agent's process quit, a known provider error, or:
 *
 * no_model: the agent has no model it can use (none set up, or the one picked isn't there).
 * bad_request: the agent's servers refused the request as one they can't take.
 * timeout: the agent didn't start in time, or its servers stopped answering.
 * dropped: the connection to the agent's servers broke partway through the answer.
 * denied: the user declined what the agent asked to do, and the agent ended the turn.
 * tool_failed: a tool the agent ran failed, and the agent ended the turn.
 * not_installed: the agent wasn't there to start.
 */
export const AGENT_FAILURES = [
  'signed_out',
  'too_old',
  'agent_quit',
  'context_too_long',
  'no_credit',
  'servers_busy',
  'rate_limited',
  'server_error',
  'offline',
  'no_model',
  'bad_request',
  'timeout',
  'dropped',
  'denied',
  'tool_failed',
  'not_installed',
] as const
export type AgentFailure = (typeof AGENT_FAILURES)[number]

/** Why a turn failed: one of AGENT_FAILURES, or `other` for an error Gui doesn't tell apart. */
export type TurnFailure = AgentFailure | 'other'

/**
 * Where a failed turn was (`turnStage`): `start` before the agent answered at all, `tool`
 * while one of its tool calls was running, `reply` while it was answering otherwise.
 */
export const TURN_STAGES = ['start', 'reply', 'tool'] as const
export type TurnStage = (typeof TURN_STAGES)[number]

/**
 * Why an installed agent couldn't be used, as its check found (agent-status.ts): not signed
 * in, a CLI too old for Gui, its process quit as it started, it couldn't reach its servers,
 * the check (or reading its version) ran out of time, or `error` for anything else.
 */
export const AGENT_UNAVAILABLE = [
  'signed_out',
  'too_old',
  'agent_quit',
  'offline',
  'timeout',
  'error',
] as const
export type AgentUnavailable = (typeof AGENT_UNAVAILABLE)[number]

/**
 * Why the user's app didn't come up (tab.ts): its dependencies didn't install, the package
 * manager its commands need isn't there, its start command exited before the app was up, or
 * it couldn't be started at all.
 */
export type AppStartFailure = 'install_failed' | 'command_missing' | 'exited' | 'other'

/**
 * The framework a project's start command runs (project.ts `startFramework`): `none` with no
 * start command, `unknown` while a monorepo's app is still to be picked.
 */
export const FRAMEWORKS = [
  'next',
  'vite',
  'astro',
  'nuxt',
  'remix',
  'react-router',
  'angular',
  'gatsby',
  'react-scripts',
  'docusaurus',
  'vitepress',
  'parcel',
  'webpack',
  'vinxi',
] as const
export type Framework = (typeof FRAMEWORKS)[number] | 'other' | 'none' | 'unknown'

/**
 * Why an update failed (updates.ts), from the error electron-updater or Squirrel.Mac raised:
 * see `updateFailure` for what each one is.
 */
export const UPDATE_FAILURES = [
  'offline',
  'dropped',
  'timeout',
  'http',
  'checksum',
  'signature',
  'disk_full',
  'permission',
  'read_only',
  'other',
] as const
export type UpdateFailure = (typeof UPDATE_FAILURES)[number]

/** Who decides what the agent may do without asking: Gui's Ask or Auto, or the agent's own settings. */
export type TurnMode = 'ask' | 'auto' | 'own'

type YesNo = 'yes' | 'no'

/**
 * Every usage event Gui sends, and what each carries: every value is a short name from a
 * fixed list here, or (`app_opened`, `update_installed`) Gui's own version and the OS. Nothing
 * else is ever sent: no paths, project or file names, addresses, commands, prompts, replies,
 * error messages, or code. usegui.com (www/worker.js) keeps the same lists and drops anything
 * that isn't on them.
 */
export interface UsageEvents {
  app_opened: { version: string; os: string; osVersion: string; arch: string }
  /**
   * `agent`: a built-in agent's id, or `custom`; `provider`: its model provider, if it has one;
   * `reason` and `stage`: why and where it failed, only when it did; `picked`: the message carried a picked element;
   * `tools`: the agent called Gui's own tools; `mode`: who decided what it may do.
   */
  turn_finished: {
    agent: string
    outcome: 'done' | 'failed' | 'stopped'
    provider?: string
    reason?: TurnFailure
    stage?: TurnStage
    picked: YesNo
    tools: YesNo
    mode: TurnMode
  }
  project_opened: { framework: Framework }
  canvas_created: undefined
  preview_opened: undefined
  /** The user's app didn't start; once per reason each time a project is opened */
  app_start_failed: { reason: AppStartFailure }
  agent_connected: { agent: string }
  /**
   * An installed agent's check failed; once per agent and reason each launch. `current`: it
   * was the agent in use (agent-status.ts `inUse`), not one merely installed.
   */
  agent_unavailable: { agent: string; reason: AgentUnavailable; current: YesNo }
  update_installed: { from: string; to: string }
  /** A new version was found but didn't download, or Squirrel.Mac couldn't install it, and why */
  update_failed: { stage: 'download' | 'install'; reason: UpdateFailure }
}
export type UsageEventName = keyof UsageEvents
export type UsageProps<E extends UsageEventName> = UsageEvents[E] extends undefined
  ? []
  : [props: UsageEvents[E]]

/** An agent as usage data has it: a built-in agent's id; one from agents.json is `custom`. */
export function usageAgent(id: AgentId) {
  return AGENTS.some((agent) => agent.id === id) ? id : 'custom'
}

/** A provider setting's value is a short name (`codex`, `grok`); anything else isn't sent. */
const PROVIDER = /^[a-z][\w-]{0,39}$/i

/**
 * Why a turn failed, from the error it ended with: an AgentFailure it carries, `timeout` for
 * something Gui ran out of time waiting on, else `other`.
 */
export function turnFailure(error: unknown): TurnFailure {
  if (error instanceof TimeoutError) return 'timeout'
  const failure = (error as { failure?: unknown } | null)?.failure
  return (AGENT_FAILURES as readonly unknown[]).includes(failure)
    ? (failure as AgentFailure)
    : 'other'
}

/** Why an agent's check failed, from its error: one of AGENT_UNAVAILABLE, else `error`. */
export function agentUnavailable(error: unknown): AgentUnavailable {
  const failure = turnFailure(error)
  return (AGENT_UNAVAILABLE as readonly string[]).includes(failure)
    ? (failure as AgentUnavailable)
    : 'error'
}

/** Node's error codes (fs, sockets, DNS) and what each says about an update that failed. */
const NODE_CODES: Record<string, UpdateFailure> = {
  ENOTFOUND: 'offline',
  EAI_AGAIN: 'offline',
  ECONNREFUSED: 'offline',
  ENETDOWN: 'offline',
  ENETUNREACH: 'offline',
  EHOSTUNREACH: 'offline',
  ECONNRESET: 'dropped',
  ECONNABORTED: 'dropped',
  EPIPE: 'dropped',
  ETIMEDOUT: 'timeout',
  ESOCKETTIMEDOUT: 'timeout',
  ENOSPC: 'disk_full',
  EDQUOT: 'disk_full',
  EACCES: 'permission',
  EPERM: 'permission',
  EROFS: 'read_only',
  // builder-util-runtime's DigestTransform: the download's sha512 isn't the feed's.
  ERR_CHECKSUM_MISMATCH: 'checksum',
}

/**
 * Chromium's network errors. electron-updater downloads with Electron's `net`, whose errors
 * carry no code, only a message naming one (`net::ERR_INTERNET_DISCONNECTED`).
 */
const NET_ERRORS: Record<string, UpdateFailure> = {
  ERR_INTERNET_DISCONNECTED: 'offline',
  ERR_NAME_NOT_RESOLVED: 'offline',
  ERR_NAME_RESOLUTION_FAILED: 'offline',
  ERR_ADDRESS_UNREACHABLE: 'offline',
  ERR_CONNECTION_REFUSED: 'offline',
  ERR_CONNECTION_FAILED: 'offline',
  ERR_PROXY_CONNECTION_FAILED: 'offline',
  ERR_NETWORK_CHANGED: 'dropped',
  ERR_NETWORK_IO_SUSPENDED: 'dropped',
  ERR_CONNECTION_RESET: 'dropped',
  ERR_CONNECTION_CLOSED: 'dropped',
  ERR_CONNECTION_ABORTED: 'dropped',
  ERR_EMPTY_RESPONSE: 'dropped',
  ERR_CONTENT_LENGTH_MISMATCH: 'dropped',
  ERR_INCOMPLETE_CHUNKED_ENCODING: 'dropped',
  ERR_HTTP2_PROTOCOL_ERROR: 'dropped',
  ERR_TIMED_OUT: 'timeout',
  ERR_CONNECTION_TIMED_OUT: 'timeout',
  ERR_FILE_NO_SPACE: 'disk_full',
  ERR_ACCESS_DENIED: 'permission',
}

/**
 * Errors that carry no code, only a message. Each pattern is narrow, and none of the message
 * is ever sent, only the name it maps to.
 */
const MESSAGES: [RegExp, UpdateFailure][] = [
  // builder-util-runtime's socket timeout: `new Error("Request timed out")`.
  [/^Request timed out$/, 'timeout'],
  // builder-util-runtime's X-Checksum-Sha2 check: `checksum mismatch: expected …`.
  [/^checksum mismatch\b/, 'checksum'],
  // Squirrel.Mac (SQRLUpdater, SQRLCodeSignature) gives an NSError's description, never a
  // code: "Code signature at URL … did not pass validation", "Could not get code signature
  // for running application", "… code failed to satisfy specified code requirement(s)".
  [/code signature|code requirement/i, 'signature'],
  // "Cannot update while running on a read-only volume", or POSIX EROFS's text.
  [/read-only (volume|file system)/i, 'read_only'],
  // POSIX ENOSPC's text, as an NSPOSIXErrorDomain error describes it.
  [/no space left on device/i, 'disk_full'],
  // POSIX EACCES's and EPERM's texts.
  [/permission denied|operation not permitted/i, 'permission'],
]

/**
 * Why an update failed, from what electron-updater or Squirrel.Mac raised: a code where the
 * error has one, else a narrow match on its message, else `other`. Only the name is sent.
 *
 * offline: the server couldn't be reached at all. dropped: the connection broke partway.
 * timeout: it stopped answering. http: the server answered with an error status. checksum:
 * the file that came isn't the one the feed lists. signature: Squirrel.Mac refused the new
 * version's code signature. disk_full, permission, read_only: the file couldn't be written.
 */
export function updateFailure(error: unknown): UpdateFailure {
  if (!error || typeof error !== 'object') return 'other'
  const { code, statusCode, message } = error as {
    code?: unknown
    statusCode?: unknown
    message?: unknown
  }
  if (typeof code === 'string') {
    if (Object.hasOwn(NODE_CODES, code)) return NODE_CODES[code]
    // builder-util-runtime's HttpError: `code` is `HTTP_ERROR_<status>`.
    if (/^HTTP_ERROR_\d+$/.test(code)) return 'http'
  }
  if (typeof statusCode === 'number' && statusCode >= 400) return 'http'
  if (typeof message !== 'string') return 'other'
  const net = /\bnet::(ERR_[A-Z0-9_]+)\b/.exec(message)?.[1]
  if (net) return Object.hasOwn(NET_ERRORS, net) ? NET_ERRORS[net] : 'other'
  return MESSAGES.find(([pattern]) => pattern.test(message))?.[1] ?? 'other'
}

/** What Gui knows of a turn as it fails: whether the prompt went, and what the agent sent. */
export interface TurnProgress {
  /** Gui sent the prompt (session/prompt) */
  prompted: boolean
  /** The turn's items so far, the agent's and Gui's notices */
  items: readonly { kind: string; status?: string }[]
}

/**
 * Where a turn failed: `start` before the agent sent anything for it (Gui never sent the
 * prompt, or the agent failed it straight away), `tool` with one of its tool calls still
 * running, else `reply`. Gui's own notices and the user's steering aren't the agent's.
 */
export function turnStage({ prompted, items }: TurnProgress): TurnStage {
  const answered = items.filter((item) => item.kind !== 'notice' && item.kind !== 'steer')
  if (!prompted || answered.length === 0) return 'start'
  const running = answered.some(
    (item) => item.kind === 'tool' && (item.status === 'pending' || item.status === 'in_progress'),
  )
  return running ? 'tool' : 'reply'
}

/** What a turn was like, beside how it ended. */
export interface TurnUsage {
  /** The agent's model provider setting, if it has one */
  provider?: string
  /** The error it failed with */
  error?: unknown
  /** Where it failed (`turnStage`), when it did */
  stage?: TurnStage
  /** It carried an element picked in the preview */
  picked: boolean
  /** The agent called one of Gui's own tools */
  tools: boolean
  /** The project's Auto setting, and whether the agent's own settings decide instead */
  autoApprove: boolean
  ownPermissions: boolean
}

export function turnUsage(
  agent: AgentId,
  status: TurnStatus,
  turn: TurnUsage,
): UsageEvents['turn_finished'] {
  const outcome = status === 'done' ? 'done' : status === 'error' ? 'failed' : 'stopped'
  const { provider } = turn
  return {
    agent: usageAgent(agent),
    outcome,
    ...(provider && PROVIDER.test(provider) ? { provider } : {}),
    ...(outcome === 'failed' ? { reason: turnFailure(turn.error) } : {}),
    ...(outcome === 'failed' && turn.stage ? { stage: turn.stage } : {}),
    picked: turn.picked ? 'yes' : 'no',
    tools: turn.tools ? 'yes' : 'no',
    mode: turn.ownPermissions ? 'own' : turn.autoApprove ? 'auto' : 'ask',
  }
}

interface Queued {
  event: UsageEventName
  /** When it happened, ms since the epoch */
  at: number
  props?: Record<string, string>
}

/** What a send got back: enough of a fetch Response. */
export interface UsageReply {
  status: number
  json(): Promise<unknown>
}

export interface UsageQueueOptions {
  /** An official release (official-build.ts); every other build never sends */
  official: boolean
  /** Settings → Account → Share usage data */
  enabled(): boolean
  /** The install's random ID, read (or made) the first time a batch goes */
  installId(): string
  /** POSTs `body` to usegui.com/t/v1 */
  post(body: string, signal: AbortSignal): Promise<UsageReply>
  now?: () => number
}

/**
 * Usage events, held in memory until a flush sends them in batches. Bounded: past
 * MAX_QUEUED_USAGE_EVENTS the oldest go, whether they were never sent or a send failed and
 * kept them for the next try. A batch the site refused isn't tried again. The site can say
 * `{ stop: true }`, after which nothing more is kept or sent until Gui next launches.
 */
export function usageQueue(options: UsageQueueOptions) {
  const now = options.now ?? Date.now
  let queue: Queued[] = []
  let stopped = false
  let sending: Promise<void> | null = null

  const sends = () => options.official && !stopped && options.enabled()

  const keep = (events: Queued[]) => {
    queue = bounded(events, MAX_QUEUED_USAGE_EVENTS)
  }

  /** Sends what's queued, a batch at a time, until it's all sent or a send fails. */
  async function send(signal: AbortSignal) {
    while (queue.length > 0 && sends() && !signal.aborted) {
      const batch = queue.slice(0, USAGE_BATCH)
      queue = queue.slice(batch.length)
      const body = JSON.stringify({ installId: options.installId(), events: batch })
      let reply: UsageReply
      try {
        reply = await options.post(body, signal)
      } catch {
        // Offline, or the quit's wait ran out: tried again at the next flush.
        keep([...batch, ...queue])
        return
      }
      if (reply.status >= 500 || reply.status === 429) {
        keep([...batch, ...queue])
        return
      }
      // Anything else that isn't a success is a batch the site won't take; it's dropped.
      if (reply.status === 200) {
        const answer = await reply.json().catch(() => null)
        if (answer && typeof answer === 'object' && (answer as { stop?: unknown }).stop === true) {
          stopped = true
          queue = []
        }
      }
    }
  }

  return {
    track<E extends UsageEventName>(event: E, ...[props]: UsageProps<E>) {
      if (!sends()) return
      keep([...queue, props ? { event, at: now(), props: { ...props } } : { event, at: now() }])
    },

    /** Sends what's queued; a flush already under way is joined. `timeoutMs` bounds it. */
    flush(timeoutMs = 10_000): Promise<void> {
      if (!sends()) {
        queue = []
        return Promise.resolve()
      }
      sending ??= send(AbortSignal.timeout(timeoutMs)).finally(() => {
        sending = null
      })
      return sending
    },

    /** Share usage data switched off: what's queued goes at once. */
    clear() {
      queue = []
    },

    /** Events waiting to be sent */
    get size() {
      return queue.length
    },

    /** The site said to stop for this launch. */
    get stopped() {
      return stopped
    },
  }
}

export type UsageQueue = ReturnType<typeof usageQueue>
