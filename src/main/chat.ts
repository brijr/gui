import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { isAbsolute, relative, resolve as resolvePath } from 'node:path'
import type {
  McpServer,
  RequestPermissionRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk'
import {
  AGENTS,
  type AgentId,
  type ChatMeta,
  type ChatSnapshot,
  type ElementContext,
  type Problem,
  type ToolStatus,
  type Turn,
  type TurnItem,
  type TurnStatus,
} from '../shared/types'
import { type AgentInfo, AgentSession, type PermissionResolver } from './agent'
import type { Checkpoints } from './checkpoints'
import { type SavedChat, saveHistory } from './history'
import { MCP_SERVER_NAME } from './mcp-server'
import { buildPrompt } from './prompt'

type SessionUpdate = SessionNotification['update']

interface ChatEvents {
  meta: [meta: ChatMeta]
  turn: [turn: Turn]
  reset: [snapshot: ChatSnapshot]
  /** Something needs the user (e.g. a permission prompt) and the panel should be visible. */
  attention: []
  /** A turn finished in the current session. */
  turnEnd: [turn: Turn]
}

export interface ChatOptions {
  agentId: AgentId
  docked: boolean
  saved: SavedChat | null
  historyFile: string
  /** Grat's preview tools, offered to every agent session */
  mcpServers: () => McpServer[]
}

interface TurnRecord {
  turn: Turn
  before: string | null
  after: string | null
  cancelRequested: boolean
  settled: Promise<void>
}

interface RedoPoint {
  sha: string
  paths: string[]
  turnIds: string[]
}

/**
 * Files that can change how code runs (build/tool config, dependencies, CI, hooks,
 * dotfiles) always need the user's approval, even when edits are otherwise automatic.
 */
const SENSITIVE_PATH =
  /(^|\/)\.|(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|[^/]*\.lock|[^/]*\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|Dockerfile|Makefile|[^/]*\.(sh|bash|zsh))$|(^|\/)(node_modules|scripts|bin)\//i

const START_TIMEOUT_MS = 60_000
const PERSIST_DELAY_MS = 400
const RESET_SETTLE_MS = 5000

/** Readable labels for Grat's own preview tools, which agents report by raw MCP name. */
const PREVIEW_TOOL_LABELS: Record<string, string> = {
  preview_screenshot: 'Screenshot the preview',
  preview_inspect: 'Inspect element',
  preview_console: 'Check preview errors',
  preview_navigate: 'Open page in preview',
  preview_reload: 'Reload preview',
  dev_server_logs: 'Read dev server logs',
}
/**
 * Exact MCP identities for Grat's tools: Claude reports `mcp__grat__<tool>`, Codex
 * `mcp.grat.<tool>`. Anchored at both ends: shell command titles are model-written
 * text and must never be mistaken for a preview tool.
 */
const PREVIEW_TOOL_TITLE = new RegExp(
  `^(?:mcp__${MCP_SERVER_NAME}__|mcp\\.${MCP_SERVER_NAME}\\.)(${Object.keys(PREVIEW_TOOL_LABELS).join('|')})$`,
)

const agentName = (id: AgentId) => AGENTS.find((agent) => agent.id === id)?.name ?? id
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Owns the conversation with one agent: turns, streaming updates, permissions, and checkpoints. */
export class ChatController extends EventEmitter<ChatEvents> {
  meta: ChatMeta
  private records: TurnRecord[] = []
  private agent: AgentSession | null = null
  private agentInfo: AgentInfo | null = null
  /** The agent that already received the preamble. */
  private primedAgent: AgentSession | null = null
  /** Whether this transcript has had an agent session (to notice when context is lost). */
  private hadSession = false
  private active: TurnRecord | null = null
  /**
   * Turns, restores, redos, and resets are mutually exclusive. The holder is the
   * operation's own token, so a superseded operation can't release someone else's lock.
   */
  private lock: object | null = null
  /** Bumped by reset; work started in an older epoch must not touch current state. */
  private epoch = 0
  private permissions = new Map<string, PermissionResolver>()
  private emitTimers = new Map<string, NodeJS.Timeout>()
  private redoPoint: RedoPoint | null = null
  /** Current agent session, persisted so the next launch can resume it. */
  private sessionId: string | null = null
  private resumeSessionId: string | null = null
  private persistTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly root: string,
    private readonly checkpoints: Checkpoints,
    private readonly options: ChatOptions,
  ) {
    super()
    const saved = options.saved
    const agentId = saved?.agentId ?? options.agentId
    this.meta = {
      agentId,
      agentName: agentName(agentId),
      status: 'idle',
      error: null,
      modeName: null,
      selection: null,
      selectionError: null,
      minimized: false,
      docked: options.docked,
      redoTurnIds: saved?.redo?.turnIds ?? [],
      problems: [],
    }
    if (saved) {
      this.records = saved.turns.map((turn) => ({
        turn,
        before: saved.checkpoints[turn.id]?.before ?? null,
        after: saved.checkpoints[turn.id]?.after ?? null,
        cancelRequested: false,
        settled: Promise.resolve(),
      }))
      this.redoPoint = saved.redo
      this.resumeSessionId = saved.sessionId
      this.sessionId = saved.sessionId
      this.hadSession = this.records.length > 0
    }
  }

  snapshot(): ChatSnapshot {
    return { meta: this.meta, turns: this.records.map((record) => record.turn) }
  }

  async setAgent(agentId: AgentId) {
    if (agentId === this.meta.agentId) return
    await this.reset()
    this.patchMeta({ agentId, agentName: agentName(agentId) })
    this.schedulePersist()
  }

  /** Drops the agent process and transcript; the next message starts a fresh session. */
  async reset() {
    const token = {}
    this.lock = token
    this.epoch++
    const running = this.active
    if (running) {
      // Let the agent stop on its own before killing it, so it isn't cut off mid-write.
      running.cancelRequested = true
      this.resolvePendingPermissions(running)
      await this.agent?.cancel().catch(() => undefined)
      await Promise.race([running.settled, sleep(RESET_SETTLE_MS)])
    }
    this.stopAgent()
    this.active = null
    this.records = []
    this.redoPoint = null
    this.hadSession = false
    this.sessionId = null
    this.resumeSessionId = null
    this.schedulePersist()
    if (this.lock === token) this.lock = null
    this.patchMeta({ status: 'idle', error: null, modeName: null, redoTurnIds: [] })
    this.emit('reset', this.snapshot())
  }

  setSelection(selection: ElementContext | null) {
    this.patchMeta({ selection, selectionError: null })
  }

  setSelectionError(message: string) {
    this.patchMeta({ selectionError: message })
  }

  setMinimized(minimized: boolean) {
    this.patchMeta({ minimized })
  }

  setDocked(docked: boolean) {
    this.patchMeta({ docked, minimized: false })
  }

  setProblems(problems: Problem[]) {
    this.patchMeta({ problems })
  }

  /** Asks the agent to fix what's currently broken; the errors ride along in the prompt. */
  fixProblems() {
    if (this.meta.problems.length === 0) return false
    return this.send('The preview has errors. Find the cause and fix them.')
  }

  /** Starts a turn. Returns false (and does nothing) when another operation is in progress. */
  send(text: string): boolean {
    const prompt = text.trim()
    if (!prompt || this.lock) return false

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
      cancelRequested: false,
      settled: Promise.resolve(),
    }
    this.records.push(record)
    this.active = record
    this.lock = record
    this.patchMeta({ selection: null })
    this.flushTurn(record)
    record.settled = this.runTurn(record, selection, this.epoch)
    return true
  }

  async cancel() {
    const record = this.active
    if (!record) return
    record.cancelRequested = true
    this.resolvePendingPermissions(record)
    if (this.meta.status === 'starting') {
      // Nothing to cancel yet; abandoning the start makes the turn finish as cancelled.
      this.stopAgent()
      this.patchMeta({ status: 'idle' })
    } else {
      await this.agent?.cancel().catch(() => undefined)
    }
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

  /**
   * Undoes this turn and every later one by restoring the files those turns changed
   * to how they were before this turn began. Files only the user touched are left alone.
   */
  async restoreTurn(turnId: string) {
    if (this.lock) throw new Error('Wait for the agent to finish first.')
    const record = this.records.find((r) => r.turn.id === turnId)
    if (!record?.before) throw new Error('This turn has no checkpoint to restore.')
    const token = {}
    this.lock = token
    try {
      const undone = this.records.filter(
        (r) => r.turn.index >= record.turn.index && !r.turn.reverted,
      )
      const current = await this.checkpoints.snapshot(
        `before restoring turn ${record.turn.index + 1}`,
      )
      const paths = await this.changedPaths(undone, record.before, current)
      // Record the way back first, so a restore that fails halfway can still be redone.
      this.redoPoint = { sha: current, paths, turnIds: undone.map((r) => r.turn.id) }
      for (const r of undone) {
        r.turn.reverted = true
        this.flushTurn(r)
      }
      this.patchMeta({ redoTurnIds: this.redoPoint.turnIds })
      this.schedulePersist()
      await this.checkpoints.restore(record.before, paths)
    } finally {
      if (this.lock === token) this.lock = null
    }
  }

  async redo() {
    const point = this.redoPoint
    if (!point) return
    if (this.lock) throw new Error('Wait for the agent to finish first.')
    const token = {}
    this.lock = token
    try {
      await this.checkpoints.restore(point.sha, point.paths)
      for (const r of this.records) {
        if (!point.turnIds.includes(r.turn.id)) continue
        r.turn.reverted = false
        this.flushTurn(r)
      }
      this.redoPoint = null
      this.patchMeta({ redoTurnIds: [] })
      this.schedulePersist()
    } finally {
      if (this.lock === token) this.lock = null
    }
  }

  dispose() {
    this.epoch++
    this.persistNow()
    for (const timer of this.emitTimers.values()) clearTimeout(timer)
    this.emitTimers.clear()
    for (const resolve of this.permissions.values()) resolve(null)
    this.permissions.clear()
    this.stopAgent()
    this.removeAllListeners()
  }

  private async runTurn(record: TurnRecord, selection: ElementContext | null, epoch: number) {
    const live = () => this.epoch === epoch
    const stopped = () => !live() || record.cancelRequested
    let status: TurnStatus = 'done'
    try {
      const { agent, info } = await this.ensureAgent(record)
      if (stopped()) {
        status = 'cancelled'
        return
      }
      record.before = await this.trySnapshot(record, `before turn ${record.turn.index + 1}`)
      if (stopped()) {
        status = 'cancelled'
        return
      }
      // New work makes the previous undo unrecoverable by redo.
      this.redoPoint = null
      this.patchMeta({ status: 'working', redoTurnIds: [] })
      const blocks = buildPrompt({
        text: record.turn.prompt,
        selection,
        problems: this.meta.problems,
        preamble: this.primedAgent !== agent,
        images: info.supportsImages,
      })
      this.primedAgent = agent
      const response = await agent.prompt(blocks)
      status = response.stopReason === 'cancelled' ? 'cancelled' : 'done'
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
      if (stopped()) status = 'cancelled'
      else {
        status = 'error'
        record.turn.error = errorMessage(error)
      }
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
      // Only now is the turn over; reporting it earlier would let a send race the snapshot.
      record.turn.status = status
      record.turn.endedAt = Date.now()
      if (this.active === record) this.active = null
      if (this.lock === record) this.lock = null
      this.flushTurn(record)
      if (live()) {
        if (this.meta.status === 'working') this.patchMeta({ status: 'ready' })
        this.emit('turnEnd', record.turn)
      }
    }
  }

  private async ensureAgent(record: TurnRecord): Promise<{ agent: AgentSession; info: AgentInfo }> {
    if (this.agent && this.agentInfo) return { agent: this.agent, info: this.agentInfo }
    this.stopAgent()
    const name = this.meta.agentName
    this.patchMeta({ status: 'starting', error: null })
    const agent = new AgentSession(this.meta.agentId, this.root, {
      onUpdate: (update) => this.onUpdate(update),
      onPermission: (request, resolve) => this.onPermission(request, resolve),
      onExit: (error) => this.onAgentExit(agent, error),
    })
    this.agent = agent
    try {
      const resumeSessionId = this.resumeSessionId
      this.resumeSessionId = null
      const info = await withTimeout(
        agent.start({ mcpServers: this.options.mcpServers(), resumeSessionId }),
        START_TIMEOUT_MS,
        `${name} didn't start within a minute. Check that it's installed and signed in.`,
      )
      if (this.agent !== agent) throw new Error(`${name} was stopped while starting.`)
      this.agentInfo = info
      this.sessionId = info.sessionId
      this.schedulePersist()
      this.patchMeta({ status: 'ready', modeName: info.modeName })
      // A resumed session already has the instructions and remembers earlier turns.
      if (info.resumed) this.primedAgent = agent
      else if (this.hadSession) {
        this.pushItem(record, {
          kind: 'notice',
          id: randomUUID(),
          tone: 'info',
          text: `Started a new ${name} session. It doesn't remember earlier turns.`,
        })
      }
      this.hadSession = true
      return { agent, info }
    } catch (error) {
      if (this.agent === agent) {
        this.stopAgent()
        this.patchMeta({ status: 'error', error: errorMessage(error) })
      } else {
        agent.dispose()
      }
      throw error
    }
  }

  private stopAgent() {
    this.agent?.dispose()
    this.agent = null
    this.agentInfo = null
    this.primedAgent = null
  }

  private onAgentExit(agent: AgentSession, error: string | null) {
    if (this.agent !== agent) return
    this.stopAgent()
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
        const preview =
          update.kind !== 'execute' ? update.title.match(PREVIEW_TOOL_TITLE)?.[1] : undefined
        items.push({
          kind: 'tool',
          id: update.toolCallId,
          title: preview ? PREVIEW_TOOL_LABELS[preview] : this.relativize(update.title),
          toolKind: preview ? 'preview' : (update.kind ?? 'other'),
          status: update.status ?? 'pending',
          locations: (update.locations ?? []).map((l) => this.displayPath(l.path, l.line)),
        })
        break
      }
      case 'tool_call_update': {
        const item = items.find((i) => i.kind === 'tool' && i.id === update.toolCallId)
        if (item?.kind !== 'tool') break
        if (update.title && item.toolKind !== 'preview') item.title = this.relativize(update.title)
        if (update.kind && item.toolKind !== 'preview') item.toolKind = update.kind
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
    if (!record || record.cancelRequested) {
      resolve(null)
      return
    }
    const autoApprove = this.isRoutineEdit(request)
      ? request.options.find((option) => option.kind === 'allow_once')
      : undefined
    if (autoApprove) {
      resolve(autoApprove.optionId)
      return
    }
    const id = randomUUID()
    this.permissions.set(`${record.turn.id}:${id}`, resolve)
    this.pushItem(record, {
      kind: 'permission',
      id,
      title: request.toolCall.title
        ? this.relativize(request.toolCall.title)
        : 'The agent wants to run a tool',
      options: request.options.map(({ optionId, name, kind }) => ({ optionId, name, kind })),
      resolved: null,
    })
    this.emit('attention')
  }

  /** Edits to ordinary source files inside the project are what Grat is for; approve those. */
  private isRoutineEdit(request: RequestPermissionRequest) {
    const { kind, locations } = request.toolCall
    if (kind !== 'edit' || !locations?.length) return false
    return locations.every(({ path }) => {
      const rel = relative(this.root, resolvePath(this.root, path))
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && !SENSITIVE_PATH.test(rel)
    })
  }

  private resolvePendingPermissions(record: TurnRecord) {
    for (const item of record.turn.items) {
      if (item.kind === 'permission' && item.resolved === null) {
        this.respondPermission(record.turn.id, item.id, null)
      }
    }
  }

  /** Paths the given turns changed; falls back to everything since `before` if a diff is missing. */
  private async changedPaths(turns: TurnRecord[], before: string, current: string) {
    if (turns.every((r) => r.turn.changes !== null)) {
      return [...new Set(turns.flatMap((r) => r.turn.changes?.map((c) => c.path) ?? []))]
    }
    return (await this.checkpoints.diff(before, current)).map((change) => change.path)
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
    if (!this.records.includes(record)) return
    this.emit('turn', record.turn)
    this.schedulePersist()
  }

  private schedulePersist() {
    this.persistTimer ??= setTimeout(() => this.persistNow(), PERSIST_DELAY_MS)
  }

  private persistNow() {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = null
    const checkpoints: SavedChat['checkpoints'] = {}
    for (const { turn, before, after } of this.records) checkpoints[turn.id] = { before, after }
    try {
      saveHistory(this.options.historyFile, {
        version: 1,
        agentId: this.meta.agentId,
        sessionId: this.sessionId,
        turns: this.records.map((r) => r.turn),
        checkpoints,
        redo: this.redoPoint,
      })
    } catch (error) {
      console.error('[grat] failed to save chat history', error)
    }
  }

  private patchMeta(patch: Partial<ChatMeta>) {
    this.meta = { ...this.meta, ...patch }
    this.emit('meta', this.meta)
  }
}
