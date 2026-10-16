import { MAX_HISTORY_VERSIONS } from '../shared/bounded'
import type { FileChange, Version } from '../shared/types'
import type { SavedChat } from './history'
import type { LastMessage } from './history-summary'

/** Query strings and fragments can carry tokens; history only needs the page. */
function withoutQuery(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return ''
  }
}

export function serializeHistory(chat: SavedChat) {
  // Before/after images are for the live session only; history stays small.
  const turns = chat.turns.map(({ preview: _preview, ...turn }) => ({
    ...turn,
    context: turn.context.map((picked) => ({ ...picked, url: withoutQuery(picked.url) })),
  }))
  return JSON.stringify({ ...chat, turns })
}

/** Copy mutable containers without copying immutable (potentially very large) strings. */
export function snapshotHistory(chat: SavedChat): SavedChat {
  const seen = new WeakMap<object, unknown>()
  const copy = (value: unknown): unknown => {
    if (!value || typeof value !== 'object') return value
    const prior = seen.get(value)
    if (prior) return prior
    if (Array.isArray(value)) {
      const result: unknown[] = []
      seen.set(value, result)
      for (const item of value) result.push(copy(item))
      return result
    }
    const result: Record<string, unknown> = Object.create(null)
    seen.set(value, result)
    for (const [key, item] of Object.entries(value)) result[key] = copy(item)
    return result
  }
  const turns = chat.turns.map(({ preview: _preview, ...turn }) => ({
    ...turn,
    context: turn.context.map((picked) => ({ ...picked, url: withoutQuery(picked.url) })),
  }))
  return copy({ ...chat, turns }) as SavedChat
}

/** Bound string escaping and IPC payloads; yield between chunks so input remains responsive. */
export async function* historyChunks(chat: SavedChat, chunkBytes = 128 * 1024) {
  const ancestors = new Set<object>()
  function* encode(value: unknown): Generator<string> {
    if (typeof value === 'string') {
      yield '"'
      // JSON's escapes are composable, including split surrogate pairs.
      for (let start = 0; start < value.length; start += 8192)
        yield JSON.stringify(value.slice(start, start + 8192)).slice(1, -1)
      yield '"'
    } else if (value === null || typeof value !== 'object') {
      yield JSON.stringify(value) ?? 'null'
    } else {
      if (ancestors.has(value)) throw new Error('Circular chat history.')
      ancestors.add(value)
      if (Array.isArray(value)) {
        yield '['
        for (let index = 0; index < value.length; index++) {
          if (index) yield ','
          yield* encode(value[index])
        }
        yield ']'
      } else {
        yield '{'
        let first = true
        for (const [key, item] of Object.entries(value)) {
          if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue
          if (!first) yield ','
          first = false
          yield JSON.stringify(key)
          yield ':'
          yield* encode(item)
        }
        yield '}'
      }
      ancestors.delete(value)
    }
  }
  let parts: string[] = []
  let size = 0
  let started = performance.now()
  for (const part of encode(chat)) {
    parts.push(part)
    size += part.length
    if (size >= chunkBytes || performance.now() - started >= 3) {
      yield parts.join('')
      parts = []
      size = 0
      await new Promise<void>((resolve) => setImmediate(resolve))
      started = performance.now()
    }
  }
  if (parts.length) yield parts.join('')
}

const VERSION_ID = /^[a-f0-9-]{36}$/
const VERSION_SHA = /^[0-9a-f]{4,64}$/i
/** How many named and pre-restore versions a chat keeps */
export const MAX_VERSIONS = MAX_HISTORY_VERSIONS
const MAX_VERSION_NAME = 200
const MAX_VERSION_CHANGES = 5000

function isFileChange(value: unknown): value is FileChange {
  if (!value || typeof value !== 'object') return false
  const { path, status, additions, deletions } = value as Record<string, unknown>
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= 1000 &&
    (status === 'added' || status === 'modified' || status === 'deleted') &&
    typeof additions === 'number' &&
    Number.isFinite(additions) &&
    typeof deletions === 'number' &&
    Number.isFinite(deletions)
  )
}

/**
 * The saved named and pre-restore versions, keeping only whole ones: the file is just
 * JSON on disk, and a bad entry mustn't cost the chat its history.
 */
export function settleVersions(value: unknown): Version[] | undefined {
  if (!Array.isArray(value)) return undefined
  const versions = value.flatMap((entry): Version[] => {
    if (!entry || typeof entry !== 'object') return []
    const { id, sha, kind, name, createdAt, changes } = entry as Record<string, unknown>
    if (typeof id !== 'string' || !VERSION_ID.test(id)) return []
    if (typeof sha !== 'string' || !VERSION_SHA.test(sha)) return []
    if (kind !== 'named' && kind !== 'safety') return []
    if (typeof name !== 'string' || !name.trim()) return []
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return []
    const kept = Array.isArray(changes)
      ? changes.filter(isFileChange).slice(0, MAX_VERSION_CHANGES)
      : null
    return [
      {
        id,
        sha,
        kind,
        name: name.replace(/\s+/g, ' ').trim().slice(0, MAX_VERSION_NAME),
        createdAt,
        changes: Array.isArray(changes) ? kept : null,
      },
    ]
  })
  return versions.length ? versions.slice(-MAX_VERSIONS) : undefined
}

export type HistoryWriteRequest =
  | { action: 'begin'; id: string; file: string }
  | { action: 'append'; id: string; text: string }
  | { action: 'finish'; id: string; recent?: LastMessage | null }
  | { action: 'abort'; id: string }

export type HistoryWriteResult = { file: string; summary?: string } | null
