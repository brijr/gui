import { bounded, MAX_QUEUED_USAGE_EVENTS, USAGE_BATCH } from '../shared/bounded'
import { AGENTS, type AgentId, type TurnStatus } from '../shared/types'

/**
 * Why an agent failed, as Gui already tells it apart (errors.ts `AgentError`, agent.ts):
 * signed out, a CLI too old for Gui, the agent's process quit, or one of the known turn
 * errors (agent-protocol.ts `PLAIN_ERRORS`).
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
] as const
export type AgentFailure = (typeof AGENT_FAILURES)[number]

/** Why a turn failed: one of AGENT_FAILURES, or `other` for an error Gui doesn't tell apart. */
export type TurnFailure = AgentFailure | 'other'

/** Why an installed agent couldn't be used, as its check found (agent-status.ts). */
export type AgentUnavailable = 'signed_out' | 'too_old' | 'error'

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
   * `reason`: why it failed, only when it did; `picked`: the message carried a picked element;
   * `tools`: the agent called Gui's own tools; `mode`: who decided what it may do.
   */
  turn_finished: {
    agent: string
    outcome: 'done' | 'failed' | 'stopped'
    provider?: string
    reason?: TurnFailure
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
  /** An installed agent's check failed; once per agent and reason each launch */
  agent_unavailable: { agent: string; reason: AgentUnavailable }
  update_installed: { from: string; to: string }
  /** A new version was found but didn't download, or Squirrel.Mac couldn't install it */
  update_failed: { stage: 'download' | 'install' }
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

/** Why a turn failed, from the error it ended with: an AgentFailure it carries, else `other`. */
export function turnFailure(error: unknown): TurnFailure {
  const failure = (error as { failure?: unknown } | null)?.failure
  return (AGENT_FAILURES as readonly unknown[]).includes(failure)
    ? (failure as AgentFailure)
    : 'other'
}

/** Why an agent's check failed, from its error: signed out, too old, or anything else. */
export function agentUnavailable(error: unknown): AgentUnavailable {
  const failure = turnFailure(error)
  return failure === 'signed_out' || failure === 'too_old' ? failure : 'error'
}

/** What a turn was like, beside how it ended. */
export interface TurnUsage {
  /** The agent's model provider setting, if it has one */
  provider?: string
  /** The error it failed with */
  error?: unknown
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
