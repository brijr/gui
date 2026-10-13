import { resolve } from 'node:path'

/** A reopened project waits for retired tabs' final writes and resource claims. */
const retiring = new Map<string, Promise<void>>()

export function retireProject(root: string | null, completion: Promise<void>) {
  if (!root) return completion
  const key = resolve(root)
  const prior = retiring.get(key)
  const pending = Promise.allSettled([prior, completion]).then(() => undefined)
  retiring.set(key, pending)
  void pending.then(() => {
    if (retiring.get(key) === pending) retiring.delete(key)
  })
  return pending
}

export function waitForRetiredProject(root: string) {
  return retiring.get(resolve(root)) ?? Promise.resolve()
}
