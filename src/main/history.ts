import { createHash } from 'node:crypto'
import { renameSync } from 'node:fs'
import { readdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type {
  AgentCommand,
  AgentId,
  ChatSummary,
  ImageAttachment,
  Picked,
  QueuedMessage,
  Turn,
  Version,
} from '../shared/types'
import { asidePath, writeFileAtomic } from './atomic-file'
import { snapshotHistory } from './history-format'
import { readHistory, readLastMessage } from './history-reader'
import {
  CHAT_ID,
  cleanTitle,
  type HistoryStamp,
  historyStamp,
  isSummary,
  sameHistoryStamp,
  summarizeHistory,
  summaryFile,
} from './history-summary'
import { writeHistorySnapshot } from './history-writer'
import type { PromptViewport } from './prompt'

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
  /**
   * Messages still waiting their turn, with what each takes to the agent, so a quit or crash
   * doesn't lose them (absent with none, and in archived chats)
   */
  queue?: SavedQueued[]
  /**
   * Versions the user named in the Versions sheet Gui used to have, and the states saved
   * before restoring one (absent with none). Nothing offers them now; they're kept, with
   * their checkpoints, as they were saved.
   */
  versions?: Version[]
}

export interface SavedQueued {
  message: QueuedMessage
  /** The full images, which the message itself only has thumbnails of */
  images: ImageAttachment[]
  /** What was picked, with its crops */
  selection: Picked[]
  /** The viewport it was written in; null when that's unknown */
  viewport: PromptViewport | null
  /** "Fix with agent" waiting its turn */
  fix?: 'startup'
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

/** The start screen reads a durable, bounded summary rather than the transcript. */
export async function lastMessage(root: string) {
  return readLastMessage(await historyFile(root))
}

export async function loadHistory(file: string): Promise<SavedChat | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await readHistory({ action: 'load', file })
    if (result.status === 'ok' && result.action === 'load') return result.chat
    if (result.status === 'error' && result.kind === 'worker') throw new Error(result.message)
    if (result.status !== 'error' || (await setAside(file, result.message, result.source)))
      return null
  }
  throw new Error('That chat changed while it was being read, so its file was kept.')
}

async function setAside(file: string, error: unknown, source?: HistoryStamp) {
  // An open/stat failure identifies no file version: keep its path rather than moving a
  // potentially unrelated replacement. Throw so an empty chat cannot later save over it.
  if (!source) throw new Error(`That chat couldn't be read safely, so its file was kept. ${error}`)
  const current = await stat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return null
  })
  if (!current) return true
  if (!sameHistoryStamp(source, historyStamp(current))) return false
  const aside = asidePath(file)
  // Do not move a newer write while an older file is being parsed in the worker.
  try {
    renameSync(file, aside)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  console.error(`[gui] unreadable chat history, moved to ${aside}`, error)
  await rm(summaryFile(file), { force: true }).catch(() => undefined)
  return true
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
  const recovery = new RegExp(`^${name}(-\\d+)?\\.corrupt-\\d+\\.json$`)
  const found: ChatReferences = { checkpoints: new Set(), recordings: new Set() }
  const add = async (file: string) => {
    const result = await readHistory({ action: 'references', file })
    if (result.status === 'missing') return true
    if (result.status !== 'ok' || result.action !== 'references') return false
    for (const sha of result.references.checkpoints) found.checkpoints.add(sha)
    for (const id of result.references.recordings) found.recordings.add(id)
    return true
  }
  const names = await referenceFiles(dir())
  if (!names || names.some((entry) => recovery.test(entry))) return null
  for (const entry of names.filter((entry) => own.test(entry))) {
    if (!(await add(join(dir(), entry)))) return null
  }
  // Listed after the live files were read, so one archived meanwhile is read here.
  const folder = join(dir(), name)
  const archived = await referenceFiles(folder)
  if (!archived || archived.some((entry) => /^[a-f0-9-]{36}\.corrupt-\d+\.json$/.test(entry)))
    return null
  for (const entry of archived) {
    if (!CHAT_ID.test(entry.replace(/\.json$/, '')) || !entry.endsWith('.json')) continue
    if (!(await add(join(folder, entry)))) return null
  }
  return found
}

async function referenceFiles(folder: string): Promise<string[] | null> {
  try {
    return await readdir(folder)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null
  }
}

export { flushHistorySync, HistoryWriter } from './history-writer'

// Archived chats: each project's live chat file stays where it is (`historyFile`), and the
// chats it replaced sit in a folder beside it named the same, one file per chat, with an
// index of what the list shows so it never reads whole transcripts.

const INDEX = 'index.json'

export { cleanTitle }

let archiveDirs: Promise<unknown> = Promise.resolve()

/**
 * The project's archive folder. Resolved one call at a time, so archive changes reach the
 * index queue (`updateIndex`) in the order they were asked for.
 */
