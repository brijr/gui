import type { SavedChat } from './history'

type Path = (string | number)[]
type Primitive = string | number | boolean | null | undefined

/** A full history crosses the worker boundary in small batches, including large strings. */
export type HistoryPart =
  | { path: Path; kind: 'object' }
  | { path: Path; kind: 'array' }
  | { path: Path; kind: 'value'; value: Primitive }
  | { path: Path; kind: 'text'; text: string }

export function* historyParts(chat: SavedChat): Generator<HistoryPart> {
  function* visit(value: unknown, path: Path): Generator<HistoryPart> {
    if (typeof value === 'string') {
      yield { path, kind: 'value', value: '' }
      for (let start = 0; start < value.length; start += 8192)
        yield { path, kind: 'text', text: value.slice(start, start + 8192) }
    } else if (Array.isArray(value)) {
      yield { path, kind: 'array' }
      for (let index = 0; index < value.length; index++)
        yield* visit(value[index], [...path, index])
    } else if (value && typeof value === 'object') {
      yield { path, kind: 'object' }
      for (const [key, item] of Object.entries(value)) yield* visit(item, [...path, key])
    } else yield { path, kind: 'value', value: value as Primitive }
  }
  yield* visit(chat, [])
}

/** Bound clone/deserialization work for both many small fields and a single large response. */
export function nextHistoryParts(parts: Generator<HistoryPart>) {
  const batch: HistoryPart[] = []
  let size = 0
  while (size < 128 * 1024) {
    const next = parts.next()
    if (next.done) return { parts: batch, done: true }
    const part = next.value
    batch.push(part)
    size += 64 + part.path.reduce<number>((length, key) => length + String(key).length * 2, 0)
    if (part.kind === 'text') size += part.text.length * 2
  }
  return { parts: batch, done: false }
}

export function applyHistoryParts(chat: unknown, parts: HistoryPart[]): unknown {
  let result = chat
  for (const part of parts) {
    const value =
      part.kind === 'object'
        ? Object.create(null)
        : part.kind === 'array'
          ? []
          : part.kind === 'value'
            ? part.value
            : part.text
    if (!part.path.length) {
      result = value
      continue
    }
    let owner = result as Record<string | number, unknown>
    for (let index = 0; index < part.path.length - 1; index++)
      owner = owner[part.path[index]] as Record<string | number, unknown>
    const key = part.path.at(-1) as string | number
    if (part.kind === 'text') owner[key] = (owner[key] as string) + part.text
    else owner[key] = value
  }
  return result
}
