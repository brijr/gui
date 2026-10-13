/** Identity changes must stop an operation, rather than fall back to another git identity. */
export class CredentialScopeChanged extends Error {
  constructor() {
    super('Your Gui account or GitHub connection changed. Try again.')
  }
}

interface Scope {
  session: string | null
  generation: number
}

interface Entry<V> {
  scope: Scope
  value: Promise<V>
  pending: boolean
  until: number
}

export interface CredentialLease<V> {
  readonly value: V
  /** Recheck identity immediately before use, including after asynchronous preparation. */
  run<T>(action: (value: V) => T | Promise<T>): Promise<T>
  /** A late refused read cannot evict a newer identity's credential. */
  evict(): void
}

/** Repository credentials belong to both a Gui session and its current provider connection. */
export class SessionCredentialCache<K, V> {
  private generation = 0
  private entries = new Map<K, Entry<V>>()

  constructor(
    private readonly savedSession: () => Promise<string | null>,
    private readonly read: (key: K, session: string | null) => Promise<V>,
    private readonly ttlMs: number,
  ) {}

  clear() {
    this.generation++
    this.entries.clear()
  }

  /** Mutations always perform a fresh server-side authorization check. */
  async fresh(key: K): Promise<CredentialLease<V>> {
    const scope = await this.scope()
    const value = await this.load(key, scope)
    this.assertGeneration(scope)
    return this.lease(key, scope, value)
  }

  async get(key: K): Promise<CredentialLease<V>> {
    const scope = await this.scope()
    this.assertGeneration(scope)
    let entry = this.entries.get(key)
    if (
      !entry ||
      entry.scope.session !== scope.session ||
      entry.scope.generation !== scope.generation ||
      (!entry.pending && entry.until <= Date.now())
    ) {
      const next: Entry<V> = {
        scope,
        pending: true,
        until: 0,
        value: Promise.resolve().then(() => this.load(key, scope)),
      }
      entry = next
      this.entries.set(key, next)
      next.value = next.value.then(
        (value) => {
          next.pending = false
          next.until = Date.now() + this.ttlMs
          return value
        },
        (error) => {
          if (this.entries.get(key) === next) this.entries.delete(key)
          throw error
        },
      )
    }
    const value = await entry.value
    await this.assertCurrent(scope)
    this.assertGeneration(scope)
    return this.lease(key, scope, value, entry)
  }

  private async scope(): Promise<Scope> {
    const generation = this.generation
    const session = await this.savedSession()
    if (generation !== this.generation) throw new CredentialScopeChanged()
    return { session, generation }
  }

  private async assertCurrent(scope: Scope) {
    this.assertGeneration(scope)
    const session = await this.savedSession()
    if (scope.generation !== this.generation || scope.session !== session)
      throw new CredentialScopeChanged()
  }

  private assertGeneration(scope: Scope) {
    if (scope.generation !== this.generation) throw new CredentialScopeChanged()
  }

  private async load(key: K, scope: Scope) {
    await this.assertCurrent(scope)
    this.assertGeneration(scope)
    try {
      const value = await this.read(key, scope.session)
      await this.assertCurrent(scope)
      this.assertGeneration(scope)
      return value
    } catch (error) {
      // A stale service failure must not trigger fallback under a replacement identity.
      await this.assertCurrent(scope)
      this.assertGeneration(scope)
      throw error
    }
  }

  private lease(key: K, scope: Scope, value: V, entry?: Entry<V>): CredentialLease<V> {
    return {
      value,
      run: async (action) => {
        await this.assertCurrent(scope)
        // The generation can change in the microtask between the check resolving and this
        // continuation. Keep the final guard and dispatch in the same synchronous step.
        this.assertGeneration(scope)
        try {
          const result = await action(value)
          await this.assertCurrent(scope)
          this.assertGeneration(scope)
          return result
        } catch (error) {
          await this.assertCurrent(scope)
          this.assertGeneration(scope)
          throw error
        }
      },
      evict: () => {
        if (entry && this.entries.get(key) === entry) this.entries.delete(key)
      },
    }
  }
}
