/** Measured turn heights, including the width at which their content wrapped. */
export interface TurnHeight {
  height: number
  width: number
}

export const TURN_GAP = 24
export const ESTIMATED_TURN_HEIGHT = 180
export const TURN_OVERSCAN = 400

/** A compact index: archived turns need positions, without mounting their content. */
export class TurnLayout {
  readonly offsets: number[] = [0]
  readonly indices: Map<string, number>
  readonly total: number

  constructor(
    readonly ids: readonly string[],
    heights: ReadonlyMap<string, TurnHeight>,
    width: number,
  ) {
    this.indices = new Map(ids.map((id, index) => [id, index]))
    for (const id of ids) {
      const measured = heights.get(id)
      const height = measured?.width === width ? measured.height : ESTIMATED_TURN_HEIGHT
      this.offsets.push(this.offsets[this.offsets.length - 1] + height + TURN_GAP)
    }
    this.total = Math.max(0, this.offsets[this.offsets.length - 1] - TURN_GAP)
  }

  /** The turn covering a scroll coordinate, found without scanning the history. */
  at(top: number) {
    let low = 0
    let high = this.ids.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (this.offsets[middle + 1] <= top) low = middle + 1
      else high = middle
    }
    return Math.min(low, Math.max(0, this.ids.length - 1))
  }

  window(top: number, height: number, pinned: readonly string[] = []) {
    if (!this.ids.length) return []
    const first = this.at(Math.max(0, top - TURN_OVERSCAN))
    const last = this.at(top + Math.max(1, height) + TURN_OVERSCAN)
    const indices = new Set<number>()
    for (let index = first; index <= last; index++) indices.add(index)
    for (const id of pinned) {
      const index = this.indices.get(id)
      if (index !== undefined) indices.add(index)
    }
    return [...indices].sort((a, b) => a - b)
  }

  anchor(top: number) {
    if (!this.ids.length) return null
    const index = this.at(top)
    return { id: this.ids[index], offset: top - this.offsets[index] }
  }

  restore(anchor: { id: string; offset: number }) {
    const index = this.indices.get(anchor.id)
    return index === undefined ? null : this.offsets[index] + anchor.offset
  }
}
