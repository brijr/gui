import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { parseCommands } from '../shared/commands'
import {
  type AgentCommand,
  type AgentId,
  type ChatSummary,
  DEFAULT_AGENT_ID,
  isAgentId,
  type Picked,
  type RecordingAttachment,
  type Turn,
  type TurnItem,
} from '../shared/types'
import { asidePath, writeFileAtomic } from './atomic-file'
import { serializeHistory } from './history-format'

/** Everything needed to reopen a project's chat where it left off, including undo. */
export interface SavedChat {
  version: 1
  /** Stays with the chat when it's archived and reopened (given one on load in older files) */
  id: string
  /** When the chat began (its first turn's start in older files) */
  createdAt: number
  /** The user's name for it; its first message stands for it otherwise */
  title?: string
  agentId: AgentId
  /** Agent session to resume, if the agent supports it */
  sessionId: string | null
  /** Whether that session has received Gui's instructions (absent in older files) */
  primed?: boolean
  /** Whether those instructions included the preview tools */
  primedWithTools?: boolean
  /** Version of Gui's instructions that session received */
  primedVersion?: number
  turns: Turn[]
  /** Checkpoint shas per turn id, so restored turns can still be undone */
  checkpoints: Record<string, { before: string | null; after: string | null }>
  redo: { sha: string; paths: string[]; turnIds: string[] } | null
  /**
   * The slash commands each agent last offered in this project, so the composer can list
   * them before the agent starts (absent in older files)
   */
  commands?: Record<string, AgentCommand[]>
}

const dir = () => join(app.getPath('userData'), 'chats')

/** A project's own chat file; the start screen and a project's first tab use this one. */
export async function historyFile(root: string) {
  const real = await realpath(root).catch(() => root)
  return join(dir(), `${historyName(real)}.json`)
}

const historyName = (real: string) => createHash('sha1').update(real).digest('hex').slice(0, 16)

/** Chat files a tab has open, so two tabs on one folder never write the same one. */
const claimed = new Set<string>()

/**
 * The chat file for a new tab on `root`: the project's own, or with it in use (a monorepo
 * open twice, say), the first free numbered one beside it. Release it when the tab's chat ends.
 */
export async function claimHistoryFile(root: string) {
  const real = await realpath(root).catch(() => root)
  // Checked and claimed with no await in between.
  let file = join(dir(), `${historyName(real)}.json`)
  for (let n = 2; claimed.has(file); n++) file = join(dir(), `${historyName(real)}-${n}.json`)
  claimed.add(file)
  return file
}

export function releaseHistoryFile(file: string) {
  claimed.delete(file)
}

export function claimedHistoryFiles() {
  return [...claimed]
}

/**
 * A project's last message, for the start screen: a light read that leaves the file alone,
 * unlike loadHistory. Null with no chat, or one it can't read.
 */
export async function lastMessage(root: string): Promise<{ prompt: string; at: number } | null> {
  try {
    const saved = JSON.parse(await readFile(await historyFile(root), 'utf8')) as Partial<SavedChat>
    const turns = Array.isArray(saved.turns) ? saved.turns : []
    const last = turns.at(-1)
    if (!last || typeof last.startedAt !== 'number') return null
    // A message of images alone has no text; the last one with some stands for the chat.
    const text = turns.findLast((turn) => typeof turn.prompt === 'string' && turn.prompt.trim())
    return { prompt: text?.prompt.trim() ?? 'Image', at: last.startedAt }
  } catch {
    return null
  }
}

export async function loadHistory(file: string): Promise<SavedChat | null> {
  const text = await readHistory(file)
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as Partial<SavedChat> | null
    if (parsed?.version !== 1 || !Array.isArray(parsed.turns)) throw new Error('unknown format')
    const checkpoints = parsed.checkpoints ?? {}
    return {
      version: 1,
      id: typeof parsed.id === 'string' && CHAT_ID.test(parsed.id) ? parsed.id : randomUUID(),
      createdAt:
        typeof parsed.createdAt === 'number'
          ? parsed.createdAt
          : (parsed.turns[0]?.startedAt ?? Date.now()),
      ...(typeof parsed.title === 'string' && parsed.title.trim()
        ? { title: cleanTitle(parsed.title) }
        : {}),
      agentId: isAgentId(parsed.agentId) ? parsed.agentId : DEFAULT_AGENT_ID,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
      primed: parsed.primed === true,
      primedWithTools: parsed.primedWithTools === true,
      primedVersion: typeof parsed.primedVersion === 'number' ? parsed.primedVersion : undefined,
      turns: parsed.turns.map((turn) => settleTurn(turn, checkpoints[turn.id]?.before ?? null)),
      checkpoints,
      redo: parsed.redo ?? null,
      commands: settleCommands(parsed.commands),
    }
  } catch (error) {
    // Keep what's there for recovery instead of letting the next save overwrite it.
    await setAside(file, error)
    return null
  }
}

