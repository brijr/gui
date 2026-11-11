import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, relative, resolve as resolvePath } from 'node:path'
import type {
  ContentBlock,
  McpServer,
  RequestPermissionRequest,
  SessionNotification,
} from '@agentclientprotocol/sdk'
import { app, BrowserWindow, dialog, type MessageBoxOptions } from 'electron'
import { MAX_SUBAGENT_STEPS } from '../shared/bounded'
import { type ChatTurnUpdate, TurnPublisher } from '../shared/chat-transport'
import { invokedCommand, parseCommands, takesContext } from '../shared/commands'
import {
  type AgentCommand,
  type AgentId,
  agentName,
  type ChatMeta,
  type ChatSnapshot,
  type FollowUp,
  type ImageAttachment,
  type ModelSettings,
  needsSetup,
  type Picked,
  type PreviewFrame,
  type Problem,
  primaryPick,
  type QueuedMessage,
  type QueuePauseReason,
  type RecordingAttachment,
  type SubagentItem,
  type TextEdit,
  type ToolStatus,
  type Turn,
  type TurnItem,
  type TurnStatus,
  type Version,
} from '../shared/types'
import {
  AgentAuthError,
  type AgentInfo,
  AgentSession,
  type PermissionResolver,
  parseModelSettings,
} from './agent'
import { AgentMissingError } from './agent-binaries'
import { agentHealth } from './agent-status'
import { declaresOwnPermissions, type PermissionPolicy } from './agents'
import { autoApproval, isAutoApprove, requestPaths, SENSITIVE_PATH } from './auto-approve'
import { availableModels, chosenValue, offersChoice, withChoices } from './chat-models'
import { type EditScope, isFromHome, isOutside, projectEditPath } from './chat-paths'
import { asksFirst, GUI_TOOL_LABELS, previewTool } from './chat-tools'
import type { Checkpoints } from './checkpoints'
import { type DetailedError, describeError } from './errors'
import {
  archiveChat,
  HistoryWriter,
  loadArchived,
  MAX_VERSIONS,
  removeArchived,
  type SavedChat,
  type SavedQueued,
} from './history'
import { getPrefs, prefsEvents, saveAgentSetting, savedAgentSettings, setPrefs } from './prefs'
import {
  buildPrompt,
  describeFollowUp,
  PROMPT_VERSION,
  type PromptBoard,
  type PromptGuides,
  type PromptViewport,
  placeCommand,
  TEXT_EDIT_PROMPT,
} from './prompt'
import { recordingBlocks } from './recording-prompt'
import type { Recordings } from './recordings'
import { findSkills, withSkills } from './skills'
import {
  echoedAnswer,
  messageText,
  overflowingSteps,
  ownedBy,
  sessionMessageRole,
  subagentPatch,
} from './subagents'
import { cornerColor, thumbnail, thumbnailSize } from './thumbnail'
import { askToTrust, isTrusted, promptName } from './trust'

type SessionUpdate = SessionNotification['update']
type SubagentUpdate = Extract<SessionUpdate, { sessionUpdate: 'subagent_update' }>
type SessionMessage = Extract<SessionUpdate, { sessionUpdate: 'session_message' }>
type PermissionItem = Extract<TurnItem, { kind: 'permission' }>

interface ChatEvents {
  meta: [meta: ChatMeta]
  turn: [turn: Turn]
  turnUpdate: [update: ChatTurnUpdate]
  reset: [snapshot: ChatSnapshot]
  /** Something needs the user (e.g. a permission prompt) and the panel should be visible. */
  attention: []
  /** A turn finished in the current session. */
  turnEnd: [turn: Turn]
  /** A turn that asked the agent to get the app running has ended (after `turnEnd`) */
  startupFixEnd: [turn: Turn]
}

export interface ChatOptions {
  agentId: AgentId
  docked: boolean
  saved: SavedChat | null
  historyFile: string
  recordings: Recordings
  /** Gui's preview tools, offered to every agent session */
  mcpServers: () => McpServer[]
  /** The preview's viewport as the user sees it now, which each prompt names; null on a canvas's board */
  viewport: () => PromptViewport | null
  /** The user's guides over the preview while the rulers show them, which each prompt names */
  guides?: () => PromptGuides | null
  /** The canvas this chat is on, as each prompt describes it; absent in a project */
  board?: () => PromptBoard | null
  /** Why the app won't start, as the agent is told it (`startupReport`) */
  startupReport: (tools: boolean) => string
  /** A canvas's layout file, which Gui writes itself (see `BoardLayout`); absent in a project */
  layout?: BoardLayout
}

/**
 * A canvas's manifest (`canvas.json`): Gui writes it as the user moves frames and pans, so
 * it's never an edit "made outside Gui", and restoring it whole would undo the user's own later
 * moves (or race the board writing it). Undo, redo and restoring a version leave it out of the
 * files they restore and hand it to `restore` instead, which merges the change into the board
 * as it is now. A turn lists it among its changes only when the layout itself changed.
 */
export interface BoardLayout {
  /** Its path, relative to the canvas */
  path: string
  /** Whether frames or sections (not just the camera) differ between two checkpoints */
  changed: (from: string, to: string) => Promise<boolean>
  /** Applies what changed in the layout from checkpoint `from` to `to` onto the board now */
  restore: (from: string, to: string) => Promise<void>
}

/**
 * What a turn asks the agent to fix, with what it's told about it: the preview's errors,
 * or why the app won't start. Null for the user's own message.
 */
type Fix = 'problems' | 'startup'

interface TurnRecord {
  turn: Turn
  /**
   * The message is one of the agent's slash commands: one that works on the session goes
   * `alone`; any other goes `with` the message's context, placed where the agent reads it.
   */
  command: 'alone' | 'with' | null
  fix: Fix | null
  before: string | null
  after: string | null
  cancelRequested: boolean
  settled: Promise<void>
}

interface QueuedPayload {
  recordings?: RecordingAttachment[]
  followUp?: FollowUp | null
  textEdit?: TextEdit | null
  images: ImageAttachment[]
  selection: Picked[]
  /** The viewport the message was written in; null when that's unknown */
  viewport: PromptViewport | null
  /** Set for "Fix with agent" waiting its turn: its report is written when it starts */
  fix?: 'startup'
}

interface RedoPoint {
  sha: string
  paths: string[]
  turnIds: string[]
}

/** The checkpoint Gui last recorded the files at; `complete` is false when a turn's end went unrecorded. */
interface Baseline {
  sha: string
  complete: boolean
}

const START_TIMEOUT_MS = 60_000
/** A model or effort change the agent doesn't answer counts as refused. */
const SETTING_TIMEOUT_MS = 10_000
const PERSIST_DELAY_MS = 400
/** While a turn streams: often enough that a crash loses little, without rewriting the file constantly. */
const PERSIST_RUNNING_MS = 1500
const RESET_SETTLE_MS = 5000
/** How long Stop waits for the agent to end the turn before stopping the agent itself. */
const CANCEL_SETTLE_MS = 10_000
/**
 * How long the command menu waits, once an agent started early for it, for the commands
 * to arrive: agents report them just after the session starts, not with it.
 */
const COMMANDS_WAIT_MS = 2000
/** Paths listed in the overwrite warning before it summarizes the rest. */
const OVERWRITE_LIST_MAX = 8

/** The errors may be the preview's or the dev server's; the prompt lists them with their source. */
const FIX_PROMPT = 'The app has errors. Find the cause and fix them.'
/** What "Fix with agent" on a failed start asks; Gui's report on it rides along. */
export const STARTUP_PROMPT = "My app won't start. Find out why and fix it."

/** What an image sent without text asks for; also what the transcript and history show. */
const imagePrompt = (count: number) =>
  `Use the attached ${count === 1 ? 'image' : 'images'} as a reference.`

/** What a message asks the agent; empty when there's nothing to send. */
const messagePrompt = (text: string, images: ImageAttachment[]) =>
  text.trim() || (images.length ? imagePrompt(images.length) : '')

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const isFinished = (status: ToolStatus) => status === 'completed' || status === 'failed'

