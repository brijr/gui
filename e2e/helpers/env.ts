import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Root of the Grat repo; its built output (`out/`) is the app under test. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const require = createRequire(import.meta.url)

/** Path of the Electron binary installed in this repo (the `electron` package exports it). */
export function electronExecutable(): string {
  const path: unknown = require('electron')
  if (typeof path !== 'string' || path === '') {
    throw new Error('Could not resolve the Electron executable; is `electron` installed?')
  }
  return path
}

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

interface WaitOptions {
  timeout?: number
  interval?: number
}

/**
 * Polls `check` until it returns something truthy. Errors thrown by `check` count as
 * "not yet" (pages navigate, windows open) and are reported if the wait times out.
 */
export async function waitFor<T>(
  check: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  label: string,
  { timeout = 60_000, interval = 250 }: WaitOptions = {},
): Promise<T> {
  const start = Date.now()
  let lastError: unknown
  for (;;) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    if (Date.now() - start > timeout) {
      const reason = lastError instanceof Error ? ` (last error: ${lastError.message})` : ''
      throw new Error(`Timed out after ${timeout}ms waiting for ${label}${reason}`)
    }
    await sleep(interval)
  }
}
