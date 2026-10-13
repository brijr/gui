import {
  createContext,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useSyncExternalStore,
} from 'react'

/** User choices and pending actions survive virtual-row unmounts, without keeping DOM alive. */
export class TurnPresentation {
  private values = new Map<string, unknown>()
  private listeners = new Map<string, Set<() => void>>()

  read<T>(key: string, initial: T): T {
    if (!this.values.has(key)) this.values.set(key, initial)
    return this.values.get(key) as T
  }

  write<T>(key: string, next: SetStateAction<T>, initial: T) {
    const before = this.read(key, initial)
    const value = typeof next === 'function' ? (next as (before: T) => T)(before) : next
    if (Object.is(value, before)) return
    this.values.set(key, value)
    for (const listener of this.listeners.get(key) ?? []) listener()
  }

  subscribe(key: string, listener: () => void) {
    const listeners = this.listeners.get(key) ?? new Set<() => void>()
    this.listeners.set(key, listeners)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.listeners.delete(key)
    }
  }

  retain(ids: readonly string[]) {
    const allowed = new Set(ids)
    for (const key of this.values.keys()) {
      if (!allowed.has(key.slice(0, key.indexOf('\0')))) this.values.delete(key)
    }
  }
}

const Presentation = createContext<TurnPresentation | null>(null)
const TurnId = createContext('')

export function TurnPresentationProvider({
  state,
  children,
}: {
  state: TurnPresentation
  children: ReactNode
}) {
  return <Presentation value={state}>{children}</Presentation>
}

export function TurnPresentationScope({ id, children }: { id: string; children: ReactNode }) {
  return <TurnId value={id}>{children}</TurnId>
}

export function useTurnPresentation<T>(name: string, initial: T) {
  const state = useContext(Presentation)
  const id = useContext(TurnId)
  // TurnView is always under the transcript's owner. Failing here catches an accidental
  // use outside that lifetime instead of retaining another chat's presentation globally.
  if (!state) throw new Error('Turn presentation requires a transcript owner')
  const key = `${id}\0${name}`
  const subscribe = useCallback(
    (listener: () => void) => state.subscribe(key, listener),
    [state, key],
  )
  const snapshot = useCallback(() => state.read(key, initial), [state, key, initial])
  const value = useSyncExternalStore(subscribe, snapshot, snapshot)
  const setValue = useCallback(
    (next: SetStateAction<T>) => state.write(key, next, initial),
    [state, key, initial],
  )
  return [value, setValue] as const
}
