import type * as acp from '@agentclientprotocol/sdk'
import { MAX_SUBAGENT_SESSIONS } from '../shared/bounded'
import type { SubagentItem, SubagentStatus, TurnItem } from '../shared/types'

// Subagents, as the ACP subagents RFD exposes them to a client that declares
// `clientCapabilities.subagents`: each one is a child session of the session that started
// it. Claude's and Codex's adapters both send them this way. No Electron here, so tests can
// load it on its own.

type Update = acp.SessionNotification['update']
type SubagentUpdate = Extract<Update, { sessionUpdate: 'subagent_update' }>
type SessionMessage = Extract<Update, { sessionUpdate: 'session_message' }>

/** One update to show, and whose it is: a subagent's session id, or null for the agent's own. */
export interface Delivery {
  update: Update
  from: string | null
}

/**
 * What a subagent's own session shows in the chat: its words, its steps, the subagents it
 * starts, and the messages it trades. Its settings, commands and usage aren't the chat's.
 */
const CHILD_UPDATES = new Set<string>([
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'subagent_update',
  'session_message',
])

interface Child {
  /** The session that started it: the root, or another subagent */
  parent: string
  title: string | null
  description: string | null
  /** Its announcement reached the chat in this connection (a replay's doesn't) */
  told: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Omitted keeps the old value, null clears it (the RFD's patch rules). */
function patched(value: string | null | undefined, old: string | null) {
  if (value === undefined) return old
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * Which session each notification is about, for one agent session. Learns subagents from
 * `subagent_update` on the root or on a subagent it knows, and drops what comes from a
 * session it doesn't know, as the RFD has a client do.
 */
export class SubagentRouter {
  private root: string | null = null
  private children = new Map<string, Child>()

  /** The session being started or resumed; its subagents are forgotten when it changes. */
  setRoot(sessionId: string) {
    if (this.root === sessionId) return
    this.root = sessionId
    this.children.clear()
  }

  isChild(sessionId: unknown): sessionId is string {
    return typeof sessionId === 'string' && this.children.has(sessionId)
  }

  /** null for the root, the session id for a subagent, undefined for a session it doesn't know. */
  owner(sessionId: string): string | null | undefined {
    if (sessionId === this.root) return null
    return this.children.has(sessionId) ? sessionId : undefined
  }

  /**
   * What to deliver for an update on `sessionId`, in order; empty to drop it. `live` is false
   * while a session loads, when the agent replays its history: Gui keeps its own transcript,
   * so nothing is shown, but the subagents it announces are remembered (the agent won't
   * announce them again if they're handed more work later).
   */
  route(sessionId: string, update: Update, live: boolean): Delivery[] {
    const from = this.owner(sessionId)
    if (from === undefined) return []
    if (from === null && isChildModel(update)) return []
    if (from !== null && !CHILD_UPDATES.has(update.sessionUpdate)) return []
    if (update.sessionUpdate === 'subagent_update') {
      const child = this.remember(sessionId, update)
      if (!live) return []
      child.told = true
      return [...this.announceParents(from), { update: this.complete(update, child), from }]
    }
    if (!live) return []
    return [...this.announceParents(sessionId === this.root ? null : sessionId), { update, from }]
  }

  private remember(parent: string, update: SubagentUpdate): Child {
    const old = this.children.get(update.sessionId)
    const child: Child = {
      parent: old?.parent ?? parent,
      title: patched(update.title, old?.title ?? null),
      description: patched(update.description, old?.description ?? null),
      told: old?.told ?? false,
    }
    // Newest last, so the oldest goes first past the cap.
    this.children.delete(update.sessionId)
    this.children.set(update.sessionId, child)
    if (this.children.size > MAX_SUBAGENT_SESSIONS) {
      const oldest = this.children.keys().next().value
      if (oldest !== undefined) this.children.delete(oldest)
    }
    return child
  }

  /** The update with the labels Gui knows filled in, so the chat never sees a title go missing. */
  private complete(update: SubagentUpdate, child: Child): SubagentUpdate {
    return { ...update, title: child.title, description: child.description }
  }

  /**
   * Announcements the chat hasn't had for `sessionId` and the subagents above it (they were
   * announced while a session loaded), outermost first. Empty for the root.
   */
  private announceParents(sessionId: string | null): Delivery[] {
    if (sessionId === null) return []
    const child = this.children.get(sessionId)
    if (!child || child.told) return []
    child.told = true
    const parent = child.parent === this.root ? null : child.parent
    const update: SubagentUpdate = {
      sessionUpdate: 'subagent_update',
      sessionId,
      title: child.title,
      description: child.description,
    }
    return [...this.announceParents(parent), { update, from: parent }]
  }
}

/**
 * Claude reports a subagent's model on the root session, as a one-choice model setting with
 * the subagent's tool use id in `_meta`. It's not the session's own model.
 */
function isChildModel(update: Update) {
  if (update.sessionUpdate !== 'config_option_update') return false
  const claude = update._meta?.claudeCode
  return isRecord(claude) && typeof claude.parentToolUseId === 'string'
}

/** The text of a message's content, or null when it has none. */
export function messageText(content: acp.ContentBlock[] | null | undefined): string | null {
  if (!Array.isArray(content)) return null
  const text = content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n\n')
    .trim()
  return text || null
}

/**
 * What a session message is to the chat: the task a subagent was given (sent to it by
 * another session), or what it answered (sent by it to another). The agent may send both the
 * sender's and the recipient's copy of one message; they mean the same thing here. Null for
 * a message between sessions the chat doesn't know as subagents.
 */
export function sessionMessageRole(
  update: SessionMessage,
  isChild: (sessionId: string) => boolean,
): { subagent: string; role: 'prompt' | 'answer' } | null {
  const { senderSessionId: sender, recipientSessionId: recipient } = update
  if (recipient && recipient !== sender && isChild(recipient)) {
    return { subagent: recipient, role: 'prompt' }
  }
  if (sender && sender !== recipient && isChild(sender)) return { subagent: sender, role: 'answer' }
  return null
}

/** Why it failed, from an idle state's `error`: a JSON-RPC error (Claude's adapter), or text. */
function stateError(state: Record<string, unknown>): string | null {
  const error = state.error
  if (typeof error === 'string' && error.trim()) return error.trim()
  if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim()
  }
  return null
}

/**
 * A `subagent_update`'s changes to the subagent's item. Omitted fields keep what the item
 * has. `idle` ends its work: done, stopped (cancelled), or failed (error, with why); an idle
 * state with no reason ended without a cancellation or failure the agent saw, so it's done.
 * `unknown`: the agent can't see it anymore, so it's no longer shown as working.
 */
export function subagentPatch(
  update: SubagentUpdate,
  now: number,
): Partial<Pick<SubagentItem, 'status' | 'error' | 'canStop' | 'endedAt'>> {
  const patch: Partial<Pick<SubagentItem, 'status' | 'error' | 'canStop' | 'endedAt'>> = {}
  if (update.capabilities !== undefined) patch.canStop = isRecord(update.capabilities?.cancel)
  const state: unknown = update.state
  if (!isRecord(state) || typeof state.state !== 'string') return patch
  const status = subagentStatus(state)
  if (!status) return patch
  patch.status = status
  patch.error = status === 'failed' ? (stateError(state) ?? null) : null
  patch.endedAt = status === 'running' || status === 'waiting' ? null : now
  return patch
}

function subagentStatus(state: Record<string, unknown>): SubagentStatus | null {
  switch (state.state) {
    case 'running':
      return 'running'
    case 'requires_action':
      return 'waiting'
    case 'idle':
      return state.stopReason === 'cancelled'
        ? 'stopped'
        : state.stopReason === 'error'
          ? 'failed'
          : 'done'
    case 'unknown':
      return 'stopped'
    default:
      return null
  }
}

/** Whether an item belongs to `owner`'s level of the transcript: a subagent's, or the agent's own (null). */
export const ownedBy = (item: TurnItem, owner: string | null) => (item.subagent ?? null) === owner

/**
 * The subagent's steps past `max`, oldest first, as indexes into `items`, so the caller can
 * drop them. Its permission questions stay (they're the user's answers), and so do the
 * subagents it started, which hold steps of their own.
 */
export function overflowingSteps(items: TurnItem[], subagent: string, max: number): number[] {
  const steps: number[] = []
  items.forEach((item, index) => {
    const step = item.kind !== 'permission' && item.kind !== 'subagent'
    if (item.subagent === subagent && step) steps.push(index)
  })
  return steps.length > max ? steps.slice(0, steps.length - max) : []
}

/**
 * The subagent's closing words, when they're also the answer it handed back: Claude's
 * adapter sends both, and the answer is what the chat shows. The index into `items`, or -1.
 */
export function echoedAnswer(items: TurnItem[], subagent: string, answer: string): number {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]
    if (item.subagent !== subagent || item.kind === 'permission') continue
    return item.kind === 'text' && item.text.trim() === answer.trim() ? index : -1
  }
  return -1
}
