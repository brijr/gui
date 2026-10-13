import type { Stats } from 'node:fs'
import { type ChatSummary, isAgentId } from '../shared/types'
import type { SavedChat } from './history'

export const CHAT_ID = /^[a-f0-9-]{36}$/
const MAX_TITLE = 120
export const MAX_PROMPT = 200
/** Normal input is trimmed; legacy whitespace must not turn a preview into an unbounded scan. */
const MAX_PROMPT_SCAN = 4096

export interface LastMessage {
  prompt: string
  at: number
}

/** Inode, size and modification time survive our atomic rename and identify its bytes. */
export interface HistoryStamp {
  ino: number
  size: number
  mtimeMs: number
}

export const historyStamp = ({ ino, size, mtimeMs }: Stats): HistoryStamp => ({
  ino,
  size,
  mtimeMs,
})

export const sameHistoryStamp = (a: HistoryStamp, b: HistoryStamp) =>
  a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs

export const summaryFile = (file: string) => `${file.replace(/\.json$/, '')}.summary.json`

export interface LiveSummary {
  version: 1
  source: HistoryStamp
  recent: LastMessage | null
}

export function isLiveSummary(value: unknown): value is LiveSummary {
  if (!value || typeof value !== 'object') return false
  const { version, source, recent } = value as LiveSummary
  return (
    version === 1 &&
    !!source &&
    [source.ino, source.size, source.mtimeMs].every(
      (number) => typeof number === 'number' && Number.isFinite(number),
    ) &&
    (recent === null ||
      (!!recent &&
        typeof recent.prompt === 'string' &&
        recent.prompt.length <= MAX_PROMPT &&
        typeof recent.at === 'number' &&
        Number.isFinite(recent.at)))
  )
}

/** A title as the user typed it, on one line and cut short. */
export function cleanTitle(title: string) {
  return title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
}

/** Stop after the display limit rather than copying an arbitrarily large user message. */
function shortPrompt(value: unknown): string {
  if (typeof value !== 'string') return ''
  let text = ''
  let space = false
  for (const character of value.slice(0, MAX_PROMPT_SCAN)) {
    if (/\s/.test(character)) space = text.length > 0
    else {
      const next = (space ? ' ' : '') + character
      if (text.length + next.length > MAX_PROMPT) break
      text += next
      space = false
      if (text.length === MAX_PROMPT) break
    }
  }
  return text
}

export function lastMessageFor(saved: Partial<SavedChat>): LastMessage | null {
  const turns = Array.isArray(saved.turns) ? saved.turns : []
  const last = turns.at(-1)
  if (!last || typeof last.startedAt !== 'number' || !Number.isFinite(last.startedAt)) return null
  for (let index = turns.length - 1; index >= 0; index--) {
    const prompt = shortPrompt(turns[index]?.prompt)
    if (prompt) return { prompt, at: last.startedAt }
  }
  return { prompt: 'Image', at: last.startedAt }
}

/** Null for a chat with no turns, which isn't worth keeping in the archive. */
export function summarizeHistory(saved: SavedChat): ChatSummary | null {
  const first = saved.turns[0]
  const last = saved.turns.at(-1)
  if (!first || !last) return null
  let prompt = 'Image'
  for (const turn of saved.turns) {
    const text = shortPrompt(turn.prompt)
    if (text) {
      prompt = text
      break
    }
  }
  return {
    id: saved.id,
    title: saved.title ?? null,
    prompt,
    agentId: saved.agentId,
    turns: saved.turns.length,
    startedAt: saved.createdAt,
    lastAt: last.endedAt ?? last.startedAt,
  }
}

export function isSummary(value: unknown): value is ChatSummary {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === 'string' &&
    CHAT_ID.test(entry.id) &&
    (entry.title === null || typeof entry.title === 'string') &&
    typeof entry.prompt === 'string' &&
    isAgentId(entry.agentId) &&
    [entry.turns, entry.startedAt, entry.lastAt].every(
      (number) => typeof number === 'number' && Number.isFinite(number),
    )
  )
}
