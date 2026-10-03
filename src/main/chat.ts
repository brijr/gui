import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { isAbsolute, relative } from 'node:path'
import type { RequestPermissionRequest, SessionNotification } from '@agentclientprotocol/sdk'
import {
  AGENTS,
  type AgentId,
  type ChatMeta,
  type ChatSnapshot,
  type ElementContext,
  type ToolStatus,
  type Turn,
  type TurnItem,
} from '../shared/types'
import { type AgentInfo, AgentSession, type PermissionResolver } from './agent'
import type { Checkpoints } from './checkpoints'
import { buildPrompt } from './prompt'

type SessionUpdate = SessionNotification['update']

interface ChatEvents {
  meta: [meta: ChatMeta]
  turn: [turn: Turn]
  reset: [snapshot: ChatSnapshot]
}

interface TurnRecord {
  turn: Turn
  before: string | null
  after: string | null
}

interface RedoPoint {
  sha: string
  paths: string[]
  turnIds: string[]
}

const agentName = (id: AgentId) => AGENTS.find((agent) => agent.id === id)?.name ?? id
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Owns the conversation with one agent: turns, streaming updates, permissions, and checkpoints. */
export class ChatController extends EventEmitter<ChatEvents> {
  meta: ChatMeta
  private records: TurnRecord[] = []
  private agent: AgentSession | null = null
  private agentInfo: AgentInfo | null = null
  private primed = false
  private active: TurnRecord | null = null
  private permissions = new Map<string, PermissionResolver>()
  private emitTimers = new Map<string, NodeJS.Timeout>()
  private redoPoint: RedoPoint | null = null

  constructor(
    private readonly root: string,
    private readonly checkpoints: Checkpoints,
    agentId: AgentId,
  ) {
    super()
    this.meta = {
      agentId,
      agentName: agentName(agentId),
      status: 'idle',
      error: null,
      modeName: null,
      selection: null,
      minimized: false,
      canRedo: false,
    }
  }

  snapshot(): ChatSnapshot {
    return { meta: this.meta, turns: this.records.map((record) => record.turn) }
  }

  get running() {
    return this.active !== null
  }

  setAgent(agentId: AgentId) {
    if (agentId === this.meta.agentId) return
    this.reset()
    this.patchMeta({ agentId, agentName: agentName(agentId) })
  }

  /** Drops the agent process and transcript; the next message starts a fresh session. */
  reset() {
    void this.cancel()
    this.stopAgent()
    this.active = null
    this.records = []
    this.redoPoint = null
    this.patchMeta({ status: 'idle', error: null, modeName: null, canRedo: false })
    this.emit('reset', this.snapshot())
  }

  setSelection(selection: ElementContext | null) {
    this.patchMeta({ selection })
  }

  setMinimized(minimized: boolean) {
    this.patchMeta({ minimized })
  }

  async send(text: string) {
    const prompt = text.trim()
    if (!prompt || this.active) return

    const selection = this.meta.selection
    const record: TurnRecord = {
      turn: {
        id: randomUUID(),
        index: this.records.length,
        prompt,
        context: selection ? { ...selection, screenshot: null } : null,
        items: [],
        status: 'running',
        error: null,
        startedAt: Date.now(),
        endedAt: null,
        changes: null,
        reverted: false,
      },
      before: null,
      after: null,
    }
    this.records.push(record)
    this.active = record
    this.redoPoint = null
    this.patchMeta({ selection: null, canRedo: false })
    this.flushTurn(record)

    try {
      const info = await this.ensureAgent()
      record.before = await this.trySnapshot(record, `before turn ${record.turn.index + 1}`)
      this.patchMeta({ status: 'working' })
      const blocks = buildPrompt({
        text: prompt,
        selection,
        preamble: !this.primed,
        images: info.supportsImages,
      })
      this.primed = true
      const agent = this.agent
      if (!agent) throw new Error('Agent stopped before the prompt was sent')
      const response = await agent.prompt(blocks)
      record.turn.status = response.stopReason === 'cancelled' ? 'cancelled' : 'done'
      if (response.stopReason === 'refusal' || response.stopReason === 'max_tokens') {
        this.pushItem(record, {
          kind: 'notice',
          id: randomUUID(),
          tone: 'error',
          text:
            response.stopReason === 'refusal'
              ? 'The agent declined this request.'
              : 'The agent hit its output limit.',
        })
      }
    } catch (error) {
      record.turn.status = 'error'
      record.turn.error = errorMessage(error)
    } finally {
      this.resolvePendingPermissions(record)
      if (record.before) {
        record.after = await this.trySnapshot(record, `after turn ${record.turn.index + 1}`)
        if (record.after) {
          record.turn.changes = await this.checkpoints
            .diff(record.before, record.after)
            .catch(() => null)
        }
      }
      record.turn.endedAt = Date.now()
      if (this.active === record) this.active = null
      this.flushTurn(record)
      if (this.meta.status === 'working') this.patchMeta({ status: 'ready' })
    }
  }

