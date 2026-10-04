import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import {
  type AgentId,
  DEFAULT_AGENT_ID,
  isAgentId,
  type Turn,
  type TurnItem,
} from '../shared/types'

/** Everything needed to reopen a project's chat where it left off, including undo. */
export interface SavedChat {
  version: 1
  agentId: AgentId
  /** Agent session to resume, if the agent supports it */
  sessionId: string | null
  /** Whether that session has received Grat's instructions (absent in older files) */
  primed?: boolean
  /** Whether those instructions included the preview tools */
  primedWithTools?: boolean
  turns: Turn[]
  /** Checkpoint shas per turn id, so restored turns can still be undone */
  checkpoints: Record<string, { before: string | null; after: string | null }>
  redo: { sha: string; paths: string[]; turnIds: string[] } | null
}

const dir = () => join(app.getPath('userData'), 'chats')

export async function historyFile(root: string) {
  const real = await realpath(root).catch(() => root)
  return join(dir(), `${createHash('sha1').update(real).digest('hex').slice(0, 16)}.json`)
}

export async function loadHistory(file: string): Promise<SavedChat | null> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(text) as Partial<SavedChat> | null
    if (parsed?.version !== 1 || !Array.isArray(parsed.turns)) throw new Error('unknown format')
    const checkpoints = parsed.checkpoints ?? {}
    return {
      version: 1,
      agentId: isAgentId(parsed.agentId) ? parsed.agentId : DEFAULT_AGENT_ID,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
      primed: parsed.primed === true,
      primedWithTools: parsed.primedWithTools === true,
      turns: parsed.turns.map((turn) => settleTurn(turn, checkpoints[turn.id]?.before ?? null)),
      checkpoints,
      redo: parsed.redo ?? null,
    }
  } catch (error) {
    // Keep what's there for recovery instead of letting the next save overwrite it.
    const aside = `${file.replace(/\.json$/, '')}.corrupt-${Date.now()}.json`
    console.error(`[grat] unreadable chat history, moved to ${aside}`, error)
    await rename(file, aside).catch(() => undefined)
    return null
  }
}

/** Nothing was running when the app quit, so open permission prompts can't be answered. */
function settleTurn(turn: Turn, before: string | null): Turn {
  const items = turn.items.map(settleItem)
  if (turn.status !== 'running') return { ...turn, items }
  return {
    ...turn,
    items,
    status: 'cancelled',
    endedAt: turn.startedAt,
    // Its edits were never diffed, but its starting checkpoint can still undo them.
    ...(before && turn.changes === null ? { changesUnknown: true } : {}),
  }
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

/** Query strings and fragments can carry tokens; history only needs the page. */
function withoutQuery(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return ''
  }
}

function serialize(chat: SavedChat) {
  // Before/after images are for the live session only; history stays small.
  const turns = chat.turns.map(({ preview: _preview, ...turn }) =>
    turn.context
      ? { ...turn, context: { ...turn.context, url: withoutQuery(turn.context.url) } }
      : turn,
  )
  return JSON.stringify({ ...chat, turns })
}

/** A sibling temp file, so the rename that replaces the history is atomic. */
const tempFile = (file: string) => `${file}.${randomBytes(6).toString('hex')}.tmp`

/**
 * Saves one chat's history: in the background one write at a time (the latest state
 * wins), or synchronously for the last save before the chat goes away. Each write goes
 * to a temp file that replaces the history only once complete, so a crash can't
 * truncate it. Owner-only: history holds prompts and page content.
 */
export class HistoryWriter {
  private writing = false
  private dirty = false
  private closed = false

  constructor(
    private readonly file: string,
    private readonly read: () => SavedChat,
  ) {}

  save() {
    if (this.closed) return
    this.dirty = true
    if (!this.writing) void this.drain()
  }

  /** Final save; later saves are ignored and a background write still in flight is dropped. */
  saveSync() {
    this.closed = true
    this.dirty = false
    const tmp = tempFile(this.file)
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      writeFileSync(tmp, serialize(this.read()), { mode: 0o600, flag: 'wx' })
      renameSync(tmp, this.file)
    } catch (error) {
      console.error('[grat] failed to save chat history', error)
      try {
        rmSync(tmp, { force: true })
      } catch {
        // Best effort; a stray temp file is harmless.
      }
    }
  }

  private async drain() {
    this.writing = true
    while (this.dirty && !this.closed) {
      this.dirty = false
      const tmp = tempFile(this.file)
      try {
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
        await writeFile(tmp, serialize(this.read()), { mode: 0o600, flag: 'wx' })
        // Checked and renamed with no await between, so a final saveSync can't be
        // overwritten by this older state.
        if (this.closed) await rm(tmp, { force: true })
        else renameSync(tmp, this.file)
      } catch (error) {
        console.error('[grat] failed to save chat history', error)
        await rm(tmp, { force: true }).catch(() => undefined)
      }
    }
    this.writing = false
  }
}
