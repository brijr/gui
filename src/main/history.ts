import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { AgentId, Turn } from '../shared/types'

/** Everything needed to reopen a project's chat where it left off, including undo. */
export interface SavedChat {
  version: 1
  agentId: AgentId
  /** Agent session to resume, if the agent supports it */
  sessionId: string | null
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
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<SavedChat>
    if (parsed.version !== 1 || !Array.isArray(parsed.turns)) return null
    return {
      version: 1,
      agentId: parsed.agentId === 'codex' ? 'codex' : 'claude',
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
      // A turn still running when the app quit didn't finish.
      turns: parsed.turns.map((turn) =>
        turn.status === 'running'
          ? { ...turn, status: 'cancelled', endedAt: turn.startedAt }
          : turn,
      ),
      checkpoints: parsed.checkpoints ?? {},
      redo: parsed.redo ?? null,
    }
  } catch {
    return null
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

/**
 * Synchronous so the last save also lands when the app is quitting. Owner-only:
 * history holds prompts and page content.
 */
export function saveHistory(file: string, chat: SavedChat) {
  mkdirSync(dir(), { recursive: true, mode: 0o700 })
  const turns = chat.turns.map((turn) =>
    turn.context
      ? { ...turn, context: { ...turn.context, url: withoutQuery(turn.context.url) } }
      : turn,
  )
  writeFileSync(file, JSON.stringify({ ...chat, turns }), { mode: 0o600 })
}
