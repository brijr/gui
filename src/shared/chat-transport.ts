import type { Turn, TurnItem } from './types'

type TurnFields = Omit<Turn, 'items' | 'id'>
export type ItemUpdate =
  | { kind: 'replace'; item: TurnItem }
  | { kind: 'append'; id: string; text: string }
export type ChatTurnUpdate =
  | { kind: 'snapshot'; revision: number; turn: Turn }
  | {
      kind: 'patch'
      id: string
      baseRevision: number
      revision: number
      fields: Partial<TurnFields>
      items: ItemUpdate[]
      order?: string[]
    }

/** Keeps immutable emission baselines; append-only text never retransmits its prefix. */
export class TurnPublisher {
  private previous = new Map<string, { revision: number; turn: Turn }>()

  clear() {
    this.previous.clear()
  }

  revisions(): Record<string, number> {
    return Object.fromEntries([...this.previous].map(([id, value]) => [id, value.revision]))
  }

  update(turn: Turn): ChatTurnUpdate {
    const before = this.previous.get(turn.id)
    const revision = (before?.revision ?? 0) + 1
    // Turn-level fields are replaced by ChatController, never edited in place. Keep their
    // references so screenshot/context strings are neither copied nor serialized per flush.
    // Agent item payloads can mutate in place, so each item needs its own stable baseline.
    const baseline = { ...turn, items: [] as TurnItem[] }
    if (!before) {
      baseline.items = turn.items.map((item) =>
        item.kind === 'text' || item.kind === 'thought' ? { ...item } : structuredClone(item),
      )
      this.previous.set(turn.id, { revision, turn: baseline })
      return { kind: 'snapshot', revision, turn }
    }
    const fields: Partial<TurnFields> = {}
    for (const key of Object.keys(turn) as (keyof Turn)[]) {
      if (key === 'items' || key === 'id') continue
      if (turn[key] !== before.turn[key]) {
        Object.assign(fields, { [key]: turn[key] })
      }
    }
    const known = new Map(before.turn.items.map((item) => [item.id, item]))
    const items: ItemUpdate[] = []
    for (const item of turn.items) {
      const old = known.get(item.id)
      if (
        old &&
        (item.kind === 'text' || item.kind === 'thought') &&
        old.kind === item.kind &&
        item.text.startsWith(old.text)
      ) {
        if (item.text.length !== old.text.length)
          items.push({ kind: 'append', id: item.id, text: item.text.slice(old.text.length) })
        baseline.items.push({ ...item })
      } else if (JSON.stringify(item) !== JSON.stringify(old)) {
        items.push({ kind: 'replace', item })
        baseline.items.push(structuredClone(item))
      } else if (old) {
        baseline.items.push(old)
      }
    }
    this.previous.set(turn.id, { revision, turn: baseline })
    const order = turn.items.map((item) => item.id)
    const reordered =
      order.length < before.turn.items.length ||
      before.turn.items.some((item, index) => item.id !== order[index])
    return {
      kind: 'patch',
      id: turn.id,
      baseRevision: before.revision,
      revision,
      fields,
      items,
      ...(reordered ? { order } : {}),
    }
  }
}

/** Null means a missing/out-of-order update: ask main for a fresh snapshot. */
export function applyTurnUpdate(
  turn: Turn | undefined,
  revision: number | undefined,
  update: ChatTurnUpdate,
): Turn | null {
  if (update.kind === 'snapshot') return update.turn
  if (!turn || revision !== update.baseRevision || update.revision !== revision + 1) return null
  const items = new Map(turn.items.map((item) => [item.id, item]))
  for (const change of update.items) {
    if (change.kind === 'replace') items.set(change.item.id, change.item)
    else {
      const item = items.get(change.id)
      if (!item || (item.kind !== 'text' && item.kind !== 'thought')) return null
      items.set(item.id, { ...item, text: item.text + change.text })
    }
  }
  const order = update.order ?? [
    ...turn.items.map((item) => item.id),
    ...update.items.flatMap((change) =>
      change.kind === 'replace' && !turn.items.some((item) => item.id === change.item.id)
        ? [change.item.id]
        : [],
    ),
  ]
  const ordered: TurnItem[] = []
  for (const id of order) {
    const item = items.get(id)
    if (!item) return null
    ordered.push(item)
  }
  return { ...turn, ...update.fields, items: ordered }
}