/**
 * The file's text, or null without one. A file that's there but can't be read (too many
 * open files, permissions) gets a few tries, then is set aside: the chat starting empty
 * must not save over it.
 */
async function readHistory(file: string): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      if (attempt === 3) {
        await setAside(file, error)
        return null
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt))
    }
  }
}

async function setAside(file: string, error: unknown) {
  const aside = asidePath(file)
  console.error(`[gui] unreadable chat history, moved to ${aside}`, error)
  await rename(file, aside).catch(() => undefined)
}

/** What a project's saved chats still refer to, kept until no chat does. */
export interface ChatReferences {
  checkpoints: Set<string>
  recordings: Set<string>
}

/**
 * What the saved chats of `root` refer to: its own chat file, those of other tabs on it, and
 * its archive. Null if any of them can't be read, as that one might refer to something too.
 */
export async function chatReferences(root: string): Promise<ChatReferences | null> {
  const real = await realpath(root).catch(() => root)
  const name = historyName(real)
  const own = new RegExp(`^${name}(-\\d+)?\\.json$`)
  const found: ChatReferences = { checkpoints: new Set(), recordings: new Set() }
  const add = async (file: string) => {
    try {
      const saved = JSON.parse(await readFile(file, 'utf8')) as Partial<SavedChat>
      for (const point of Object.values(saved.checkpoints ?? {})) {
        if (typeof point?.before === 'string') found.checkpoints.add(point.before)
        if (typeof point?.after === 'string') found.checkpoints.add(point.after)
      }
      if (typeof saved.redo?.sha === 'string') found.checkpoints.add(saved.redo.sha)
      for (const turn of Array.isArray(saved.turns) ? saved.turns : []) {
        for (const clip of Array.isArray(turn?.recordings) ? turn.recordings : []) {
          if (typeof clip?.id === 'string') found.recordings.add(clip.id)
        }
      }
      return true
    } catch (error) {
      // Gone since it was listed (archived or deleted) is fine; anything else isn't known.
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
  }
  const names = await readdir(dir()).catch(() => [] as string[])
  for (const entry of names.filter((entry) => own.test(entry))) {
    if (!(await add(join(dir(), entry)))) return null
  }
  // Listed after the live files were read, so one archived meanwhile is read here.
  const folder = join(dir(), name)
  const archived = await readdir(folder).catch(() => [] as string[])
  for (const entry of archived) {
    if (!CHAT_ID.test(entry.replace(/\.json$/, '')) || !entry.endsWith('.json')) continue
    if (!(await add(join(folder, entry)))) return null
  }
  return found
}

/** Nothing was running when the app quit, so open permission prompts can't be answered. */
function settleTurn(turn: Turn, before: string | null): Turn {
  const items = turn.items.map(settleItem)
  const attachments = settleAttachments(turn.attachments)
  const context = settleContext(turn.context)
  const recordings = settleRecordings(turn.recordings)
  if (turn.status !== 'running') return { ...turn, items, attachments, context, recordings }
  return {
    ...turn,
    items,
    attachments,
    context,
    recordings,
    status: 'cancelled',
    endedAt: turn.startedAt,
    // Its edits were never diffed, but its starting checkpoint can still undo them.
    ...(before && turn.changes === null ? { changesUnknown: true } : {}),
  }
}

/** Turns saved before several things could be picked hold one element, or null. */
function settleContext(value: unknown): Picked[] {
  if (Array.isArray(value)) return value as Picked[]
  return value && typeof value === 'object' ? [value as Picked] : []
}

/** Each agent's saved command list, checked like one the agent sent. */
function settleCommands(value: unknown): Record<string, AgentCommand[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const commands: Record<string, AgentCommand[]> = {}
  for (const [agentId, list] of Object.entries(value)) {
    if (isAgentId(agentId)) commands[agentId] = parseCommands(list)
  }
  return commands
}

/** Same limits main puts on attachments when they're sent (see `isImage` in index.ts). */
const THUMBNAIL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/
const MAX_THUMBNAIL = 256 * 1024
const MAX_NAME = 200

type Attachment = NonNullable<Turn['attachments']>[number]

function isAttachment(value: unknown): value is Attachment {
  if (!value || typeof value !== 'object') return false
  const { name, thumbnail } = value as Record<string, unknown>
  return (
    typeof name === 'string' &&
    name.length <= MAX_NAME &&
    typeof thumbnail === 'string' &&
    thumbnail.length <= MAX_THUMBNAIL &&
    THUMBNAIL.test(thumbnail)
  )
}

/**
 * History only ever holds thumbnails, but the file is just JSON on disk: keep the
 * attachments that are exactly that and drop anything else.
 */
function settleAttachments(value: unknown): Turn['attachments'] {
  if (!Array.isArray(value)) return undefined
  const valid = value.filter(isAttachment).map(({ name, thumbnail }) => ({ name, thumbnail }))
  return valid.length ? valid : undefined
}

function settleRecordings(value: unknown): RecordingAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined
  const valid = value
    .filter((clip): clip is RecordingAttachment => {
      if (!clip || typeof clip !== 'object') return false
      const data: Record<string, unknown> = clip
      return (
        typeof data.id === 'string' &&
        /^[a-f0-9-]{36}$/.test(data.id) &&
        typeof data.url === 'string' &&
        /^gui-recording:\/\/[a-f0-9]{32}\/[a-f0-9-]{36}\/video\.webm$/.test(data.url) &&
        data.url.endsWith(`/${data.id}/video.webm`) &&
        ['durationMs', 'width', 'height', 'frameCount'].every(
          (key) =>
            typeof data[key] === 'number' && Number.isFinite(data[key]) && Number(data[key]) > 0,
        ) &&
        Number(data.durationMs) <= 61000 &&
        Number(data.width) <= 1920 &&
        Number(data.height) <= 1920 &&
        Number.isInteger(data.frameCount) &&
        Number(data.frameCount) <= 1830 &&
        isAttachment(data)
      )
    })
    .slice(0, 3)
  return valid.length ? valid : undefined
}

