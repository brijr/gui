/** One short-lived read result, scoped to its account; failed or invalidated reads are not kept. */
export class ScopedRequestCache<K, V> {
  private entry: { key: K; promise: Promise<V>; until: number; pending: boolean } | null = null

  constructor(private readonly ttlMs: number) {}

  clear() {
    this.entry = null
  }

  get(key: K, read: () => Promise<V>): Promise<V> {
    const kept = this.entry
    if (kept && kept.key === key && (kept.pending || kept.until > Date.now())) return kept.promise
    const entry = { key, promise: Promise.resolve().then(read), until: 0, pending: true }
    this.entry = entry
    entry.promise = entry.promise.then(
      (value) => {
        entry.pending = false
        entry.until = Date.now() + this.ttlMs
        return value
      },
      (error) => {
        if (this.entry === entry) this.entry = null
        throw error
      },
    )
    return entry.promise
  }
}
