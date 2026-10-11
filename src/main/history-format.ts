import type { SavedChat } from './history'

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

export type HistoryWriteRequest =
  | { action: 'begin'; id: string; file: string }
  | { action: 'append'; id: string; text: string }
  | { action: 'finish' | 'abort'; id: string }