function settleItem(item: TurnItem): TurnItem {
  if (item.kind !== 'permission') return item
  // Saved before prompts described the action; fill in what the transcript expects.
  return {
    ...item,
    toolKind: item.toolKind ?? 'other',
    locations: item.locations ?? [],
    sensitive: item.sensitive ?? false,
    resolved: item.resolved ?? 'cancelled',
  }
}

export { flushHistorySync, HistoryWriter } from './history-writer'

// Archived chats: each project's live chat file stays where it is (`historyFile`), and the
// chats it replaced sit in a folder beside it named the same, one file per chat, with an
// index of what the list shows so it never reads whole transcripts.

const CHAT_ID = /^[a-f0-9-]{36}$/
const INDEX = 'index.json'
const MAX_TITLE = 120
const MAX_PROMPT = 200

/** A title as the user typed it, on one line and cut short. */
export function cleanTitle(title: string) {
  return title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
}

async function archiveDir(root: string) {
  const real = await realpath(root).catch(() => root)
  return join(dir(), historyName(real))
}

const archivedFile = (folder: string, id: string) => join(folder, `${id}.json`)

/** What the list shows for a chat; null for one with no turns, which isn't worth keeping. */
function summarize(saved: SavedChat): ChatSummary | null {
  const first = saved.turns[0]
  const last = saved.turns.at(-1)
  if (!first || !last) return null
  const text = saved.turns.find((turn) => typeof turn.prompt === 'string' && turn.prompt.trim())
  return {
    id: saved.id,
    title: saved.title ?? null,
    prompt: text ? text.prompt.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT) : 'Image',
    agentId: saved.agentId,
    turns: saved.turns.length,
    startedAt: saved.createdAt,
    lastAt: last.endedAt ?? last.startedAt,
  }
}

function isSummary(value: unknown): value is ChatSummary {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === 'string' &&
    CHAT_ID.test(entry.id) &&
    (entry.title === null || typeof entry.title === 'string') &&
    typeof entry.prompt === 'string' &&
    isAgentId(entry.agentId) &&
    typeof entry.turns === 'number' &&
    typeof entry.startedAt === 'number' &&
    typeof entry.lastAt === 'number'
  )
}

/** The index as the files are: read when the index is missing or unreadable. */
async function rebuildIndex(folder: string): Promise<ChatSummary[]> {
  const names = await readdir(folder).catch(() => [] as string[])
  const summaries = await Promise.all(
    names
      .filter((name) => CHAT_ID.test(name.replace(/\.json$/, '')) && name.endsWith('.json'))
      .map(async (name) => {
        const saved = await loadHistory(join(folder, name))
        if (!saved) return null
        // The file's name is the chat's id, whatever an edited file says.
        return summarize({ ...saved, id: name.replace(/\.json$/, '') })
      }),
  )
  return summaries.filter((summary) => summary !== null)
}

