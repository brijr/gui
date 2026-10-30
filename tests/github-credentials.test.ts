import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  CredentialScopeChanged,
  SessionCredentialCache,
} from '../src/main/session-credential-cache'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await Promise.resolve()
  }
  throw new Error('Credential request did not start')
}

test('current-session read credentials coalesce and reuse while fresh mutations bypass the cache', async () => {
  const gate = deferred<string>()
  let reads = 0
  const cache = new SessionCredentialCache(
    async () => 'session',
    async () => {
      reads++
      return reads === 1 ? gate.promise : `credential-${reads}`
    },
    60_000,
  )
  const first = cache.get(1)
  const second = cache.get(1)
  await until(() => reads === 1)
  gate.resolve('credential-1')
  const leases = await Promise.all([first, second])
  expect(leases.map((lease) => lease.value)).toEqual(['credential-1', 'credential-1'])
  expect((await cache.get(1)).value).toBe('credential-1')
  expect(reads).toBe(1)
  expect((await cache.fresh(1)).value).toBe('credential-2')
  expect((await cache.fresh(1)).value).toBe('credential-3')
  expect((await cache.get(1)).value).toBe('credential-1')
})

test('account replacement rejects pending old credentials without repopulating the current cache', async () => {
  let session = 'old'
  const gate = deferred<string>()
  const requests: string[] = []
  const cache = new SessionCredentialCache(
    async () => session,
    async (_id, token) => {
      requests.push(token ?? '')
      return token === 'old' ? gate.promise : 'new credential'
    },
    60_000,
  )
  const pending = cache.get(1)
  await until(() => requests.length === 1)
  session = 'new'
  cache.clear()
  const current = await cache.get(1)
  gate.resolve('old credential')
  await expect(pending).rejects.toBeInstanceOf(CredentialScopeChanged)
  expect((await cache.get(1)).value).toBe(current.value)
  expect(requests).toEqual(['old', 'new'])
})

test('a changed saved session is isolated even before its change event arrives', async () => {
  let session = 'old'
  let reads = 0
  const cache = new SessionCredentialCache(
    async () => session,
    async (_id, token) => {
      reads++
      return token
    },
    60_000,
  )
  const old = await cache.get(1)
  session = 'new'
  const current = await cache.get(1)
  expect(current.value).toBe('new')
  let used = false
  await expect(
    old.run(() => {
      used = true
    }),
  ).rejects.toBeInstanceOf(CredentialScopeChanged)
  expect(used).toBe(false)
  expect(reads).toBe(2)
})

test('same-session disconnect/reconnect invalidates pending provider credentials and fresh fetches', async () => {
  let provider = 'old'
  const gate = deferred<string>()
  let reads = 0
  const cache = new SessionCredentialCache(
    async () => 'same Gui session',
    async () => {
      reads++
      return provider === 'old' ? gate.promise : 'new provider'
    },
    60_000,
  )
  const cached = cache.get(1)
  const fresh = cache.fresh(1)
  await until(() => reads === 2)
  cache.clear()
  provider = 'new'
  cache.clear()
  expect((await cache.get(1)).value).toBe('new provider')
  gate.resolve('old provider')
  const results = await Promise.allSettled([cached, fresh])
  for (const result of results) {
    expect(result.status).toBe('rejected')
    if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(CredentialScopeChanged)
  }
  expect((await cache.get(1)).value).toBe('new provider')
  expect(reads).toBe(3)
})

test('credential failures retain their error and retry without caching the failed request', async () => {
  const failure = new Error('Service unavailable')
  let reads = 0
  const cache = new SessionCredentialCache(
    async () => 'session',
    async () => {
      if (++reads === 1) throw failure
      return 'recovered'
    },
    60_000,
  )
  await expect(cache.get(1)).rejects.toBe(failure)
  expect((await cache.get(1)).value).toBe('recovered')
  expect(reads).toBe(2)
})

test('late reads cannot evict a replacement credential or return another account’s response', async () => {
  let session = 'old'
  let reads = 0
  const cache = new SessionCredentialCache(
    async () => session,
    async (_id, token) => {
      reads++
      return token
    },
    60_000,
  )
  const old = await cache.get(1)
  const gate = deferred<string>()
  let started = false
  const pending = old.run(() => {
    started = true
    return gate.promise
  })
  await until(() => started)
  session = 'new'
  cache.clear()
  const newer = await cache.get(1)
  old.evict()
  gate.resolve('old response')
  await expect(pending).rejects.toBeInstanceOf(CredentialScopeChanged)
  expect((await cache.get(1)).value).toBe(newer.value)
  expect(reads).toBe(2)
})

test('invalidation during saved-session lookup prevents a credential request entirely', async () => {
  const session = deferred<string>()
  let reads = 0
  const cache = new SessionCredentialCache(
    () => session.promise,
    async () => {
      reads++
      return 'unused'
    },
    60_000,
  )
  const pending = cache.get(1)
  cache.clear()
  session.resolve('session')
  await expect(pending).rejects.toBeInstanceOf(CredentialScopeChanged)
  expect(reads).toBe(0)
})

test('expired credentials are fetched again', async () => {
  let reads = 0
  const cache = new SessionCredentialCache(
    async () => 'session',
    async () => ++reads,
    0,
  )
  expect((await cache.get(1)).value).toBe(1)
  expect((await cache.get(1)).value).toBe(2)
})

test('invalidation between the asynchronous identity check and dispatch prevents token use', async () => {
  let invalidate = false
  const cache = new SessionCredentialCache(
    async () => {
      if (invalidate) {
        invalidate = false
        // After assertCurrent reads this session, but before lease.run resumes.
        queueMicrotask(() => queueMicrotask(() => cache.clear()))
      }
      return 'session'
    },
    async () => 'credential',
    60_000,
  )
  const lease = await cache.get(1)
  let used = false
  invalidate = true
  await expect(
    lease.run(() => {
      used = true
    }),
  ).rejects.toBeInstanceOf(CredentialScopeChanged)
  expect(used).toBe(false)
})

test('github.ts clones guard account/provider races and service fallback', async () => {
  const result = await promisify(execFile)(process.execPath, [
    join(import.meta.dirname, 'fast', 'github-credentials.ts'),
  ])
  expect(result.stdout).toContain('credential races and fallback passed')
  expect(result.stderr).toBe('')
}, 10_000)
