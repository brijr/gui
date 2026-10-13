import { expect, test } from 'bun:test'
import { ScopedRequestCache } from '../src/main/scoped-request-cache'

test('duplicate reads share a pending result and completed reads expire', async () => {
  const cache = new ScopedRequestCache<string, number>(0)
  let reads = 0
  let release!: () => void
  const read = async () => {
    reads++
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return reads
  }
  const first = cache.get('one', read)
  const second = cache.get('one', read)
  expect(second).toBe(first)
  await Promise.resolve()
  release()
  expect(await first).toBe(1)
  expect(await cache.get('one', async () => ++reads)).toBe(2)
})

test('account changes and invalidation cannot resurrect an old result', async () => {
  const cache = new ScopedRequestCache<string, string>(60_000)
  let release!: (value: string) => void
  const older = cache.get(
    'old',
    () =>
      new Promise<string>((resolve) => {
        release = resolve
      }),
  )
  await Promise.resolve()
  cache.clear()
  expect(await cache.get('new', async () => 'new result')).toBe('new result')
  release('old result')
  expect(await older).toBe('old result')
  expect(await cache.get('new', async () => 'wrong')).toBe('new result')
  expect(await cache.get('old', async () => 'fresh')).toBe('fresh')
})

test('failed reads remain retryable', async () => {
  const cache = new ScopedRequestCache<string, number>(60_000)
  await expect(
    cache.get('one', async () => {
      throw new Error('offline')
    }),
  ).rejects.toThrow('offline')
  expect(await cache.get('one', async () => 2)).toBe(2)
})