  async cancel() {
    const record = this.active
    if (!record) return
    this.resolvePendingPermissions(record)
    await this.agent?.cancel().catch(() => undefined)
  }

  respondPermission(turnId: string, itemId: string, optionId: string | null) {
    const key = `${turnId}:${itemId}`
    const resolve = this.permissions.get(key)
    if (!resolve) return
    this.permissions.delete(key)
    resolve(optionId)
    const record = this.records.find((r) => r.turn.id === turnId)
    const item = record?.turn.items.find((i) => i.id === itemId)
    if (record && item?.kind === 'permission') {
      item.resolved = optionId ?? 'cancelled'
      this.flushTurn(record)
    }
  }

  /** Restores every file changed since this turn began, so this turn and later ones are undone. */
  async restoreTurn(turnId: string) {
    if (this.active) throw new Error('Wait for the agent to finish before restoring')
    const record = this.records.find((r) => r.turn.id === turnId)
    if (!record?.before) throw new Error('No checkpoint for this turn')

    const current = await this.checkpoints.snapshot(
      `before restoring turn ${record.turn.index + 1}`,
    )
    const changes = await this.checkpoints.diff(record.before, current)
    const paths = changes.map((change) => change.path)
    await this.checkpoints.restore(record.before, paths)

    const undone = this.records.filter((r) => r.turn.index >= record.turn.index && !r.turn.reverted)
    for (const r of undone) {
      r.turn.reverted = true
      this.flushTurn(r)
    }
    this.redoPoint = { sha: current, paths, turnIds: undone.map((r) => r.turn.id) }
    this.patchMeta({ canRedo: true })
  }

  async redo() {
    const point = this.redoPoint
    if (!point || this.active) return
    await this.checkpoints.restore(point.sha, point.paths)
    for (const r of this.records) {
      if (!point.turnIds.includes(r.turn.id)) continue
      r.turn.reverted = false
      this.flushTurn(r)
    }
    this.redoPoint = null
    this.patchMeta({ canRedo: false })
  }

  dispose() {
    for (const timer of this.emitTimers.values()) clearTimeout(timer)
    this.emitTimers.clear()
    for (const resolve of this.permissions.values()) resolve(null)
    this.permissions.clear()
    this.stopAgent()
    this.removeAllListeners()
  }

  private async ensureAgent(): Promise<AgentInfo> {
    if (this.agent && this.agentInfo) return this.agentInfo
    this.stopAgent()
    this.patchMeta({ status: 'starting', error: null })
    const agent = new AgentSession(this.meta.agentId, this.root, {
      onUpdate: (update) => this.onUpdate(update),
      onPermission: (request, resolve) => this.onPermission(request, resolve),
      onExit: (error) => this.onAgentExit(agent, error),
    })
    this.agent = agent
    try {
      const info = await agent.start()
      if (this.agent !== agent) throw new Error('Agent was replaced while starting')
      this.agentInfo = info
      this.patchMeta({ status: 'ready', modeName: info.modeName })
      return info
    } catch (error) {
      if (this.agent === agent) this.stopAgent()
      this.patchMeta({ status: 'error', error: errorMessage(error) })
      throw error
    }
  }

  private stopAgent() {
    this.agent?.dispose()
    this.agent = null
    this.agentInfo = null
    this.primed = false
  }

  private onAgentExit(agent: AgentSession, error: string | null) {
    if (this.agent !== agent) return
    this.agent = null
    this.agentInfo = null
    this.primed = false
    this.patchMeta({ status: 'error', error })
  }