/** The index; `stored` is false when it had to be rebuilt, so it's written out again. */
async function readIndex(folder: string): Promise<{ list: ChatSummary[]; stored: boolean }> {
  let text: string
  try {
    text = await readFile(join(folder, INDEX), 'utf8')
  } catch {
    const list = await rebuildIndex(folder)
    // Nothing archived yet: no folder to make.
    return { list, stored: list.length === 0 }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (Array.isArray(parsed) && parsed.every(isSummary)) return { list: parsed, stored: true }
  } catch {
    // Rebuilt below.
  }
  console.error(`[gui] unreadable chat archive index in ${folder}, rebuilding it`)
  return { list: await rebuildIndex(folder), stored: false }
}

/** Index changes per folder, one at a time, so two never read the same list and drop one's change. */
const indexQueue = new Map<string, Promise<unknown>>()

function updateIndex(folder: string, update: (list: ChatSummary[]) => ChatSummary[]) {
  const task = (indexQueue.get(folder) ?? Promise.resolve()).then(async () => {
    const { list, stored } = await readIndex(folder)
    const next = update(list).sort((a, b) => b.lastAt - a.lastAt)
    if (next !== list || !stored) await writeFileAtomic(join(folder, INDEX), JSON.stringify(next))
    return next
  })
  indexQueue.set(
    folder,
    task.catch(() => undefined),
  )
  return task
}

/** Puts a chat in its project's archive; null when it had no turns and so wasn't kept. */
export async function archiveChat(root: string, saved: SavedChat): Promise<ChatSummary | null> {
  const summary = summarize(saved)
  if (!summary) return null
  const folder = await archiveDir(root)
  await writeFileAtomic(archivedFile(folder, saved.id), serializeHistory(saved))
  await updateIndex(folder, (list) => [summary, ...list.filter((entry) => entry.id !== saved.id)])
  return summary
}

/** The project's archived chats, newest first. */
export async function listArchived(root: string): Promise<ChatSummary[]> {
  await archiveStrays(root)
  return updateIndex(await archiveDir(root), (list) => list)
}

export async function loadArchived(root: string, id: string): Promise<SavedChat | null> {
  if (!CHAT_ID.test(id)) return null
  const saved = await loadHistory(archivedFile(await archiveDir(root), id))
  return saved && { ...saved, id }
}

export async function removeArchived(root: string, id: string) {
  if (!CHAT_ID.test(id)) return
  const folder = await archiveDir(root)
  await rm(archivedFile(folder, id), { force: true })
  await updateIndex(folder, (list) => list.filter((entry) => entry.id !== id))
}

/** Names an archived chat; an empty title goes back to its first message. */
export async function renameArchived(root: string, id: string, title: string) {
  const saved = await loadArchived(root, id)
  if (!saved) throw new Error('That chat is no longer in the archive.')
  const { title: _old, ...rest } = saved
  const named = cleanTitle(title)
  await archiveChat(root, named ? { ...rest, title: named } : rest)
}

/**
 * Archives a project's own chat from its file, for the start screen. False when a tab has
 * the file open: its chat is live, and archives itself (`ChatController.reset`).
 */
export async function archiveStoredChat(root: string) {
  const file = await historyFile(root)
  if (claimed.has(file)) return false
  const saved = await loadHistory(file)
  if (saved) await archiveChat(root, saved)
  await rm(file, { force: true })
  return true
}

/**
 * Releases a tab's chat file once the tab is done with it. A numbered one (a second tab on the
 * folder) would otherwise sit unused until the folder is open twice again: its chat goes to
 * the archive instead.
 */
export async function retireHistoryFile(root: string, file: string) {
  try {
    if (file !== (await historyFile(root))) await archiveFile(root, file)
  } catch (error) {
    console.error('[gui] failed to archive a tab’s chat', error)
  } finally {
    releaseHistoryFile(file)
  }
}

async function archiveFile(root: string, file: string) {
  const saved = await loadHistory(file)
  if (saved) await archiveChat(root, saved)
  await rm(file, { force: true })
}

/** Numbered chat files no tab holds, left by a quit before their tab could archive them. */
async function archiveStrays(root: string) {
  const real = await realpath(root).catch(() => root)
  const stray = new RegExp(`^${historyName(real)}-\\d+\\.json$`)
  const names = await readdir(dir()).catch(() => [] as string[])
  for (const name of names) {
    const file = join(dir(), name)
    if (!stray.test(name) || claimed.has(file)) continue
    await archiveFile(root, file).catch((error: unknown) => {
      console.error('[gui] failed to archive a leftover chat', error)
    })
  }
}