const isWorking = (item: SubagentItem) => item.status === 'running' || item.status === 'waiting'

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
  /** Whether the running agent session was given Gui's preview tools. */
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
  /** The replacement under way and those waiting behind it (see `replace`). */
  private replacing: Promise<unknown> = Promise.resolve()
  /** Bumped by reset; work started in an older epoch must not touch current state. */
  private epoch = 0
  /** False after dispose or a reset that bumped `epoch`; late async work must not apply. */
  private live(epoch = this.epoch) {
    return !this.disposed && this.epoch === epoch
  }
  /** After dispose, nothing snapshots, saves, or emits. */
  private disposed = false
  private permissions = new Map<string, PermissionResolver>()
  private turnPublisher = new TurnPublisher()
  private emitTimers = new Map<string, NodeJS.Timeout>()
  private redoPoint: RedoPoint | null = null
  /** Named and pre-restore versions, oldest first; turn versions are derived from records. */
  private savedVersions: Version[] = []
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
  /** This transcript's id, kept when it's archived and reopened (see SavedChat) */
  private chatId: string = randomUUID()
  private createdAt = Date.now()
  private title: string | null = null
  /**
   * The agent this transcript's turns ran with, which it's archived under. Switching agents
   * changes `meta.agentId` before the transcript is archived.
   */
  private transcriptAgent: AgentId | null = null
  /** Resolved on the first request the agent asks about, then kept. */
  private editScope: Promise<EditScope> | null = null
  /** The running session's model and effort, as the agent last reported them. */
  private sessionModels: ModelSettings | null = null
  /** Choices the running session refused, by config id, so every turn doesn't retry them. */
  private refused = new Map<string, string>()
  /** The running session's setting changes, one at a time, so the last one sent sticks. */
  private settingChanges: Promise<void> = Promise.resolve()
  /**
   * The Ask or Auto the running session's own permission controls were last set to; null
   * until they are. Only a new session or a change of Ask or Auto sets them again, so a
   * mode the user or agent picks in between stays.
   */
  private sessionPolicy: PermissionPolicy | null = null
  /** The slash commands each agent last offered in this project (see ChatMeta.commands) */
  private knownCommands: Map<AgentId, AgentCommand[]>
  /**
   * The skills an agent that loads them by name (OpenCode, fx) can use here, as last found
   * on disk; listed with its commands but never saved with them.
   */
  private skills: { agentId: AgentId; list: AgentCommand[] } | null = null
  /**
   * An agent starting before any message, so the command menu can list what it offers (see
   * loadCommands). Resolves true once it's running; never rejects. The first turn waits on it.
   */
  private warming: Promise<boolean> | null = null
  /** loadCommands' wait: the early start, then the commands it brings. */
  private commandsLoading: Promise<void> | null = null
  /**
   * An agent started early began a new session in a chat that had one: the first turn
   * says so, as it would had it started the agent itself.
   */
  private newSessionNotice = false
  /**
   * What each queued message (`meta.queue`, by id) takes to the agent: the full images and
   * what was picked, with its crops. The meta only carries thumbnails, to keep IPC small.
   */
  private queued = new Map<string, QueuedPayload>()
  private readonly history: HistoryWriter

  constructor(
    private readonly root: string,
    private readonly checkpoints: Checkpoints,
    private readonly options: ChatOptions,
  ) {
    super()
    const saved = options.saved
    const agentId = saved?.agentId ?? options.agentId
    this.knownCommands = new Map(Object.entries(saved?.commands ?? {}))
    this.meta = {
      ...this.agentFields(agentId),
      status: 'idle',
      error: null,
      errorDetail: null,
      modeName: null,
      modeIsUsual: false,
      selection: [],
      selectionError: null,
      selecting: false,
      canSelect: false,
      canvas: !!options.board,
      canvasEmpty: false,
      minimized: false,
      docked: options.docked,
      sidebarSide: getPrefs().chatSidebarSide,
      trafficLights: false,
      tabRow: false,
      popped: false,
      redoTurnIds: saved?.redo?.turnIds ?? [],
      archived: null,
      problems: [],
      queue: [],
      queuePaused: false,
      queuePauseReason: null,
      autoApprove: isAutoApprove(root),
      autoNoteSeen: getPrefs().autoNoteSeen,
    }
    this.load(saved)
    this.restoreQueue(saved?.queue ?? [])
    // Loaded from that file, so it's already saved there until something changes.
    this.history = new HistoryWriter(options.historyFile, () => this.savedChat(), {
      saved: saved !== null,
    })
    // A health check may list the agent's models, and another window may change the choice.
    agentHealth.on('change', this.refreshModels)
    agentHealth.on('change', this.refreshAgent)
    prefsEvents.on('change', this.refreshModels)
    prefsEvents.on('change', this.refreshAutoApprove)
  }

  snapshot(): ChatSnapshot {
    for (const record of this.records) {
      if (this.emitTimers.has(record.turn.id)) this.flushTurn(record)
    }
    return {
      meta: this.meta,
      turns: this.records.map((record) => record.turn),
      revisions: this.turnPublisher.revisions(),
    }
  }

  async setAgent(agentId: AgentId) {
    if (agentId === this.meta.agentId) return
    // Switch first, so a quick second switch compares against this one and the last call wins.
    this.patchMeta(this.agentFields(agentId))
    await this.reset()
    // Messages held for the last agent's setup can go now if this one is ready.
    this.refreshAgent()
  }

  /** What the meta says about the chat's agent, for a chat that switches to `agentId`. */
  private agentFields(agentId: AgentId) {
    return {
      agentId,
      agentName: agentName(agentId),
      models: availableModels(agentId),
      commands: this.commandsFor(agentId),
      agent: agentHealth.list().find((agent) => agent.id === agentId) ?? null,
      ownPermissions: declaresOwnPermissions(agentId),
    }
  }

  /**
   * Archives this chat and starts an empty one: the agent process goes, and the next message
   * starts a fresh session. False when the chat couldn't be archived, and so was kept.
   */
  reset() {
    return this.replace(null)
  }

  /** Brings back an archived chat in place of this one, which is archived in turn. */
  async openArchived(id: string) {
    if (this.lock) throw new Error('Wait for the agent to finish first.')
    // A copy of the open chat (left by a crash between archiving and saving): it's open already.
    if (id === this.chatId) return removeArchived(this.root, id)
    const saved = await loadArchived(this.root, id)
    if (!saved) throw new Error('That chat is no longer in the archive.')
    if (this.lock) throw new Error('Wait for the agent to finish first.')
    if (!(await this.replace(saved)))
      throw new Error("This chat couldn't be archived, so it's still open.")
  }

  /** The archive copy of this chat, for the archive itself and the "archived" notice. */
  private archiveCopy(): SavedChat {
    // Its queue stays with the open chat (it's cleared by then anyway).
    const { queue: _queue, ...saved } = this.savedChat()
    return { ...saved, agentId: this.transcriptAgent ?? this.meta.agentId }
  }

  /**
   * Stops whatever is running, archives the transcript (when it has turns), and puts `next`
   * (or an empty chat) in its place. An archive that fails keeps the transcript where it is.
   * One at a time, in the order asked: two at once would both archive the chat the first is
   * leaving, and the second would overwrite the one the first opened.
   */
  private replace(next: SavedChat | null) {
    const token = {}
    this.lock = token
    this.epoch++
    // Messages queued for the old chat go with it; ones sent while this runs are for the new one.
    this.clearQueue()
    const done = this.replacing.then(() => this.swap(next, token))
    this.replacing = done.catch(() => undefined)
    return done
  }

  private async swap(next: SavedChat | null, token: object) {
    // Closed while it waited: the final save kept the transcript.
    if (this.disposed) return false
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
    const leaving = this.archiveCopy()
    let archived: SavedChat | null = null
    try {
      if (leaving.turns.length > 0 && (await archiveChat(this.root, leaving))) archived = leaving
    } catch (error) {
      console.error('[gui] failed to archive chat', error)
      if (this.lock === token) this.lock = null
      if (!this.disposed) {
        // An agent switch is undone with it: the kept transcript's session is its agent's.
        const agentId = this.transcriptAgent ?? this.meta.agentId
        this.patchMeta({
          ...(agentId !== this.meta.agentId ? this.agentFields(agentId) : {}),
          status: 'idle',
          error: "This chat couldn't be archived, so it's still here.",
          errorDetail: error instanceof Error ? error.message : String(error),
        })
      }
      this.drainQueue()
      return false
    }
    if (this.disposed) return false
    this.load(next)
    this.schedulePersist()
    if (this.lock === token) this.lock = null
    const agentId = next?.agentId ?? this.meta.agentId
    this.patchMeta({
      ...(agentId !== this.meta.agentId ? this.agentFields(agentId) : {}),
      status: 'idle',
      error: null,
      errorDetail: null,
      modeName: null,
      modeIsUsual: false,
      redoTurnIds: next?.redo?.turnIds ?? [],
      // Offered back only from an empty chat; one brought back was opened from the list.
      archived:
        archived && !next ? { id: archived.id, agentName: agentName(archived.agentId) } : null,
    })
    this.emit('reset', this.snapshot())
    this.drainQueue()
    // Now the live chat, which the live file keeps: out of the archive before the next
    // replacement, which may put it back.
    if (next) {
      await removeArchived(this.root, next.id).catch((error: unknown) => {
        console.error('[gui] failed to remove a reopened chat from the archive', error)
      })
    }
    return true
  }

  /** Takes on a saved transcript, or with none, an empty one. */
  private load(saved: SavedChat | null) {
    this.turnPublisher.clear()
    this.records =
      saved?.turns.map((turn) => ({
        turn,
        command: null,
        fix: null,
        before: saved.checkpoints[turn.id]?.before ?? null,
        after: saved.checkpoints[turn.id]?.after ?? null,
        cancelRequested: false,
        settled: Promise.resolve(),
      })) ?? []
    this.redoPoint = saved?.redo ?? null
    this.savedVersions = saved?.versions ?? []
    this.sessionId = saved?.sessionId ?? null
    this.resumeSessionId = this.sessionId
    this.primed =
      saved?.primed && saved.primedVersion === PROMPT_VERSION
        ? saved.primedWithTools
          ? 'tools'
          : 'plain'
        : null
    this.hadSession = this.records.length > 0
    // Its agent was stopped with the chat it was started for.
    this.warming = null
    this.commandsLoading = null
    this.newSessionNotice = false
    this.chatId = saved?.id ?? randomUUID()
    this.createdAt = saved?.createdAt ?? Date.now()
    this.title = saved?.title ?? null
    this.transcriptAgent = saved && saved.turns.length > 0 ? saved.agentId : null
    // Its clips are the chat's again, so closing the tab doesn't discard them.
    if (saved) {
      this.options.recordings.retain(
        saved.turns.flatMap((turn) => turn.recordings?.map((clip) => clip.id) ?? []),
      )
    }
  }

  /**
   * Messages left waiting when Gui last closed. They come back paused: the turn they were
   * waiting on was cut short, so they go out when the user says.
   */
  private restoreQueue(saved: SavedQueued[]) {
    if (saved.length === 0) return
    for (const { message, images, selection, viewport, fix } of saved) {
      this.queued.set(message.id, {
        images,
        recordings: message.recordings ?? [],
        followUp: message.followUp ?? null,
        textEdit: message.textEdit ?? null,
        selection,
        viewport,
        ...(fix ? { fix } : {}),
      })
    }
    this.options.recordings.retain(
      saved.flatMap(({ message }) => message.recordings?.map((clip) => clip.id) ?? []),
    )
    this.meta = {
      ...this.meta,
      queue: saved.map(({ message }) => message),
      queuePaused: true,
      queuePauseReason: 'restored',
    }
  }

  setSelection(selection: Picked[]) {
    this.patchMeta({ selection, selectionError: null })
  }

  /** Adds a pick to the selection, after what's already picked. */
  addToSelection(picked: Picked) {
    this.setSelection([...this.meta.selection, picked])
  }

  removeFromSelection(id: string) {
    const selection = this.meta.selection.filter((picked) => picked.id !== id)
    if (selection.length !== this.meta.selection.length) this.setSelection(selection)
  }

  setSelectionError(message: string) {
    this.patchMeta({ selectionError: message })
  }

  setSelecting(selecting: boolean) {
    if (selecting !== this.meta.selecting) this.patchMeta({ selecting })
  }

  setCanSelect(canSelect: boolean) {
    if (canSelect !== this.meta.canSelect) this.patchMeta({ canSelect })
  }

  setCanvasEmpty(canvasEmpty: boolean) {
    if (canvasEmpty !== this.meta.canvasEmpty) this.patchMeta({ canvasEmpty })
  }

  setMinimized(minimized: boolean) {
    this.patchMeta({ minimized })
  }

  setPopped(popped: boolean) {
    if (popped !== this.meta.popped) this.patchMeta({ popped, minimized: false })
  }

  setTrafficLights(trafficLights: boolean) {
    if (trafficLights !== this.meta.trafficLights) this.patchMeta({ trafficLights })
  }

  setTabRow(tabRow: boolean) {
    if (tabRow !== this.meta.tabRow) this.patchMeta({ tabRow })
  }

  setSidebarSide(sidebarSide: 'left' | 'right') {
    if (sidebarSide !== this.meta.sidebarSide) this.patchMeta({ sidebarSide })
  }

  setDocked(docked: boolean) {
    this.patchMeta({ docked, minimized: false })
  }

  setProblems(problems: Problem[]) {
    this.patchMeta({ problems })
  }

  /**
   * The user's model or effort choice, saved for this agent so later sessions start with
   * it. A running session switches now when it's between turns, else before the next prompt.
   */
  setAgentSetting(configId: string, value: string) {
    if (!offersChoice(this.meta.models, configId, value)) return
    // Picking it again is a reason to try again.
    this.refused.delete(configId)
    saveAgentSetting(this.meta.agentId, configId, value)
    this.refreshModels()
    const agent = this.agent
    if (agent && this.agentInfo && !this.active) void this.applySettings(agent, null)
  }

  /**
   * The agent's login expired mid-chat: runs its sign-in, and once it's signed in, ends the
   * session that still holds the old login, so the next message starts one that has it.
   */
  async signInAgain() {
    const id = this.meta.agentId
    await agentHealth.signIn(id)
    const signedIn = agentHealth.list().find((agent) => agent.id === id)?.status === 'ready'
    if (signedIn && !this.active) this.stopAgent()
    return signedIn
  }

  /**
   * Asks the agent to fix what's currently broken; the errors ride along in the prompt.
   * A pending element selection is left for the user's next message.
   */
  fixProblems() {
    if (this.meta.problems.length === 0) return false
    return this.startTurn(FIX_PROMPT, 'problems')
  }

  /**
   * Asks the agent to get the app running, with Gui's report on why it isn't. Like a message,
   * it waits its turn behind one in progress, or for the agent to be set up; its report is
   * written when it starts, so it says how things are then.
   */
  fixStartup() {
    if (this.disposed) return false
    const waiting = this.meta.queue.some((item) => this.queued.get(item.id)?.fix === 'startup')
    if (waiting) return true
    // Already on it: a second click doesn't ask again.
    const last = this.records.at(-1)
    if (last?.fix === 'startup' && last.turn.status === 'running') return true
    if (this.lock) return this.enqueueStartup()
    if (needsSetup(this.meta.agent)) {
      this.enqueueStartup()
      this.patchMeta({ queuePaused: true, queuePauseReason: 'setup' })
      return true
    }
    return this.startTurn(STARTUP_PROMPT, 'startup')
  }

  private enqueueStartup() {
    const item: QueuedMessage = {
      id: randomUUID(),
      prompt: STARTUP_PROMPT,
      context: [],
      attachments: [],
      recordings: [],
    }
    this.queued.set(item.id, {
      images: [],
      recordings: [],
      selection: [],
      viewport: this.options.viewport(),
      fix: 'startup',
    })
    this.patchMeta({ queue: [...this.meta.queue, item] })
    return true
  }

  /** Whether a turn, undo or redo is in progress. */
  get busy() {
    return this.lock !== null
  }

  /** A permission card is waiting for the user's answer. */
  get awaitingPermission() {
    return this.permissions.size > 0
  }

  /** The permission card waiting longest for an answer, and its turn; null when none is. */
  oldestPermission(): { turnId: string; item: PermissionItem } | null {
    for (const { turn } of this.records) {
      for (const item of turn.items) {
        if (item.kind === 'permission' && this.permissions.has(`${turn.id}:${item.id}`)) {
          return { turnId: turn.id, item }
        }
      }
    }
    return null
  }

  /**
   * Starts a turn, or queues the message (`meta.queue`) while another operation is in
   * progress. Returns false only when nothing was accepted (an empty message, or disposed).
   * Images alone are a complete message: they're sent with a default prompt. `followUpId`
   * is an earlier turn the message is about; one that's gone is ignored.
   */
  send(
    text: string,
    images: ImageAttachment[] = [],
    recordings: RecordingAttachment[] = [],
    followUpId: string | null = null,
  ): boolean {
    return this.submit(text, images, recordings, this.followUpFor(followUpId), null)
  }

  /**
   * Asks the agent to make a text edit from the preview in the source, as a message would:
   * it starts a turn or waits its turn, with the element picked. The message is Gui's fixed
   * words; the old and new text were read from the page, so they ride along as page data.
   */
  sendTextEdit(edit: TextEdit): boolean {
    return this.submit(TEXT_EDIT_PROMPT, [], [], null, edit)
  }

  private submit(
    text: string,
    images: ImageAttachment[],
    recordings: RecordingAttachment[],
    followUp: FollowUp | null,
    textEdit: TextEdit | null,
  ): boolean {
    if (this.lock && !this.disposed)
      return this.enqueue(text, images, recordings, followUp, textEdit)
    // An agent that isn't installed or signed in can't take it yet: it waits, with the setup
    // step above it, and goes out once the agent is ready (refreshAgent).
    if (needsSetup(this.meta.agent)) {
      if (!this.enqueue(text, images, recordings, followUp, textEdit)) return false
      this.patchMeta({ queuePaused: true, queuePauseReason: 'setup' })
      return true
    }
    return this.startTurn(text, null, images, null, recordings, followUp, textEdit)
  }

  private followUpFor(turnId: string | null): FollowUp | null {
    const turn = turnId ? this.records.find((record) => record.turn.id === turnId)?.turn : null
    return turn ? { turnId: turn.id, number: turn.index + 1, prompt: turn.prompt } : null
  }

  /**
   * Sets up the chat's agent from the chat: downloads it if Gui can, signs in, or checks it
   * again (`agentHealth.connect`). Messages held for it go out once it's ready.
   */
  setUpAgent() {
    return agentHealth.connect(this.meta.agentId)
  }

  removeQueued(id: string) {
    const queue = this.meta.queue.filter((item) => item.id !== id)
    if (queue.length === this.meta.queue.length) return
    this.queued.delete(id)
    // An empty queue has nothing to hold back.
    if (queue.length > 0) this.patchMeta({ queue })
    else this.patchMeta({ queue, queuePaused: false, queuePauseReason: null })
  }

  /** Drops every queued message. */
  clearQueued() {
    if (this.meta.queue.length === 0) return
    this.clearQueue()
  }

  /**
   * Rewrites a queued message's text; what it carries (the pick, images, clips, a text edit
   * from the preview) stays, and stays apart from the text.
   * Text that leaves nothing to ask (empty, with nothing attached) changes nothing.
   */
  editQueued(id: string, text: string) {
    const item = this.meta.queue.find((queued) => queued.id === id)
    if (!item) return
    const payload = this.queued.get(id)
    const prompt =
      messagePrompt(text, payload?.images ?? []) ||
      (item.recordings?.length
        ? 'Inspect the attached preview recording, especially its animations.'
        : '')
    if (!prompt || prompt === item.prompt) return
    this.patchMeta({
      queue: this.meta.queue.map((queued) => (queued.id === id ? { ...queued, prompt } : queued)),
    })
  }

  /** Moves a queued message to `index` in the queue (0 runs next). */
  moveQueued(id: string, index: number) {
    const queue = [...this.meta.queue]
    const from = queue.findIndex((item) => item.id === id)
    const item = queue[from]
    if (!item || !Number.isFinite(index)) return
    const to = Math.max(0, Math.min(queue.length - 1, Math.floor(index)))
    if (to === from) return
    queue.splice(from, 1)
    queue.splice(to, 0, item)
    this.patchMeta({ queue })
  }

  /** Resumes a paused queue; when nothing is running, its next message starts now. */
  sendQueuedNow() {
    if (this.disposed) return
    if (this.meta.queuePaused) this.patchMeta({ queuePaused: false, queuePauseReason: null })
    this.drainQueue()
  }

  /**
   * Sends one queued message ahead of the rest: it starts now when nothing is running
   * (the others stay held if the queue was paused), and otherwise moves to the front,
   * so it runs next.
   */
  sendQueued(id: string) {
    if (this.disposed) return
    const item = this.meta.queue.find((queued) => queued.id === id)
    if (!item) return
    if (this.lock) {
      if (this.meta.queuePaused) this.patchMeta({ queuePaused: false, queuePauseReason: null })
      this.moveQueued(id, 0)
      return
    }
    this.startQueued(
      item,
      this.meta.queue.filter((queued) => queued.id !== id),
    )
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
      const agent = this.agent
      await agent?.cancel().catch(() => undefined)
      // The agent stops the subagents it waits on; ones it left working in the background
      // would go on unseen once the turn ends.
      for (const item of this.subagentsOf(record)) {
        if (agent && item.canStop && isWorking(item)) {
          void agent.cancelSubagent(item.id).catch(() => undefined)
        }
      }
      if (agent) void this.stopIfCancelIgnored(agent, record)
    }
  }

  /**
   * Stops one subagent of the running turn, when the agent allows it: the agent and its other
   * subagents go on. Its questions still open go with it.
   */
  stopSubagent(turnId: string, subagent: string) {
    const record = this.active
    const agent = this.agent
    if (!record || !agent || record.turn.id !== turnId || record.cancelRequested) return
    const item = this.subagentsOf(record).find((candidate) => candidate.id === subagent)
    if (!item?.canStop || !isWorking(item)) return
    void agent.cancelSubagent(subagent).catch(() => undefined)
    for (const asked of record.turn.items) {
      if (asked.kind === 'permission' && asked.subagent === subagent && asked.resolved === null) {
        this.respondPermission(turnId, asked.id, null)
      }
    }
  }

  /**
   * A cancel is only a request. An agent that ignores it (hung, deadlocked) would hold the
   * turn, and everything queued after it, forever: stop it, and resume its session next time.
   */
  private async stopIfCancelIgnored(agent: AgentSession, record: TurnRecord) {
    const settled = await Promise.race([
      record.settled.then(
        () => true,
        () => true,
      ),
      sleep(CANCEL_SETTLE_MS).then(() => false),
    ])
    if (settled || this.disposed || this.agent !== agent || this.active !== record) return
    this.stopAgent()
    this.resumeSessionId = this.sessionId
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
    if (!record || !before) throw new Error('This message has no version to restore.')
    if (record.turn.reverted) throw new Error('This message is already undone.')
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
      const message = `before restoring message ${record.turn.index + 1}`
      const current = await this.checkpoints.snapshot(message)
      const { paths, inferred } = await this.changedPaths(undone, current)
      if (!(await this.confirmOverwrite(baseline, current, before, paths, inferred, 'Undo'))) return
      if (!this.live(epoch)) return
      // Record the way back first, so a restore that fails halfway can still be redone. Taken
      // again because files may have been saved while the confirmation was open.
      const latest = await this.checkpoints.snapshot(message)
      if (!this.live(epoch)) return
      const turnIds = undone.map((r) => r.turn.id)
      // Later turns already undone and waiting to be redone: undoing further back keeps them,
      // so one Redo brings every turn back. Their point was taken with all of them in place,
      // which is where redo puts this turn's files too.
      const waiting = this.redoPoint
      const keeps =
        waiting?.turnIds.every((id) => {
          const r = this.records.find((candidate) => candidate.turn.id === id)
          return !!r && r.turn.reverted && r.turn.index > record.turn.index
        }) === true
      this.redoPoint =
        waiting && keeps
          ? {
              sha: waiting.sha,
              paths: [...new Set([...paths, ...waiting.paths])],
              turnIds: [...turnIds, ...waiting.turnIds],
            }
          : { sha: latest, paths, turnIds }
      for (const r of undone) {
        r.turn.reverted = true
        this.flushTurn(r)
      }
      this.patchMeta({ redoTurnIds: this.redoPoint.turnIds })
      this.schedulePersist()
      const alone = await this.checkpoints.restore(before, paths)
      this.noteLeftAlone(record, 'Undo', alone)
      // The layout the turns left (their last checkpoint), back to how it was before them.
      await this.restoreLayout(baseline?.sha ?? latest, before)
    } finally {
      if (this.lock === token) this.lock = null
      // Messages sent while it ran waited for the files to settle.
      this.drainQueue()
    }
  }

  /** Whether the running turn has started a tool, so the preview may already show its changes. */
  /** A turn is running (not an undo or redo); changes come with a `turn` event. */
  get turnRunning() {
    return this.active !== null
  }

  /**
   * The turn the agent is working on, or null once none is or the user stopped it: late work
   * for a turn compares it with the one it started in, the way `epoch` is used here.
   */
  get workingTurnId() {
    const record = this.active
    return record && !record.cancelRequested ? record.turn.id : null
  }

  activeTurnUsedTools() {
    return this.active?.turn.items.some((item) => item.kind === 'tool') ?? false
  }

  /** The newest turn that can be undone, if any; for Edit → Undo. */
  lastUndoableTurnId() {
    if (this.lock) return null
    const record = this.records.findLast((r) => r.before && !r.turn.reverted)
    return record?.turn.id ?? null
  }

  /** Adds the after-hot-reload image of the picked element to a finished turn. */
  setPreviewAfter(turnId: string, after: string | null, frame: PreviewFrame | null = null) {
    const record = this.records.find((r) => r.turn.id === turnId)
    if (!record || !after) return
    const before = record.turn.preview?.before ?? null
    record.turn.preview = {
      before,
      after,
      frame,
      size: thumbnailSize(after),
      fill: cornerColor(after),
    }
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
      const first = this.records.find((r) => point.turnIds.includes(r.turn.id))
      const restored = first?.before ?? null
      await this.requireCheckpoints([point.sha, restored], "so they can't be redone")
      const paths = this.restorable(point.paths)
      if (restored) {
        const current = await this.checkpoints.snapshot('before redo')
        const baseline = { sha: restored, complete: true }
        if (!(await this.confirmOverwrite(baseline, current, point.sha, paths, [], 'Redo'))) return
        if (!this.live(epoch)) return
      }
      const alone = await this.checkpoints.restore(point.sha, paths)
      if (restored) await this.restoreLayout(restored, point.sha)
      // A chat opened meanwhile has its own turns to redo.
      if (!this.live(epoch)) return
      if (first) this.noteLeftAlone(first, 'Redo', alone)
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
      this.drainQueue()
    }
  }

  /**
   * Every version of the project's files this chat knows, newest first: each finished
   * turn's end, the versions the user named, and the states saved before a restore.
   * The one the files match now is marked `current`.
   */
  async listVersions(): Promise<Version[]> {
    const versions = this.versions()
    if (versions.length === 0 || this.disposed) return versions
    // A fresh snapshot says which version the files are at; without one, none is marked.
    const here = await this.checkpoints.snapshot('version list').catch(() => null)
    if (!here || this.disposed) return versions
    const trees = await this.checkpoints
      .trees([here, ...versions.map((version) => version.sha)])
      .catch(() => null)
    const tree = trees?.get(here)
    if (!trees || !tree) return versions
    return versions.map((version) => ({ ...version, current: trees.get(version.sha) === tree }))
  }

  /** Saves the files as they are now under `name`, kept until the chat's versions fill up. */
  async saveVersion(name: string): Promise<Version> {
    const cleaned = versionName(name)
    if (!cleaned) throw new Error('Add a name for this version first.')
    if (this.lock) throw new Error('Wait for the agent to finish first.')
    if (this.disposed) throw new Error('This chat is closed.')
    const token = {}
    this.lock = token
    try {
      const previous = this.versions()[0]?.sha ?? null
      const sha = await this.checkpoints.snapshot(`version: ${cleaned}`)
      const changes =
        previous && previous !== sha
          ? await this.checkpoints.diff(previous, sha).catch(() => null)
          : null
      const version: Version = {
        id: randomUUID(),
        sha,
        kind: 'named',
        name: cleaned,
        createdAt: Date.now(),
        changes,
      }
      this.keepVersion(version)
      this.schedulePersist()
      return { ...version, current: true }
    } finally {
      if (this.lock === token) this.lock = null
      this.drainQueue()
    }
  }

  /**
   * Puts the project's files back to a version. How they are now is saved first (as a
   * `safety` version), so restoring can itself be restored. Files checkpoints never
   * record (secrets, ignored files, big files) are left alone.
   */
  async restoreVersion(id: string): Promise<void> {
    if (this.lock) throw new Error('Wait for the agent to finish first.')
    if (this.disposed) throw new Error('This chat is closed.')
    const version = this.versions().find((candidate) => candidate.id === id)
    if (!version) {
      throw new Error('That version is no longer here. Reopen Versions to see the current list.')
    }
    const token = {}
    const epoch = this.epoch
    this.lock = token
    try {
      await this.requireCheckpoints([version.sha], "so this version can't be restored")
      const current = await this.checkpoints.snapshot(`before restoring ${version.name}`)
      const changed = await this.pathsBetween(version.sha, current)
      const paths = this.restorable(changed)
      // A canvas's camera alone isn't a change to restore.
      const layout =
        paths.length !== changed.length &&
        (await this.options.layout?.changed(version.sha, current).catch(() => true)) === true
      if ((paths.length === 0 && !layout) || !this.live(epoch)) return
      // Record the way back before touching a file, so even a restore that stops
      // halfway can be taken back from the safety version.
      this.keepVersion({
        id: randomUUID(),
        sha: current,
        kind: 'safety',
        name: `Before restoring “${version.name}”`,
        createdAt: Date.now(),
        changes: null,
      })
      this.schedulePersist()
      await this.checkpoints.restore(version.sha, paths)
      if (layout) await this.restoreLayout(current, version.sha)
    } finally {
      if (this.lock === token) this.lock = null
      this.drainQueue()
    }
  }

  /** Turn ends and saved versions together, newest first. */
  private versions(): Version[] {
    const turns: Version[] = []
    for (const { turn, after } of this.records) {
      if (!after || turn.status === 'running') continue
      turns.push({
        id: `turn:${turn.id}`,
        sha: after,
        kind: 'turn',
        name: versionName(turn.prompt) || `Message ${turn.index + 1}`,
        createdAt: turn.endedAt ?? turn.startedAt,
        changes: turn.changes,
        turnId: turn.id,
        reverted: turn.reverted,
      })
    }
    return [...turns, ...this.savedVersions].sort((a, b) => b.createdAt - a.createdAt)
  }

  private keepVersion(version: Version) {
    this.savedVersions = [...this.savedVersions, version].slice(-MAX_VERSIONS)
  }

  dispose(): Promise<void> {
    if (this.disposed) return this.history.close()
    this.epoch++
    this.disposed = true
    agentHealth.off('change', this.refreshModels)
    agentHealth.off('change', this.refreshAgent)
    prefsEvents.off('change', this.refreshModels)
    prefsEvents.off('change', this.refreshAutoApprove)
    // Settle open prompts before the final save, so it records them as cancelled
    // rather than leaving buttons that nothing answers after a relaunch.
    for (const record of this.records) this.resolvePendingPermissions(record)
    for (const resolve of this.permissions.values()) resolve(null)
    this.permissions.clear()
    for (const timer of this.emitTimers.values()) clearTimeout(timer)
    this.emitTimers.clear()
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = null
    // A turn or reset under way changes the chat without saving as it goes (its checkpoints,
    // the prompts just settled): the final save records it as it stands.
    if (this.active || this.lock) this.history.changed()
    // The final save keeps the queue, so it's back when the chat next opens.
    const saved = this.history.close()
    this.stopAgent()
    this.clearQueue()
    this.removeAllListeners()
    return saved
  }

  /**
   * `fix` turns carry what's to fix (the current problems, or the start report) and leave
   * the pending selection alone. A `queued` message brings the element it was sent with,
   * and leaves the current one too.
   */
  private startTurn(
    text: string,
    fix: Fix | null,
    images: ImageAttachment[] = [],
    queued: QueuedPayload | null = null,
    recordings: RecordingAttachment[] = queued?.recordings ?? [],
    followUp: FollowUp | null = queued?.followUp ?? null,
    textEdit: TextEdit | null = queued?.textEdit ?? null,
  ): boolean {
    const prompt =
      messagePrompt(text, images) ||
      (recordings.length
        ? 'Inspect the attached preview recording, especially its animations.'
        : '')
    if (!prompt || this.lock || this.disposed) return false

    // A session command (/compact, /rename…) goes to the agent alone: the picked element
    // stays for the next message, and images aren't sent with it. Any other command
    // (a skill, /review) takes them along.
    const invoked = fix ? null : invokedCommand(prompt, this.meta.commands)
    const command = invoked ? (takesContext(invoked) ? 'with' : 'alone') : null
    if (command === 'alone') {
      images = []
      recordings = []
      followUp = null
      textEdit = null
    }
    const picked = queued ? queued.selection : fix ? [] : this.meta.selection
    const selection = command === 'alone' ? [] : picked
    const shown = primaryPick(selection)
    const viewport = queued?.viewport ?? this.options.viewport()
    const record: TurnRecord = {
      turn: {
        id: randomUUID(),
        index: this.records.length,
        prompt,
        context: withoutScreenshots(selection),
        // The after image is added by the window once the change has hot-reloaded. A queued
        // pick's crop predates the turns that ran before it, so it can't stand for "before".
        preview:
          shown?.screenshot && !queued
            ? { before: thumbnail(shown.screenshot), after: null }
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
        recordings,
        ...(followUp ? { followUp } : {}),
        ...(textEdit ? { textEdit } : {}),
        reverted: false,
      },
      command,
      fix,
      before: null,
      after: null,
      cancelRequested: false,
      settled: Promise.resolve(),
    }
    this.records.push(record)
    this.active = record
    this.lock = record
    this.transcriptAgent ??= this.meta.agentId
    if (this.meta.archived) this.patchMeta({ archived: null })
    if (!fix && !queued && command !== 'alone') this.patchMeta({ selection: [] })
    this.flushTurn(record)
    // Auto's note under the message box was there for this first message; from now on the
    // Auto control's tooltip says it.
    if (this.autoApproves && !getPrefs().autoNoteSeen) setPrefs({ autoNoteSeen: true })
    // The problems the user asked to fix; by prompt time a hot reload may have cleared them.
    const problems = fix === 'problems' ? this.meta.problems : []
    record.settled = this.runTurn(record, selection, viewport, problems, images, this.epoch)
    return true
  }

  /** Holds a message until the current operation is over; it takes the picked element along. */
  private enqueue(
    text: string,
    images: ImageAttachment[],
    recordings: RecordingAttachment[] = [],
    followUp: FollowUp | null = null,
    textEdit: TextEdit | null = null,
  ): boolean {
    const prompt =
      messagePrompt(text, images) ||
      (recordings.length
        ? 'Inspect the attached preview recording, especially its animations.'
        : '')
    if (!prompt) return false
    const selection = this.meta.selection
    const item: QueuedMessage = {
      id: randomUUID(),
      prompt,
      context: withoutScreenshots(selection),
      attachments: images.map(({ name, thumbnail }) => ({ name, thumbnail })),
      recordings,
      ...(followUp ? { followUp } : {}),
      ...(textEdit ? { textEdit } : {}),
    }
    this.queued.set(item.id, {
      images,
      recordings,
      followUp,
      textEdit,
      selection,
      viewport: this.options.viewport(),
    })
    this.patchMeta({ queue: [...this.meta.queue, item], selection: [] })
    return true
  }

  /** Starts the next queued message, unless something holds the lock or the queue is paused. */
  private drainQueue() {
    if (this.lock || this.disposed || this.meta.queuePaused) return
    const [next, ...rest] = this.meta.queue
    if (!next) return
    this.startQueued(next, rest)
  }

  /** Takes `next` off the queue (`rest` stays waiting) and starts its turn. */
  private startQueued(next: QueuedMessage, rest: QueuedMessage[]) {
    const payload = this.queued.get(next.id) ?? {
      images: [],
      followUp: next.followUp ?? null,
      textEdit: next.textEdit ?? null,
      selection: next.context,
      viewport: null,
    }
    this.queued.delete(next.id)
    // An empty queue has nothing to hold back.
    if (rest.length > 0) this.patchMeta({ queue: rest })
    else this.patchMeta({ queue: rest, queuePaused: false, queuePauseReason: null })
    this.startTurn(next.prompt, payload.fix ?? null, payload.images, payload)
  }

  private clearQueue() {
    this.queued.clear()
    this.patchMeta({ queue: [], queuePaused: false, queuePauseReason: null })
  }

  private async runTurn(
    record: TurnRecord,
    selection: Picked[],
    viewport: PromptViewport | null,
    problems: Problem[],
    images: ImageAttachment[],
    epoch: number,
  ) {
    const live = () => this.epoch === epoch
    const stopped = () => !live() || record.cancelRequested
    let status: TurnStatus = 'done'
    /** Why the queue waits after this turn rather than going on; null to go on. */
    let pause: QueuePauseReason | null = null
    let slot: { ready: Promise<void>; release: () => void } | null = null
    try {
      if (!(await this.confirmTrust())) {
        status = 'cancelled'
        pause = 'untrusted'
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
      // Covers choices made during the last turn and ones saved before this session started.
      await this.applySettings(agent, record)
      if (stopped()) {
        status = 'cancelled'
        return
      }
      slot = this.checkpoints.turnSlot()
      let free = false
      void slot.ready.then(() => {
        free = true
      })
      await sleep(0)
      if (!free) {
        this.pushItem(record, {
          kind: 'notice',
          id: randomUUID(),
          tone: 'info',
          text: 'Waiting for the agent in another tab on this folder to finish.',
        })
      }
      while (!free) {
        if (stopped()) {
          status = 'cancelled'
          return
        }
        await sleep(250)
      }
      record.before = await this.trySnapshot(record, `before message ${record.turn.index + 1}`)
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
      // A session command goes alone, so Gui's instructions wait for the next message.
      const preamble = record.command !== 'alone' && this.primedAgent !== agent
      const followUp = record.turn.followUp
      const earlier = followUp
        ? this.records.find((other) => other.turn.id === followUp.turnId)?.turn
        : null
      const blocks: ContentBlock[] =
        record.command === 'alone'
          ? []
          : buildPrompt({
              // A command is placed once everything else is in (placeCommand).
              text: record.command ? null : record.turn.prompt,
              selection,
              viewport,
              guides: this.options.guides?.() ?? null,
              board: this.options.board?.() ?? null,
              // Only Fix carries errors: they're usually unrelated to an ordinary request.
              problems,
              // Written now, after the agent is up: it says how the app is doing as the turn starts.
              startup:
                record.fix === 'startup' ? this.options.startupReport(this.agentHasTools) : null,
              preamble,
              tools: this.agentHasTools,
              images: info.supportsImages,
              attachments: images,
              followUp: earlier ? describeFollowUp(earlier, info.supportsImages) : [],
              textEdit: record.turn.textEdit ?? null,
            })
      // A narrated clip's transcript may still be on its way when the message is queued.
      const sent = record.turn.recordings ?? []
      const clips = sent.length
        ? await this.options.recordings
            .settled(
              sent.map((clip) => clip.id),
              30_000,
            )
            .catch(() => sent)
        : sent
      if (clips.length) record.turn.recordings = clips
      for (const clip of clips) {
        blocks.push(
          ...(await recordingBlocks(this.options.recordings, clip, {
            tools: this.agentHasTools,
            images: info.supportsImages,
          })),
        )
        if (!info.supportsImages) {
          this.pushItem(record, {
            kind: 'notice',
            id: randomUUID(),
            tone: 'info',
            text: `${this.meta.agentName} can't see recording frames, so it gets ${clip.narration?.status === 'done' ? 'what you said, ' : ''}where the pointer was and a timeline of what happened in the page instead: timing and elements, not appearance.`,
          })
        }
      }
      if (stopped()) {
        status = 'cancelled'
        return
      }
      const sending = record.command
        ? placeCommand(record.turn.prompt, blocks, agent.agentId)
        : blocks
      const response = await agent.prompt(sending)
      status = response.stopReason === 'cancelled' ? 'cancelled' : 'done'
      // Only a prompt the agent got through counts as delivering the instructions.
      if (preamble && status === 'done' && live() && this.agent === agent) {
        this.primedAgent = agent
        this.primed = this.agentHasTools ? 'tools' : 'plain'
        this.schedulePersist()
      }
      // Some commands (like Claude's /compact) finish without a word; say it ran.
      if (record.command && status === 'done' && record.turn.items.length === 0) {
        this.pushItem(record, {
          kind: 'notice',
          id: randomUUID(),
          tone: 'info',
          text: `Ran ${record.turn.prompt.split(/\s/, 1)[0]}.`,
        })
      }
      if (response.stopReason === 'refusal' || response.stopReason === 'max_tokens') {
        pause = response.stopReason === 'refusal' ? 'refused' : 'limit'
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
        if (error instanceof AgentAuthError) {
          // Every surface (start screen, Settings) now shows it signed out, with its sign-in.
          agentHealth.signedOut(this.meta.agentId, error)
          record.turn.error = error.message
          record.turn.signIn = true
        } else {
          const { message, detail } = describeError(error)
          record.turn.error = message
          record.turn.errorDetail = detail
        }
      }
    } finally {
      this.resolvePendingPermissions(record)
      // After dispose the final save already holds this turn as interrupted.
      if (record.before && !this.disposed) {
        record.after = await this.trySnapshot(record, `after message ${record.turn.index + 1}`)
        if (record.after && !this.disposed) {
          record.turn.changes = await this.turnChanges(record.before, record.after)
        }
      }
      slot?.release()
      this.settleSubagents(record, status)
      // Only now is the turn over; reporting it earlier would let a send race the snapshot.
      record.turn.status = status
      record.turn.endedAt = Date.now()
      if (this.active === record) this.active = null
      if (this.lock === record) this.lock = null
      this.flushTurn(record)
      if (live()) {
        if (this.meta.status === 'working') this.patchMeta({ status: 'ready' })
        this.emit('turnEnd', record.turn)
        if (record.fix === 'startup') this.emit('startupFixEnd', record.turn)
        // Settled (lock released, after snapshot taken), so the next message can start. Stop,
        // an error, a declined trust prompt, or a turn the agent refused or cut short holds
        // the rest back until the user resumes it: they were written expecting this one to work.
        pause ??= status === 'error' ? 'error' : status === 'cancelled' ? 'stopped' : null
        if (pause === null) this.drainQueue()
        else if (this.meta.queue.length > 0) {
          this.patchMeta({ queuePaused: true, queuePauseReason: pause })
        }
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
        detail: `${agent} loads this project's own agent settings (for example .claude/settings.json or opencode.json), which can run commands on your Mac. Gui won't ask again for this project. Only start projects you trust.`,
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

  /**
   * What the command menu lists, as it opens: the skills on disk for an agent that doesn't
   * list its own (looked for again each time, so one just added shows), and the agent's
   * commands (see loadAgentCommands). Resolves once both are in.
   */
  loadCommands(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    return Promise.all([this.loadSkills(), this.loadAgentCommands()]).then(() => undefined)
  }

  /** The commands as the composer lists them: the agent's own, then the skills Gui found. */
  private commandsFor(agentId: AgentId) {
    const own = this.knownCommands.get(agentId) ?? []
    return this.skills?.agentId === agentId ? withSkills(own, this.skills.list) : own
  }

  private knowsCommands() {
    return (this.knownCommands.get(this.meta.agentId)?.length ?? 0) > 0
  }

  private async loadSkills() {
    const agentId = this.meta.agentId
    const list = await findSkills(agentId, this.root)
    if (this.disposed || this.meta.agentId !== agentId) return
    if (this.skills?.agentId === agentId && sameJson(this.skills.list, list)) return
    this.skills = { agentId, list }
    this.patchMeta({ commands: this.commandsFor(agentId) })
  }

  /**
   * Starts the agent for this chat's first message without sending one, so the command menu
   * can list the agent's slash commands (they arrive through onUpdate). Resolves once they're
   * known, or the agent couldn't start, or it started and reported none for a moment; an
   * agent already running that offers none has nothing more to wait for. One load at a time,
   * so typing `/` again starts nothing more. Failing quietly leaves the first message to say why.
   */
  private loadAgentCommands(): Promise<void> {
    if (this.knowsCommands()) return Promise.resolve()
    if (this.commandsLoading) return this.commandsLoading
    if (this.agent && this.agentInfo) return Promise.resolve()
    const load = this.warmUp().then((started) => (started ? this.commandsArrive() : undefined))
    this.commandsLoading = load
    void load.then(() => {
      if (this.commandsLoading === load) this.commandsLoading = null
    })
    return load
  }

  /** Once the running agent reports its commands, or COMMANDS_WAIT_MS passes without them. */
  private commandsArrive() {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.off('meta', onMeta)
        resolve()
      }
      const onMeta = () => {
        if (this.knowsCommands()) done()
      }
      const timer = setTimeout(done, COMMANDS_WAIT_MS)
      if (this.knowsCommands()) return done()
      this.on('meta', onMeta)
    })
  }

  /** The early start behind loadCommands; one at a time, so typing `/` again starts nothing. */
  private warmUp(): Promise<boolean> {
    if (this.warming) return this.warming
    if (this.agent && this.agentInfo) return Promise.resolve(true)
    // A turn, restore or reset under way, an agent already starting, or an error the user
    // hasn't retried yet: the next message deals with the agent, as it would anyway.
    const busy = this.disposed || this.lock || this.agent || this.meta.status !== 'idle'
    if (busy) return Promise.resolve(false)
    const epoch = this.epoch
    const run = (async () => {
      if (!(await isTrusted(this.root))) return false
      if (this.epoch !== epoch || this.lock || this.agent) return false
      await this.ensureAgent(null)
      return true
    })().catch(() => false)
    this.warming = run
    void run.then(() => {
      if (this.warming === run) this.warming = null
    })
    return run
  }

  /**
   * The running agent, starting it when there isn't one. `record` is the turn it's for; null
   * for an early start (warmUp), which changes nothing the user sees unless it succeeds.
   */
  private async ensureAgent(
    record: TurnRecord | null,
  ): Promise<{ agent: AgentSession; info: AgentInfo }> {
    if (record && this.warming) {
      // Started early for the command menu: this turn takes that agent once it's up.
      this.patchMeta({ status: 'starting', error: null, errorDetail: null })
      await this.warming
      if (this.agent && this.agentInfo && this.meta.status === 'starting') {
        this.patchMeta({ status: 'ready' })
      }
    }
    if (record && this.newSessionNotice) {
      this.newSessionNotice = false
      this.pushNewSessionNotice(record)
    }
    if (this.agent && this.agentInfo) {
      if (!this.agent.restartsFor(this.policy())) return { agent: this.agent, info: this.agentInfo }
      // The agent only takes Ask or Auto as a session starts: pick the conversation back
      // up under the new one.
      this.resumeSessionId = this.sessionId
    }
    this.stopAgent()
    const name = this.meta.agentName
    if (record) this.patchMeta({ status: 'starting', error: null, errorDetail: null })
    const epoch = this.epoch
    const agent = new AgentSession(this.meta.agentId, this.root, {
      // A subagent's work belongs to the chat it started in: none of it reaches a new chat.
      onUpdate: (update, from) => {
        if (from === null || this.live(epoch)) this.onUpdate(update, from)
      },
      onPermission: (request, resolve, from) => {
        if (from === null || this.live(epoch)) this.onPermission(request, resolve, from)
        else resolve(null)
      },
      onExit: (error) => this.onAgentExit(agent, error),
    })
    this.agent = agent
    try {
      const mcpServers = this.options.mcpServers()
      const info = await withTimeout(
        agent.start({
          mcpServers,
          resumeSessionId: this.resumeSessionId,
          permissions: this.policy(),
        }),
        START_TIMEOUT_MS,
        `${name} didn't start within a minute. Check that it's installed and signed in.`,
      )
      if (this.agent !== agent) throw new Error(`${name} was stopped while starting.`)
      this.agentInfo = info
      this.sessionModels = info.models
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
          if (record) this.pushNewSessionNotice(record)
          else this.newSessionNotice = true
        }
      }
      this.schedulePersist()
      this.patchMeta({
        status: 'ready',
        modeName: info.modeName,
        modeIsUsual: agent.modeIsUsual,
        ownPermissions: agent.ownPermissions,
        models: this.nextModels(),
      })
      if (info.commands) this.rememberCommands(agent.agentId, info.commands)
      this.hadSession = true
      return { agent, info }
    } catch (error) {
      if (this.agent === agent) {
        this.stopAgent()
        // Started early, it fails quietly: the first message tries again and says why.
        if (!record) throw error
        const { message, detail } = describeError(error)
        this.patchMeta({ status: 'error', error: message, errorDetail: detail })
        // Gui thought the agent was there. Look again, so the chat's setup step (install,
        // sign in) shows in place of this error from now on.
        if (error instanceof AgentMissingError) void agentHealth.check(this.meta.agentId)
        else void agentHealth.rescan()
      } else {
        agent.dispose()
      }
      throw error
    }
  }

  private pushNewSessionNotice(record: TurnRecord) {
    this.pushItem(record, {
      kind: 'notice',
      id: randomUUID(),
      tone: 'info',
      text: `Started a new chat with ${this.meta.agentName}. It doesn't remember earlier messages.`,
    })
  }

  private stopAgent() {
    this.agent?.dispose()
    this.agent = null
    this.agentInfo = null
    this.agentHasTools = false
    this.primedAgent = null
    this.sessionModels = null
    this.sessionPolicy = null
    this.refused.clear()
    // A change still waiting on the old agent mustn't hold up the next one's.
    this.settingChanges = Promise.resolve()
    this.refreshModels()
  }

  /**
   * Brings the running session in line with the project's Ask or Auto, then the user's
   * saved choices: the model first, since the effort levels on offer can depend on it.
   * Never throws. During a turn, a refusal is a notice and the turn goes on with the
   * agent's own setting; between turns it stays quiet and the next turn tries again.
   */
  private applySettings(agent: AgentSession, record: TurnRecord | null) {
    const run = this.settingChanges.then(async () => {
      await this.applyPolicy(agent, record)
      for (const key of ['model', 'effort'] as const) {
        const setting = this.agent === agent ? this.sessionModels?.[key] : null
        if (!setting) continue
        const value = chosenValue(setting, savedAgentSettings(agent.agentId), this.refused)
        if (value === null || value === setting.value) continue
        try {
          const models = await withTimeout(
            agent.setConfigOption(setting.id, value),
            SETTING_TIMEOUT_MS,
            `${this.meta.agentName} didn't answer.`,
          )
          if (this.agent !== agent) return
          this.sessionModels = models
        } catch (error) {
          if (this.agent !== agent || !record) continue
          this.refused.set(setting.id, value)
          const name = (choice: string) =>
            setting.options.find((option) => option.value === choice)?.name ?? choice
          this.pushItem(record, {
            kind: 'notice',
            id: randomUUID(),
            tone: 'info',
            text: `Couldn't switch the ${key} to ${name(value)}, so this message uses ${name(setting.value)}.`,
            detail: describeError(error).message,
          })
        }
        this.refreshModels()
      }
    })
    // Never rejects, so neither the turn nor the changes queued after it trip on a bug here.
    const settled = run.catch((error: unknown) => console.error('[gui] model change failed', error))
    this.settingChanges = settled
    return settled
  }

  /** The project's Ask or Auto, as the agent's own permission controls take it. */
  private policy(): PermissionPolicy {
    return this.meta.autoApprove ? 'auto' : 'ask'
  }

  /**
   * Sets the agent's own permission controls to the project's Ask or Auto (see
   * AgentSession.applyPermissions) unless the session already has them. A refusal during
   * a turn isn't retried until Ask or Auto changes again.
   */
  private async applyPolicy(agent: AgentSession, record: TurnRecord | null) {
    const policy = this.policy()
    if (this.agent !== agent || this.sessionPolicy === policy) return
    let failures: string[]
    try {
      failures = await withTimeout(
        agent.applyPermissions(policy),
        SETTING_TIMEOUT_MS,
        `${this.meta.agentName} didn't answer.`,
      )
    } catch (error) {
      failures = [describeError(error).message]
    }
    if (this.agent !== agent) return
    this.sessionModels = agent.models
    this.refreshModels()
    this.refreshModeName()
    if (failures.length === 0 || record) this.sessionPolicy = policy
    if (failures.length === 0 || !record) return
    const mode = this.meta.modeName
    this.pushItem(record, {
      kind: 'notice',
      id: randomUUID(),
      tone: 'info',
      text: `Couldn't switch ${this.meta.agentName} to ${policy === 'ask' ? 'Ask' : 'Auto'}, so this message uses its own setting${mode ? ` (${mode})` : ''}.`,
      detail: failures.join('\n'),
    })
  }

  /** What `meta.models` says for `agentId` now; see ChatMeta.models. */
  private nextModels(agentId = this.meta.agentId) {
    const live = this.agentInfo !== null && this.agent?.agentId === agentId
    if (!live) return availableModels(agentId)
    return this.sessionModels && withChoices(this.sessionModels, agentId, this.refused)
  }

  /** Follows the agent's install and sign-in state; once it's ready, held messages go out. */
  private refreshAgent = () => {
    const agent = agentHealth.list().find((health) => health.id === this.meta.agentId) ?? null
    if (JSON.stringify(agent) !== JSON.stringify(this.meta.agent)) this.patchMeta({ agent })
    if (this.meta.queuePauseReason === 'setup' && agent?.status === 'ready') this.sendQueuedNow()
  }

  private refreshModels = () => {
    const models = this.nextModels()
    if (JSON.stringify(models) !== JSON.stringify(this.meta.models)) this.patchMeta({ models })
  }

  /**
   * Follows this project's Auto setting. Cards already open stay open: Auto answers new
   * requests. The agent's own controls follow now between turns, else before the next prompt.
   */
  private refreshAutoApprove = () => {
    const { autoNoteSeen } = getPrefs()
    if (autoNoteSeen !== this.meta.autoNoteSeen) this.patchMeta({ autoNoteSeen })
    const autoApprove = isAutoApprove(this.root)
    if (autoApprove === this.meta.autoApprove) return
    this.patchMeta({ autoApprove })
    const agent = this.agent
    if (agent && this.agentInfo && !this.active) void this.applySettings(agent, null)
  }

  private onAgentExit(agent: AgentSession, error: DetailedError) {
    if (this.agent !== agent) return
    this.stopAgent()
    // The next message restarts the agent; it should pick the conversation back up.
    this.resumeSessionId = this.sessionId
    this.patchMeta({ status: 'error', error: error.message, errorDetail: error.detail })
  }

  /** `from`: the subagent it comes from (see AgentHandlers), or null for the agent's own. */
  private onUpdate(update: SessionUpdate, from: string | null) {
    if (from !== null) return this.onSubagentUpdate(update, from)
    if (update.sessionUpdate === 'available_commands_update') {
      const agentId = this.agent?.agentId
      if (agentId) this.rememberCommands(agentId, parseCommands(update.availableCommands))
      return
    }
    if (update.sessionUpdate === 'config_option_update') {
      // The agent changed its own settings (e.g. new effort levels for another model).
      this.sessionModels = parseModelSettings(update.configOptions)
      this.refreshModels()
      this.refreshModeName()
      return
    }
    const record = this.active
    if (!record) {
      if (update.sessionUpdate === 'current_mode_update') this.refreshModeName()
      return
    }
    if (this.applyItem(record, update, null)) this.scheduleTurn(record)
  }

  /**
   * Applies an update of the agent's own (`owner` null) or a subagent's to the turn's items.
   * Returns whether anything changed.
   */
  private applyItem(record: TurnRecord, update: SessionUpdate, owner: string | null): boolean {
    const items = record.turn.items
    const owned = owner === null ? {} : { subagent: owner }
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        if (update.content.type !== 'text') return false
        const kind = update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thought'
        // Its own last item: the steps of subagents running alongside don't split its words.
        const last = items.findLast((item) => ownedBy(item, owner))
        if (last && last.kind === kind) last.text += update.content.text
        else items.push({ kind, id: randomUUID(), text: update.content.text, ...owned })
        return true
      }
      case 'tool_call': {
        const preview = previewTool(this.meta.agentId, update.title, update.kind)
        const status = update.status ?? 'pending'
        const now = Date.now()
        items.push({
          kind: 'tool',
          id: update.toolCallId,
          title: preview ? GUI_TOOL_LABELS[preview] : this.relativize(update.title),
          toolKind: preview ? 'preview' : (update.kind ?? 'other'),
          status,
          locations: (update.locations ?? []).map((l) => this.displayPath(l.path, l.line)),
          startedAt: now,
          endedAt: isFinished(status) ? now : null,
          ...owned,
        })
        return true
      }
      case 'tool_call_update': {
        const item = items.find(
          (i) => i.kind === 'tool' && i.id === update.toolCallId && ownedBy(i, owner),
        )
        if (item?.kind !== 'tool') return false
        if (update.title && item.toolKind !== 'preview') item.title = this.relativize(update.title)
        if (update.kind && item.toolKind !== 'preview') item.toolKind = update.kind
        if (update.status) item.status = update.status as ToolStatus
        // For how long a run of steps took.
        if (isFinished(item.status)) item.endedAt ??= Date.now()
        if (update.locations) {
          item.locations = update.locations.map((l) => this.displayPath(l.path, l.line))
        }
        return true
      }
      // Subagents' sessions don't send these (SubagentRouter drops them).
      case 'plan': {
        const entries = update.entries.map(({ content, status }) => ({ content, status }))
        const plan = items.find((i) => i.kind === 'plan')
        if (plan?.kind === 'plan') plan.entries = entries
        else items.push({ kind: 'plan', id: randomUUID(), entries })
        return true
      }
      case 'notice': {
        const text = [update.title, update.description].filter(Boolean).join(' — ')
        const tone = update.severity === 'error' ? 'error' : 'info'
        items.push({ kind: 'notice', id: randomUUID(), text, tone })
        return true
      }
      case 'subagent_update':
        this.applySubagent(record, update, owner)
        return true
      case 'session_message':
        return this.applyMessage(record, update)
      case 'current_mode_update':
        this.refreshModeName()
        return false
      default:
        return false
    }
  }

  /**
   * A subagent's own words and steps, in its group of the running turn. Past
   * MAX_SUBAGENT_STEPS its oldest steps go, so a long-running one can't grow the transcript
   * without end.
   */
  private onSubagentUpdate(update: SessionUpdate, from: string) {
    const record = this.active
    if (!record || this.disposed) return
    this.subagentIn(record, from)
    if (!this.applyItem(record, update, from)) return
    const items = record.turn.items
    const overflow = overflowingSteps(items, from, MAX_SUBAGENT_STEPS)
    for (const index of overflow.reverse()) items.splice(index, 1)
    this.scheduleTurn(record)
  }

  /** The turn's item for subagent `id`, added where the turn is now when it has none yet. */
  private subagentIn(record: TurnRecord, id: string, parent?: string | null): SubagentItem {
    const items = record.turn.items
    const found = items.find(
      (item): item is SubagentItem => item.kind === 'subagent' && item.id === id,
    )
    if (found) return found
    // Handed more work in a later turn: it keeps its name and place among subagents.
    const earlier = this.records
      .flatMap((r) => r.turn.items)
      .findLast((item): item is SubagentItem => item.kind === 'subagent' && item.id === id)
    const above = parent !== undefined ? parent : (earlier?.subagent ?? null)
    if (above !== null) this.subagentIn(record, above)
    const item: SubagentItem = {
      kind: 'subagent',
      id,
      title: earlier?.title ?? 'Subagent',
      description: earlier?.description ?? null,
      status: 'running',
      error: null,
      prompt: null,
      answer: null,
      canStop: earlier?.canStop ?? false,
      startedAt: Date.now(),
      endedAt: null,
      ...(above !== null ? { subagent: above } : {}),
    }
    items.push(item)
    return item
  }

  /** What a `subagent_update` says of a subagent: its labels, whether it can be stopped, its state. */
  private applySubagent(record: TurnRecord, update: SubagentUpdate, parent: string | null) {
    const item = this.subagentIn(record, update.sessionId, parent)
    // SubagentRouter fills in the labels it knows; null is one the agent never gave.
    if (update.title) item.title = update.title
    if (update.description !== undefined) item.description = update.description ?? null
    Object.assign(item, subagentPatch(update, Date.now()))
  }

  /** A task given to a subagent, or its answer, which take the place of the call that started it. */
  private applyMessage(record: TurnRecord, update: SessionMessage) {
    const items = record.turn.items
    const known = (id: string) => items.some((item) => item.kind === 'subagent' && item.id === id)
    const role = sessionMessageRole(update, known)
    const text = messageText(update.content)
    if (!role || !text) return false
    const item = this.subagentIn(record, role.subagent)
    if (role.role === 'prompt') {
      item.prompt = text
      return true
    }
    item.answer = text
    const echo = echoedAnswer(items, role.subagent, text)
    if (echo !== -1) items.splice(echo, 1)
    return true
  }

  /** The subagents of a turn. */
  private subagentsOf(record: TurnRecord) {
    return record.turn.items.filter((item): item is SubagentItem => item.kind === 'subagent')
  }

  /**
   * A turn's subagents still shown as working when it ends: nothing more is shown of them,
   * so they end with it, stopped if the turn was.
   */
  private settleSubagents(record: TurnRecord, status: TurnStatus) {
    const now = Date.now()
    for (const item of this.subagentsOf(record)) {
      if (!isWorking(item)) continue
      item.status = status === 'done' ? 'done' : 'stopped'
      item.endedAt = now
    }
  }

  private onPermission(
    request: RequestPermissionRequest,
    resolve: PermissionResolver,
    from: string | null,
  ) {
    const record = this.active
    if (!record || record.cancelRequested || this.disposed) {
      resolve(null)
      return
    }
    void this.autoAnswer(record, request)
      .catch(() => null)
      .then((auto) => this.askPermission(record, request, resolve, auto, from))
  }

  /** `auto`: the option Gui answers with when it doesn't ask (see `autoApproval`), or null. */
  private askPermission(
    record: TurnRecord,
    request: RequestPermissionRequest,
    resolve: PermissionResolver,
    auto: string | null,
    from: string | null,
  ) {
    // The turn may have ended or been stopped while the request's paths were checked.
    if (this.active !== record || record.cancelRequested || this.disposed) {
      resolve(null)
      return
    }
    // Edits to ordinary source files inside the project are what Gui is for, so those are
    // approved in Ask mode too; Auto mode approves everything the same rules allow.
    if (auto !== null && (request.toolCall.kind === 'edit' || this.autoApproves)) {
      resolve(auto)
      return
    }
    const { toolCallId, title } = request.toolCall
    // codex-acp asks about MCP calls with no title; the tool call it's asking about has one.
    // Only the label comes from it: the user still decides.
    const tool = record.turn.items.find((i) => i.kind === 'tool' && i.id === toolCallId)
    const paths = requestPaths(request).map((path) => this.projectPath(path))
    const id = randomUUID()
    // Which subagent asks: the session it came from, else the one whose step it's about
    // (Codex asks about its subagents' steps on the agent's own session).
    const subagent = from ?? tool?.subagent
    if (subagent) this.subagentIn(record, subagent)
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
      ...(subagent ? { subagent } : {}),
    })
    this.emit('attention')
  }

  /** What Auto mode answers `request` with, whether or not it's on (see `autoApproval`). */
  private autoAnswer(record: TurnRecord, request: RequestPermissionRequest) {
    const { toolCallId, kind } = request.toolCall
    const tool = record.turn.items.find((i) => i.kind === 'tool' && i.id === toolCallId)
    // Opening a website: its address can carry data out, so the user always decides.
    if (asksFirst(this.meta.agentId, request.toolCall, tool?.kind === 'tool' ? tool : undefined))
      return Promise.resolve(null)
    const toolKind = kind ?? (tool?.kind === 'tool' ? tool.toolKind : null)
    return autoApproval(request, {
      agentId: this.meta.agentId,
      kind: toolKind,
      place: async (path, write) => projectEditPath(path, await this.scope(), !write),
    })
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
    if (isFromHome(path)) return null
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

  /** What a turn changed, without a canvas's layout file when only its camera moved. */
  private async turnChanges(before: string, after: string) {
    const changes = await this.checkpoints.diff(before, after).catch(() => null)
    const layout = this.options.layout
    if (!changes || !layout || !changes.some((change) => change.path === layout.path))
      return changes
    if (await layout.changed(before, after).catch(() => true)) return changes
    return changes.filter((change) => change.path !== layout.path)
  }

  /** A canvas's layout as it was at `to`, where it changed since `from` (`BoardLayout`). */
  private async restoreLayout(from: string, to: string) {
    // The files are back by now: a layout that can't follow leaves the board as it is.
    await this.options.layout
      ?.restore(from, to)
      .catch((error: unknown) => console.error('[gui] failed to restore the canvas layout', error))
  }

  /** Without a canvas's layout file, which undo and redo merge instead (`BoardLayout`). */
  private restorable(paths: string[]) {
    const layout = this.options.layout?.path
    return layout ? paths.filter((path) => path !== layout) : paths
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
    return { paths: this.restorable([...paths]), inferred: this.restorable([...inferred]) }
  }

  private async pathsBetween(from: string, to: string) {
    return (await this.checkpoints.diff(from, to)).map((change) => change.path)
  }

  private async requireCheckpoints(shas: (string | null)[], consequence: string) {
    const needed = shas.filter((sha): sha is string => sha !== null)
    if (await this.checkpoints.hasCommits(needed)) return
    throw new Error(`Gui's saved versions are missing (was their folder deleted?), ${consequence}.`)
  }

  /**
   * Undo and redo rewrite whole files, so they'd silently discard edits made outside
   * Gui (e.g. in the user's editor) since Gui last recorded those files. Asks first. `to`
   * is the checkpoint being restored: what restoring it leaves alone isn't overwritten.
   */
  private async confirmOverwrite(
    baseline: Baseline | null,
    current: string,
    to: string,
    paths: string[],
    inferred: string[],
    action: 'Undo' | 'Redo',
  ) {
    if (paths.length === 0) return true
    const edited = baseline ? await this.checkpoints.changedAmong(baseline.sha, current, paths) : []
    // Paths only attributed to a turn by diffing may hold the user's edits too.
    const touched = [...new Set([...edited, ...inferred])]
    if (touched.length === 0) return true
    // A folder with a repository of its own is left as it is, so nothing in it is overwritten.
    const alone = new Set(await this.checkpoints.leftAlone(to, touched))
    const changed = touched.filter((path) => !alone.has(path))
    if (changed.length === 0) return true
    const certain = baseline?.complete === true && inferred.length === 0
    const listed = changed.slice(0, OVERWRITE_LIST_MAX).map((path) => `  ${path}`)
    const more = changed.length - listed.length
    if (more > 0) listed.push(`  and ${more} more`)
    const files = listed.join('\n')
    const verb = action === 'Undo' ? 'Undoing' : 'Redoing'
    const options: MessageBoxOptions = {
      type: 'warning',
      message: certain ? 'Overwrite changes made outside Gui?' : 'Overwrite these files?',
      detail: certain
        ? `These files changed after Gui last recorded them, for example in your editor:\n\n${files}\n\n${verb} replaces their contents, and those changes will be lost.`
        : `A message stopped before Gui recorded its changes. These files may also have changes from your editor:\n\n${files}\n\n${verb} replaces their contents, and any such changes will be lost.`,
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

  /**
   * Says, on the turn the undo or redo was asked on, which folders it left alone
   * (`Checkpoints.restore`). Once: undoing again after a redo leaves the same ones.
   */
  private noteLeftAlone(record: TurnRecord, action: 'Undo' | 'Redo', folders: string[]) {
    if (folders.length === 0) return
    const text = `${action} left ${folders.join(', ')} alone. Gui doesn't record folders with a git repository of their own, so it can't ${action.toLowerCase()} changes to them.`
    if (record.turn.items.some((item) => item.kind === 'notice' && item.text === text)) return
    this.pushItem(record, { kind: 'notice', id: randomUUID(), tone: 'info', text })
  }

  /** Shows the session's mode as the agent last reported it, however it changed. */
  /** Keeps the commands an agent offers here, for the composer now and the next launch. */
  private rememberCommands(agentId: AgentId, commands: AgentCommand[]) {
    const known = this.knownCommands.get(agentId)
    if (known && sameJson(known, commands)) return
    this.knownCommands.set(agentId, commands)
    this.schedulePersist()
    if (agentId === this.meta.agentId) this.patchMeta({ commands: this.commandsFor(agentId) })
  }

  private refreshModeName() {
    const modeName = this.agent?.modeName ?? null
    const modeIsUsual = this.agent?.modeIsUsual ?? false
    if (modeName !== this.meta.modeName || modeIsUsual !== this.meta.modeIsUsual) {
      this.patchMeta({ modeName, modeIsUsual })
    }
    // The modes it offers can change mid-session; one without an ask-first mode decides itself.
    const ownPermissions = this.agent && this.agentInfo ? this.agent.ownPermissions : null
    if (ownPermissions !== null && ownPermissions !== this.meta.ownPermissions) {
      this.patchMeta({ ownPermissions })
    }
  }

  /** Gui approves what the agent asks about itself: Auto, unless the agent decides (ownPermissions). */
  private get autoApproves() {
    return this.meta.autoApprove && !this.meta.ownPermissions
  }

  private async trySnapshot(record: TurnRecord, message: string) {
    try {
      return await this.checkpoints.snapshot(message)
    } catch (error) {
      this.pushItem(record, {
        kind: 'notice',
        id: randomUUID(),
        tone: 'error',
        text: "Couldn't save a version, so this message can't be undone.",
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
    this.emit('turnUpdate', this.turnPublisher.update(record.turn))
    this.emit('turn', record.turn)
    this.schedulePersist()
  }

  private schedulePersist() {
    // Marked at once, so closing or quitting before the timer still writes the change.
    this.history.changed()
    if (this.disposed) return
    this.persistTimer ??= setTimeout(
      () => {
        this.persistTimer = null
        this.history.save()
      },
      this.active ? PERSIST_RUNNING_MS : PERSIST_DELAY_MS,
    )
  }

  private savedChat(): SavedChat {
    const checkpoints: SavedChat['checkpoints'] = {}
    for (const { turn, before, after } of this.records) checkpoints[turn.id] = { before, after }
    return {
      version: 1,
      id: this.chatId,
      createdAt: this.createdAt,
      ...(this.title ? { title: this.title } : {}),
      agentId: this.meta.agentId,
      sessionId: this.sessionId,
      primed: this.primed !== null,
      primedWithTools: this.primed === 'tools',
      primedVersion: this.primed !== null ? PROMPT_VERSION : undefined,
      turns: this.records.map((r) => r.turn),
      checkpoints,
      redo: this.redoPoint,
      ...(this.savedVersions.length ? { versions: this.savedVersions } : {}),
      commands: Object.fromEntries(this.knownCommands),
      ...(this.meta.queue.length ? { queue: this.meta.queue.map((m) => this.savedQueued(m)) } : {}),
    }
  }

  private savedQueued(message: QueuedMessage): SavedQueued {
    const payload = this.queued.get(message.id)
    return {
      message,
      images: payload?.images ?? [],
      selection: payload?.selection ?? message.context,
      viewport: payload?.viewport ?? null,
      ...(payload?.fix ? { fix: payload.fix } : {}),
    }
  }

  private patchMeta(patch: Partial<ChatMeta>) {
    const queueChanged = patch.queue !== undefined && patch.queue !== this.meta.queue
    this.meta = { ...this.meta, ...patch }
    if (this.disposed) return
    this.emit('meta', this.meta)
    // Saved like the transcript, so a crash doesn't lose what's waiting.
    if (queueChanged) this.schedulePersist()
  }
}

export { availableModels, offersChoice } from './chat-models'
export { type EditScope, projectEditPath } from './chat-paths'

/** A version's name on one line, cut short. */
function versionName(text: string): string {
  const name = text.replace(/\s+/g, ' ').trim()
  return name.length > 120 ? `${name.slice(0, 119).trimEnd()}…` : name
}

/** The newest checkpoint of these turns, i.e. how Gui last left the files they touched. */
function lastRecorded(turns: TurnRecord[]): Baseline | null {
  let complete = true
  for (const r of [...turns].reverse()) {
    if (r.after) return { sha: r.after, complete }
    if (r.before) return { sha: r.before, complete: false }
    complete = false
  }
  return null
}

/** Picks as turns and queued messages keep them: the crops went to the agent. */
function withoutScreenshots(selection: Picked[]): Picked[] {
  return selection.map((picked) => ({ ...picked, screenshot: null }))
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
