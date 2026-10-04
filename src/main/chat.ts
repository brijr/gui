import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Stats } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from 'node:path'
import type {
  McpServer,
  RequestPermissionRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk'
import { app, BrowserWindow, dialog, type MessageBoxOptions } from 'electron'
import {
  type AgentId,
  agentName,
  type ChatMeta,
  type ChatSnapshot,
  type ElementContext,
  type ImageAttachment,
  type Problem,
  type ToolStatus,
  type Turn,
  type TurnItem,
  type TurnStatus,
} from '../shared/types'
import { type AgentInfo, AgentSession, type PermissionResolver } from './agent'
import { AgentMissingError } from './agent-binaries'
import type { Checkpoints } from './checkpoints'
import { type DetailedError, describeError } from './errors'
import { HistoryWriter, type SavedChat } from './history'
import { MCP_SERVER_NAME } from './mcp-server'
import { buildPrompt } from './prompt'
import { thumbnail } from './thumbnail'
import { askToTrust, isTrusted, promptName } from './trust'

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

/** The checkpoint Grat last recorded the files at; `complete` is false when a turn's end went unrecorded. */
interface Baseline {
  sha: string
  complete: boolean
}

/** Where an edit may be approved without asking; see `projectEditPath`. */
export interface EditScope {
  /** The project root as the agent was given it */
  root: string
  realRoot: string
  /** Real home folder: its dotfiles and dot-folders, and ~/Library, always ask. */
  home: string
  /** Other real folders whose files always ask, like Grat's own data */
  protectedDirs: string[]
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
/** Paths listed in the overwrite warning before it summarizes the rest. */
const OVERWRITE_LIST_MAX = 8

const FIX_PROMPT = 'The preview has errors. Find the cause and fix them.'

/** What an image sent without text asks for; also what the transcript and history show. */
const imagePrompt = (count: number) =>
  `Use the attached ${count === 1 ? 'image' : 'images'} as a reference.`

/** Readable labels for Grat's own preview tools, which agents report by raw MCP name. */
const PREVIEW_TOOL_LABELS: Record<string, string> = {
  preview_screenshot: 'Screenshot the preview',
  preview_inspect: 'Inspect element',
  preview_console: 'Check preview errors',
  preview_navigate: 'Open page in preview',
  preview_reload: 'Reload preview',
  dev_server_logs: 'Read dev server logs',
}
const PREVIEW_TOOLS = Object.keys(PREVIEW_TOOL_LABELS).join('|')
/**
 * Exact MCP identities for Grat's tools, anchored at both ends: shell command titles
 * are model-written text and must never be mistaken for a preview tool. Claude reports
 * `mcp__grat__<tool>` (never as `execute`); Codex reports every MCP call as an
 * `execute` titled `mcp.grat.<tool>`. Labels only: nothing is approved by title.
 */
const CLAUDE_TOOL = new RegExp(`^mcp__${MCP_SERVER_NAME}__(${PREVIEW_TOOLS})$`)
const CODEX_TOOL = new RegExp(`^mcp\\.${MCP_SERVER_NAME}\\.(${PREVIEW_TOOLS})$`)
const ANY_TOOL = new RegExp(
  `^(?:mcp__${MCP_SERVER_NAME}__|mcp\\.${MCP_SERVER_NAME}\\.|${MCP_SERVER_NAME}[_.])(${PREVIEW_TOOLS})$`,
)

function previewTool(agentId: AgentId, title: string, kind: string | undefined) {
  if (agentId === 'codex') return title.match(CODEX_TOOL)?.[1]
  // Other agents name MCP calls their own way, but a shell command (`execute`) is never one.
  if (kind === 'execute') return undefined
  return title.match(agentId === 'claude' ? CLAUDE_TOOL : ANY_TOOL)?.[1]
}

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
  /** Whether the running agent session was given Grat's preview tools. */
  private agentHasTools = false
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
  /** After dispose, nothing snapshots, saves, or emits. */
  private disposed = false
  private permissions = new Map<string, PermissionResolver>()
  private emitTimers = new Map<string, NodeJS.Timeout>()
  private redoPoint: RedoPoint | null = null
  /** Current agent session, persisted so the next launch can resume it. */
  private sessionId: string | null = null
  /**
   * Which preamble `sessionId` has received, persisted with it: the one with preview
   * tools, the one without, or none. A session primed without tools is re-primed once
   * they're available, so it doesn't keep believing it can't see the preview.
   */
  private primed: 'tools' | 'plain' | null = null
  /** Saved session to resume; kept until an agent actually starts. */
  private resumeSessionId: string | null = null
  private persistTimer: NodeJS.Timeout | null = null
  /** Resolved on the first edit the agent asks about, then kept. */
  private editScope: Promise<EditScope> | null = null
  private readonly history: HistoryWriter

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
      errorDetail: null,
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
      this.primed = saved.primed ? (saved.primedWithTools ? 'tools' : 'plain') : null
      this.hadSession = this.records.length > 0
    }
    this.history = new HistoryWriter(options.historyFile, () => this.savedChat())
  }

  snapshot(): ChatSnapshot {
    return { meta: this.meta, turns: this.records.map((record) => record.turn) }
  }

  async setAgent(agentId: AgentId) {
    if (agentId === this.meta.agentId) return
    // Switch first, so a quick second switch compares against this one and the last call wins.
    this.patchMeta({ agentId, agentName: agentName(agentId) })
    await this.reset()
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
    this.primed = null
    this.resumeSessionId = null
    this.schedulePersist()
    if (this.lock === token) this.lock = null
    this.patchMeta({
      status: 'idle',
      error: null,
      errorDetail: null,
      modeName: null,
      redoTurnIds: [],
    })
    if (!this.disposed) this.emit('reset', this.snapshot())
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

  /**
   * Asks the agent to fix what's currently broken; the errors ride along in the prompt.
   * A pending element selection is left for the user's next message.
   */
  fixProblems() {
    if (this.meta.problems.length === 0) return false
    return this.startTurn(FIX_PROMPT, true)
  }

  /** Whether a turn, undo or redo is in progress. */
  get busy() {
    return this.lock !== null
  }

  /**
   * Starts a turn. Returns false (and does nothing) when another operation is in progress.
   * Images alone are a complete message: they're sent with a default prompt.
   */
  send(text: string, images: ImageAttachment[] = []): boolean {
    return this.startTurn(text, false, images)
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
    const before = record?.before
    if (!record || !before) throw new Error('This turn has no checkpoint to restore.')
    if (record.turn.reverted) throw new Error('This turn is already undone.')
    const token = {}
    const epoch = this.epoch
    this.lock = token
    try {
      const undone = this.records.filter(
        (r) => r.turn.index >= record.turn.index && !r.turn.reverted,
      )
      const baseline = lastRecorded(undone)
      // Everything the paths below may diff against; checked before anything changes.
      const later = this.records.filter((r) => r.turn.index >= record.turn.index)
      await this.requireCheckpoints(
        [before, baseline?.sha ?? null, ...later.map((r) => r.before)],
        "so it can't be undone",
      )
      const message = `before restoring turn ${record.turn.index + 1}`
      const current = await this.checkpoints.snapshot(message)
      const { paths, inferred } = await this.changedPaths(undone, current)
      if (!(await this.confirmOverwrite(baseline, current, paths, inferred, 'Undo'))) return
      if (epoch !== this.epoch) return
      // Record the way back first, so a restore that fails halfway can still be redone. Taken
      // again because files may have been saved while the confirmation was open.
      const latest = await this.checkpoints.snapshot(message)
      this.redoPoint = { sha: latest, paths, turnIds: undone.map((r) => r.turn.id) }
      for (const r of undone) {
        r.turn.reverted = true
        this.flushTurn(r)
      }
      this.patchMeta({ redoTurnIds: this.redoPoint.turnIds })
      this.schedulePersist()
      await this.checkpoints.restore(before, paths)
    } finally {
      if (this.lock === token) this.lock = null
    }
  }

  /** The newest turn that can be undone, if any; for Edit → Undo. */
  lastUndoableTurnId() {
    if (this.lock) return null
    const record = this.records.findLast((r) => r.before && !r.turn.reverted)
    return record?.turn.id ?? null
  }

  /** Adds the after-hot-reload image of the picked element to a finished turn. */
  setPreviewAfter(turnId: string, after: string | null) {
    const record = this.records.find((r) => r.turn.id === turnId)
    if (!record || !after) return
    record.turn.preview = { before: record.turn.preview?.before ?? null, after }
    this.flushTurn(record)
  }

  async redo() {
    const point = this.redoPoint
    if (!point) return
    if (this.lock) throw new Error('Wait for the agent to finish first.')
    const token = {}
    const epoch = this.epoch
    this.lock = token
    try {
      // The undo left these paths as they were before its first turn.
      const restored = this.records.find((r) => point.turnIds.includes(r.turn.id))?.before ?? null
      await this.requireCheckpoints([point.sha, restored], "so they can't be redone")
      if (restored) {
        const current = await this.checkpoints.snapshot('before redo')
        const baseline = { sha: restored, complete: true }
        if (!(await this.confirmOverwrite(baseline, current, point.paths, [], 'Redo'))) return
        if (epoch !== this.epoch) return
      }
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
    if (this.disposed) return
    this.epoch++
    this.disposed = true
    // Settle open prompts before the final save, so it records them as cancelled
    // rather than leaving buttons that nothing answers after a relaunch.
    for (const record of this.records) this.resolvePendingPermissions(record)
    for (const resolve of this.permissions.values()) resolve(null)
    this.permissions.clear()
    for (const timer of this.emitTimers.values()) clearTimeout(timer)
    this.emitTimers.clear()
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = null
    this.history.saveSync()
    this.stopAgent()
    this.removeAllListeners()
  }

  /** `fix` turns carry the current problems and leave the pending selection alone. */
  private startTurn(text: string, fix: boolean, images: ImageAttachment[] = []): boolean {
    const prompt = text.trim() || (images.length ? imagePrompt(images.length) : '')
    if (!prompt || this.lock || this.disposed) return false

    const selection = fix ? null : this.meta.selection
    const record: TurnRecord = {
      turn: {
        id: randomUUID(),
        index: this.records.length,
        prompt,
        context: selection ? { ...selection, screenshot: null } : null,
        // The after image is added by the window once the change has hot-reloaded.
        preview: selection?.screenshot
          ? { before: thumbnail(selection.screenshot), after: null }
          : null,
        items: [],
        status: 'running',
        error: null,
        startedAt: Date.now(),
        endedAt: null,
        changes: null,
        // Thumbnails only: the full images go to the agent and are never kept.
        ...(images.length
          ? { attachments: images.map(({ name, thumbnail }) => ({ name, thumbnail })) }
          : {}),
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
    if (!fix) this.patchMeta({ selection: null })
    this.flushTurn(record)
    // The problems the user asked to fix; by prompt time a hot reload may have cleared them.
    const problems = fix ? this.meta.problems : []
    record.settled = this.runTurn(record, selection, problems, images, this.epoch)
    return true
  }

  private async runTurn(
    record: TurnRecord,
    selection: ElementContext | null,
    problems: Problem[],
    images: ImageAttachment[],
    epoch: number,
  ) {
    const live = () => this.epoch === epoch
    const stopped = () => !live() || record.cancelRequested
    let status: TurnStatus = 'done'
    try {
      if (!(await this.confirmTrust())) {
        status = 'cancelled'
        if (live()) this.notTrusted(record)
        return
      }
      if (stopped()) {
        status = 'cancelled'
        return
      }
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
      // buildPrompt drops them too; the turn still runs on the text.
      if (images.length && !info.supportsImages) {
        const what = images.length === 1 ? "image wasn't" : "images weren't"
        this.pushItem(record, {
          kind: 'notice',
          id: randomUUID(),
          tone: 'error',
          text: `${this.meta.agentName} can't see images, so the attached ${what} sent.`,
        })
      }
      const preamble = this.primedAgent !== agent
      const blocks = buildPrompt({
        text: record.turn.prompt,
        selection,
        // Only Fix carries errors: they're usually unrelated to an ordinary request.
        problems,
        preamble,
        tools: this.agentHasTools,
        images: info.supportsImages,
        attachments: images,
      })
      const response = await agent.prompt(blocks)
      status = response.stopReason === 'cancelled' ? 'cancelled' : 'done'
      // Only a prompt the agent got through counts as delivering the instructions.
      if (preamble && status === 'done' && live() && this.agent === agent) {
        this.primedAgent = agent
        this.primed = this.agentHasTools ? 'tools' : 'plain'
        this.schedulePersist()
      }
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
        const { message, detail } = describeError(error)
        record.turn.error = message
        record.turn.errorDetail = detail
      }
    } finally {
      this.resolvePendingPermissions(record)
      // After dispose the final save already holds this turn as interrupted.
      if (record.before && !this.disposed) {
        record.after = await this.trySnapshot(record, `after turn ${record.turn.index + 1}`)
        if (record.after && !this.disposed) {
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

  /**
   * Agents load the project's own agent settings (Claude Code's .claude/settings.json,
   * OpenCode's opencode.json and plugins, and so on), which can run commands, so none works
   * in a project the user hasn't trusted. Checked every turn: trust revoked in Settings
   * asks again.
   */
  private async confirmTrust() {
    if (await isTrusted(this.root)) return true
    if (this.disposed) return false
    // A custom agent's name comes from agents.json, which an agent could have written.
    const agent = promptName(this.meta.agentName)
    return askToTrust(
      this.root,
      {
        message: `Let ${agent} work in ${promptName(basename(this.root))}?`,
        detail: `${agent} loads this project's own agent settings (for example .claude/settings.json or opencode.json), which can run commands on your Mac. Only continue for projects you trust. Grat won't ask again for this project.`,
        buttons: ['Continue', 'Cancel'],
        // It follows Return in the composer; pressing it again mustn't be what agrees.
        defaultId: 1,
      },
      BrowserWindow.getFocusedWindow(),
    )
  }

  /** Declined: the turn ends unstarted, and an agent still running here (trust was revoked) stops. */
  private notTrusted(record: TurnRecord) {
    this.pushItem(record, {
      kind: 'notice',
      id: randomUUID(),
      tone: 'info',
      text: "Not started: this project isn't trusted.",
    })
    if (!this.agent) return
    this.stopAgent()
    // A later turn, once trusted, picks the conversation back up.
    this.resumeSessionId = this.sessionId
    this.patchMeta({ status: 'idle' })
  }

  private async ensureAgent(record: TurnRecord): Promise<{ agent: AgentSession; info: AgentInfo }> {
    if (this.agent && this.agentInfo) return { agent: this.agent, info: this.agentInfo }
    this.stopAgent()
    const name = this.meta.agentName
    this.patchMeta({ status: 'starting', error: null, errorDetail: null })
    const agent = new AgentSession(this.meta.agentId, this.root, {
      onUpdate: (update) => this.onUpdate(update),
      onPermission: (request, resolve) => this.onPermission(request, resolve),
      onExit: (error) => this.onAgentExit(agent, error),
    })
    this.agent = agent
    try {
      const mcpServers = this.options.mcpServers()
      const info = await withTimeout(
        agent.start({ mcpServers, resumeSessionId: this.resumeSessionId }),
        START_TIMEOUT_MS,
        `${name} didn't start within a minute. Check that it's installed and signed in.`,
      )
      if (this.agent !== agent) throw new Error(`${name} was stopped while starting.`)
      this.agentInfo = info
      // Agents that can't take HTTP MCP servers (like Pi) start without them.
      this.agentHasTools = info.previewTools
      // The saved session was resumed or replaced; a failed start keeps it for next time.
      this.resumeSessionId = null
      this.sessionId = info.sessionId
      if (info.resumed) {
        // It remembers earlier turns, and has the instructions if they got through.
        const variant = this.agentHasTools ? 'tools' : 'plain'
        if (this.primed === variant) this.primedAgent = agent
      } else {
        this.primed = null
        if (this.hadSession) {
          this.pushItem(record, {
            kind: 'notice',
            id: randomUUID(),
            tone: 'info',
            text: `Started a new ${name} session. It doesn't remember earlier turns.`,
          })
        }
      }
      this.schedulePersist()
      this.patchMeta({ status: 'ready', modeName: info.modeName })
      this.hadSession = true
      return { agent, info }
    } catch (error) {
      if (this.agent === agent) {
        this.stopAgent()
        const { message, detail } = describeError(error)
        // Settings → Agents is where Grat installs a missing agent.
        const hint =
          error instanceof AgentMissingError ? ' Set it up in Settings → Agents (⌘,).' : ''
        this.patchMeta({ status: 'error', error: `${message}${hint}`, errorDetail: detail })
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
    this.agentHasTools = false
    this.primedAgent = null
  }

  private onAgentExit(agent: AgentSession, error: DetailedError) {
    if (this.agent !== agent) return
    this.stopAgent()
    // The next message restarts the agent; it should pick the conversation back up.
    this.resumeSessionId = this.sessionId
    this.patchMeta({ status: 'error', error: error.message, errorDetail: error.detail })
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
        const preview = previewTool(this.meta.agentId, update.title, update.kind)
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
    if (!record || record.cancelRequested || this.disposed) {
      resolve(null)
      return
    }
    void this.isRoutineEdit(request)
      .catch(() => false)
      .then((routine) => this.askPermission(record, request, resolve, routine))
  }

  private askPermission(
    record: TurnRecord,
    request: RequestPermissionRequest,
    resolve: PermissionResolver,
    routine: boolean,
  ) {
    // The turn may have ended or been stopped while the edit's paths were checked.
    if (this.active !== record || record.cancelRequested || this.disposed) {
      resolve(null)
      return
    }
    const autoApprove = routine
      ? request.options.find((option) => option.kind === 'allow_once')
      : undefined
    if (autoApprove) {
      resolve(autoApprove.optionId)
      return
    }
    const { toolCallId, title } = request.toolCall
    // codex-acp asks about MCP calls with no title; the tool call it's asking about has one.
    // Only the label comes from it: the user still decides.
    const tool = record.turn.items.find((i) => i.kind === 'tool' && i.id === toolCallId)
    const paths = (request.toolCall.locations ?? []).map(({ path }) => this.projectPath(path))
    const id = randomUUID()
    this.permissions.set(`${record.turn.id}:${id}`, resolve)
    this.pushItem(record, {
      kind: 'permission',
      id,
      title: title?.trim()
        ? this.relativize(title)
        : tool?.kind === 'tool'
          ? tool.title
          : 'The agent wants to run a tool',
      toolKind: request.toolCall.kind ?? (tool?.kind === 'tool' ? tool.toolKind : 'other'),
      locations: (request.toolCall.locations ?? []).map((l) => this.displayPath(l.path, l.line)),
      sensitive: paths.some((rel) => rel !== null && SENSITIVE_PATH.test(rel)),
      options: request.options.map(({ optionId, name, kind }) => ({ optionId, name, kind })),
      resolved: null,
    })
    this.emit('attention')
  }

  /** Edits to ordinary source files inside the project are what Grat is for; approve those. */
  private async isRoutineEdit(request: RequestPermissionRequest) {
    const { kind, locations } = request.toolCall
    if (kind !== 'edit' || !locations?.length) return false
    const scope = await this.scope()
    const paths = await Promise.all(locations.map(({ path }) => projectEditPath(path, scope)))
    return paths.every((rel) => rel !== null && !SENSITIVE_PATH.test(rel))
  }

  private scope() {
    this.editScope ??= (async () => {
      const real = (path: string) => realpath(path).catch(() => path)
      const [realRoot, home, userData] = await Promise.all([
        real(this.root),
        real(homedir()),
        real(app.getPath('userData')),
      ])
      return { root: this.root, realRoot, home, protectedDirs: [userData] }
    })()
    return this.editScope
  }

  /**
   * The path relative to the project root, or null when it points outside the project.
   * Only for labels: it doesn't follow symlinks (see `projectEditPath`).
   */
  private projectPath(path: string) {
    const rel = relative(this.root, resolvePath(this.root, path))
    return rel !== '' && !isOutside(rel) ? rel : null
  }

  private resolvePendingPermissions(record: TurnRecord) {
    for (const item of record.turn.items) {
      if (item.kind === 'permission' && item.resolved === null) {
        this.respondPermission(record.turn.id, item.id, null)
      }
    }
  }

  /**
   * Paths the given turns changed. A turn whose changes weren't recorded (e.g. it was
   * interrupted by a quit) counts everything that changed from its start to the next
   * checkpoint: `inferred`, since that can include the user's own edits. A turn with no
   * starting checkpoint never ran, or was already marked as impossible to undo.
   */
  private async changedPaths(turns: TurnRecord[], current: string) {
    const paths = new Set<string>()
    const inferred = new Set<string>()
    for (const r of turns) {
      if (r.turn.changes) {
        for (const change of r.turn.changes) paths.add(change.path)
        continue
      }
      if (!r.before) continue
      const next = this.records.find((n) => n.turn.index > r.turn.index && n.before)?.before
      for (const path of await this.pathsBetween(r.before, next ?? current)) {
        paths.add(path)
        inferred.add(path)
      }
    }
    return { paths: [...paths], inferred: [...inferred] }
  }

  private async pathsBetween(from: string, to: string) {
    return (await this.checkpoints.diff(from, to)).map((change) => change.path)
  }

  private async requireCheckpoints(shas: (string | null)[], consequence: string) {
    const needed = shas.filter((sha): sha is string => sha !== null)
    if (await this.checkpoints.hasCommits(needed)) return
    throw new Error(
      `Grat's saved checkpoints are missing (was its checkpoints folder deleted?), ${consequence}.`,
    )
  }

  /**
   * Undo and redo rewrite whole files, so they'd silently discard edits made outside
   * Grat (e.g. in the user's editor) since Grat last recorded those files. Asks first.
   */
  private async confirmOverwrite(
    baseline: Baseline | null,
    current: string,
    paths: string[],
    inferred: string[],
    action: 'Undo' | 'Redo',
  ) {
    if (paths.length === 0) return true
    const edited = baseline ? await this.checkpoints.changedAmong(baseline.sha, current, paths) : []
    // Paths only attributed to a turn by diffing may hold the user's edits too.
    const changed = [...new Set([...edited, ...inferred])]
    if (changed.length === 0) return true
    const certain = baseline?.complete === true && inferred.length === 0
    const listed = changed.slice(0, OVERWRITE_LIST_MAX).map((path) => `  ${path}`)
    const more = changed.length - listed.length
    if (more > 0) listed.push(`  and ${more} more`)
    const files = listed.join('\n')
    const verb = action === 'Undo' ? 'Undoing' : 'Redoing'
    const options: MessageBoxOptions = {
      type: 'warning',
      message: certain ? 'Overwrite changes made outside Grat?' : 'Overwrite these files?',
      detail: certain
        ? `These files changed after Grat last recorded them, for example in your editor:\n\n${files}\n\n${verb} replaces their contents, and those changes will be lost.`
        : `A turn was interrupted before Grat recorded what it changed, so Grat can't tell whether these files also have changes made outside Grat, for example in your editor:\n\n${files}\n\n${verb} replaces their contents, and any such changes will be lost.`,
      buttons: [`${action} Anyway`, 'Cancel'],
      defaultId: 1,
      cancelId: 1,
    }
    const parent = BrowserWindow.getFocusedWindow()
    const { response } = parent
      ? await dialog.showMessageBox(parent, options)
      : await dialog.showMessageBox(options)
    return response === 0 && !this.disposed
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
        text: "Couldn't save a checkpoint, so this turn can't be undone.",
        detail: describeError(error).message,
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
    if (this.disposed || this.emitTimers.has(record.turn.id)) return
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
    if (this.disposed || !this.records.includes(record)) return
    this.emit('turn', record.turn)
    this.schedulePersist()
  }

  private schedulePersist() {
    if (this.disposed) return
    this.persistTimer ??= setTimeout(() => {
      this.persistTimer = null
      this.history.save()
    }, PERSIST_DELAY_MS)
  }

  private savedChat(): SavedChat {
    const checkpoints: SavedChat['checkpoints'] = {}
    for (const { turn, before, after } of this.records) checkpoints[turn.id] = { before, after }
    return {
      version: 1,
      agentId: this.meta.agentId,
      sessionId: this.sessionId,
      primed: this.primed !== null,
      primedWithTools: this.primed === 'tools',
      turns: this.records.map((r) => r.turn),
      checkpoints,
      redo: this.redoPoint,
    }
  }

  private patchMeta(patch: Partial<ChatMeta>) {
    this.meta = { ...this.meta, ...patch }
    if (!this.disposed) this.emit('meta', this.meta)
  }
}

/** A relative path that climbs out of the folder it's relative to (or isn't relative at all). */
const isOutside = (rel: string) => rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)

/** `path` relative to `dir`, or null when it isn't inside `dir` (or `dir` itself). */
function within(dir: string, path: string) {
  const rel = relative(dir, path)
  return isOutside(rel) ? null : rel
}

const isMissing = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

/** The real path of `path`'s deepest existing folder (or itself), with the rest put back. */
async function realLocation(path: string) {
  const rest: string[] = []
  let current = path
  for (;;) {
    try {
      return join(await realpath(current), ...rest)
    } catch (error) {
      const parent = dirname(current)
      if (!isMissing(error) || parent === current) throw error
      rest.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * Where an edit to `path` lands, relative to the project root, when it may be approved
 * without asking; otherwise null. That's never outside the project, never through a
 * symlink inside it (a link can point anywhere, Grat's own data included), only to a plain
 * file or one that doesn't exist yet, and never in the home folder's dotfiles, ~/Library
 * or `protectedDirs`, for projects that contain those.
 */
export async function projectEditPath(path: string, scope: EditScope): Promise<string | null> {
  // `..` after a symlink climbs out of where the link points, not where it sits.
  if (path.includes('\0') || path.split(/[\\/]/).includes('..')) return null
  const target = resolvePath(scope.root, path)
  const rel = [scope.root, scope.realRoot]
    .map((root) => relative(root, target))
    .find((candidate) => candidate !== '' && !isOutside(candidate))
  if (rel === undefined) return null

  // Walks down from the real root; what doesn't exist yet can't be a link.
  const parts = rel.split(sep)
  let current = scope.realRoot
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    let stats: Stats
    try {
      stats = await lstat(current)
    } catch (error) {
      if (isMissing(error)) break
      return null
    }
    if (stats.isSymbolicLink()) return null
    if (index < parts.length - 1 ? !stats.isDirectory() : !stats.isFile()) return null
    // A file with other hard links is also a file somewhere else.
    if (stats.isFile() && stats.nlink > 1) return null
  }

  // Where it really lands, as macOS resolves it (realpath also settles letter case).
  const real = await realLocation(join(scope.realRoot, rel)).catch(() => null)
  if (real === null || !within(scope.realRoot, real)) return null
  if (scope.protectedDirs.some((dir) => within(dir, real) !== null)) return null
  // ~/Library and home dotfiles only matter when the project is the home folder (or one
  // above it): projects in iCloud Drive or Dropbox live under ~/Library themselves.
  if (within(scope.realRoot, scope.home) !== null) {
    if (within(join(scope.home, 'Library'), real) !== null) return null
    if (within(scope.home, real)?.startsWith('.')) return null
  }
  return rel
}

/** The newest checkpoint of these turns, i.e. how Grat last left the files they touched. */
function lastRecorded(turns: TurnRecord[]): Baseline | null {
  let complete = true
  for (const r of [...turns].reverse()) {
    if (r.after) return { sha: r.after, complete }
    if (r.before) return { sha: r.before, complete: false }
    complete = false
  }
  return null
}