function archiveDir(root: string): Promise<string> {
  const folder = archiveDirs.then(async () => {
    const real = await realpath(root).catch(() => root)
    return join(dir(), historyName(real))
  })
  archiveDirs = folder.catch(() => undefined)
  return folder
}

const archivedFile = (folder: string, id: string) => join(folder, `${id}.json`)

/** The index as the files are: read when the index is missing or unreadable. */
async function rebuildIndex(folder: string): Promise<ChatSummary[]> {
  const names = await readdir(folder).catch(() => [] as string[])
  const summaries: ChatSummary[] = []
  // One read at a time, with summaries produced in the worker. Never fan out transcripts.
  for (const name of names) {
    if (!CHAT_ID.test(name.replace(/\.json$/, '')) || !name.endsWith('.json')) continue
    const file = join(folder, name)
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await readHistory({ action: 'summary', file })
      if (result.status === 'error' && result.kind === 'worker') throw new Error(result.message)
      if (result.status === 'error' && !(await setAside(file, result.message, result.source)))
        continue
      if (result.status === 'ok' && result.action === 'summary' && result.summary) {
        // The file's name is the chat's id, whatever an edited file says.
        summaries.push({ ...result.summary, id: name.replace(/\.json$/, '') })
      }
      break
    }
  }
  return summaries
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

function updateIndex(
  folder: string,
  update: (list: ChatSummary[]) => ChatSummary[] | Promise<ChatSummary[]>,
) {
  const task = (indexQueue.get(folder) ?? Promise.resolve()).then(async () => {
    const { list, stored } = await readIndex(folder)
    const next = (await update(list)).sort((a, b) => b.lastAt - a.lastAt)
    if (next !== list || !stored) await writeFileAtomic(join(folder, INDEX), JSON.stringify(next))
    return next
  })
  const settled = task.catch(() => undefined)
  indexQueue.set(folder, settled)
  void settled.then(() => {
    if (indexQueue.get(folder) === settled) indexQueue.delete(folder)
  })
  return task
}

/** Puts a chat in its project's archive; null when it had no turns and so wasn't kept. */
export async function archiveChat(root: string, saved: SavedChat): Promise<ChatSummary | null> {
  const snapshot = snapshotHistory(saved)
  const summary = summarizeHistory(snapshot)
  if (!summary) return null
  const folder = await archiveDir(root)
  await updateIndex(folder, async (list) => {
    await writeHistorySnapshot(archivedFile(folder, snapshot.id), snapshot)
    return [summary, ...list.filter((entry) => entry.id !== snapshot.id)]
  })
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
  await updateIndex(folder, async (list) => {
    await rm(archivedFile(folder, id), { force: true })
    return list.filter((entry) => entry.id !== id)
  })
}

/** Names an archived chat; an empty title goes back to its first message. */
export async function renameArchived(root: string, id: string, title: string) {
  if (!CHAT_ID.test(id)) throw new Error('That chat is no longer in the archive.')
  const folder = await archiveDir(root)
  await updateIndex(folder, async (list) => {
    const saved = await loadHistory(archivedFile(folder, id))
    if (!saved) throw new Error('That chat is no longer in the archive.')
    const { title: _old, ...rest } = saved
    const named = cleanTitle(title)
    const snapshot = snapshotHistory({ ...rest, id, ...(named ? { title: named } : {}) })
    const summary = summarizeHistory(snapshot)
    await writeHistorySnapshot(archivedFile(folder, id), snapshot)
    return [...(summary ? [summary] : []), ...list.filter((entry) => entry.id !== id)]
  })
}

/**
 * Archives a project's own chat from its file, for the start screen. False when a tab has
 * the file open: its chat is live, and archives itself (`ChatController.reset`).
 */
export async function archiveStoredChat(root: string) {
  const file = await historyFile(root)
  if (claimed.has(file)) return false
  claimed.add(file)
  try {
    await archiveFile(root, file)
    return true
  } finally {
    releaseHistoryFile(file)
  }
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
  else {
    // A failed recovery rename must never lead to deleting the only surviving file.
    const exists = await stat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (exists) throw new Error("That chat couldn't be read, so its file was kept.")
  }
  await rm(file, { force: true })
  await rm(summaryFile(file), { force: true })
}

/** Numbered chat files no tab holds, left by a quit before their tab could archive them. */
async function archiveStrays(root: string) {
  const real = await realpath(root).catch(() => root)
  const stray = new RegExp(`^${historyName(real)}-\\d+\\.json$`)
  const names = await readdir(dir()).catch(() => [] as string[])
  for (const name of names) {
    const file = join(dir(), name)
    if (!stray.test(name) || claimed.has(file)) continue
    claimed.add(file)
    try {
      await archiveFile(root, file)
    } catch (error) {
      console.error('[gui] failed to archive a leftover chat', error)
    } finally {
      releaseHistoryFile(file)
    }
  }
}