  private onUpdate(update: SessionUpdate) {
    const record = this.active
    if (!record) {
      if (update.sessionUpdate === 'current_mode_update') this.updateMode(update.currentModeId)
      return
    }
    const items = record.turn.items
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        if (update.content.type !== 'text') break
        const kind = update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thought'
        const last = items.at(-1)
        if (last && last.kind === kind) last.text += update.content.text
        else items.push({ kind, id: randomUUID(), text: update.content.text })
        break
      }
      case 'tool_call': {
        items.push({
          kind: 'tool',
          id: update.toolCallId,
          title: this.relativize(update.title),
          toolKind: update.kind ?? 'other',
          status: update.status ?? 'pending',
          locations: (update.locations ?? []).map((l) => this.displayPath(l.path, l.line)),
        })
        break
      }
      case 'tool_call_update': {
        const item = items.find((i) => i.kind === 'tool' && i.id === update.toolCallId)
        if (item?.kind !== 'tool') break
        if (update.title) item.title = this.relativize(update.title)
        if (update.kind) item.toolKind = update.kind
        if (update.status) item.status = update.status as ToolStatus
        if (update.locations) {
          item.locations = update.locations.map((l) => this.displayPath(l.path, l.line))
        }
        break
      }
      case 'plan': {
        const entries = update.entries.map(({ content, status }) => ({ content, status }))
        const plan = items.find((i) => i.kind === 'plan')
        if (plan?.kind === 'plan') plan.entries = entries
        else items.push({ kind: 'plan', id: randomUUID(), entries })
        break
      }
      case 'notice': {
        const text = [update.title, update.description].filter(Boolean).join(' — ')
        const tone = update.severity === 'error' ? 'error' : 'info'
        items.push({ kind: 'notice', id: randomUUID(), text, tone })
        break
      }
      case 'current_mode_update':
        this.updateMode(update.currentModeId)
        return
      default:
        return
    }
    this.scheduleTurn(record)
  }

  private onPermission(request: RequestPermissionRequest, resolve: PermissionResolver) {
    const record = this.active
    if (!record) {
      resolve(null)
      return
    }
    const id = randomUUID()
    this.permissions.set(`${record.turn.id}:${id}`, resolve)
    this.pushItem(record, {
      kind: 'permission',
      id,
      title: request.toolCall.title ?? 'The agent wants to run a tool',
      options: request.options.map(({ optionId, name, kind }) => ({ optionId, name, kind })),
      resolved: null,
    })
  }

  private resolvePendingPermissions(record: TurnRecord) {
    for (const item of record.turn.items) {
      if (item.kind === 'permission' && item.resolved === null) {
        this.respondPermission(record.turn.id, item.id, null)
      }
    }
  }

  private updateMode(modeId: string) {
    const name = this.agentInfo?.modes.find((mode) => mode.id === modeId)?.name ?? modeId
    this.patchMeta({ modeName: name })
  }

  private async trySnapshot(record: TurnRecord, message: string) {
    try {
      return await this.checkpoints.snapshot(message)
    } catch (error) {
      this.pushItem(record, {
        kind: 'notice',
        id: randomUUID(),
        tone: 'error',
        text: `Checkpoint failed, so this turn can't be undone: ${errorMessage(error)}`,
      })
      return null
    }
  }

  /** Tool titles often embed absolute paths; show them relative to the project. */
  private relativize(text: string) {
    return text.split(`${this.root}/`).join('')
  }

  private displayPath(path: string, line?: number | null) {
    const rel = isAbsolute(path) ? relative(this.root, path) : path
    const shown = rel.startsWith('..') ? path : rel
    return line ? `${shown}:${line}` : shown
  }

  private pushItem(record: TurnRecord, item: TurnItem) {
    record.turn.items.push(item)
    this.flushTurn(record)
  }

  private scheduleTurn(record: TurnRecord) {
    if (this.emitTimers.has(record.turn.id)) return
    this.emitTimers.set(
      record.turn.id,
      setTimeout(() => this.flushTurn(record), 32),
    )
  }

  private flushTurn(record: TurnRecord) {
    const timer = this.emitTimers.get(record.turn.id)
    if (timer) clearTimeout(timer)
    this.emitTimers.delete(record.turn.id)
    // Turns from a session that was reset since are no longer part of the transcript.
    if (this.records.includes(record)) this.emit('turn', record.turn)
  }

  private patchMeta(patch: Partial<ChatMeta>) {
    this.meta = { ...this.meta, ...patch }
    this.emit('meta', this.meta)
  }
}
