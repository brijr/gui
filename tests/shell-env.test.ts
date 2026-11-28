import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Gui's own Node.js lives under userData; here, nowhere it's installed.
const userData = join(tmpdir(), 'gui-shell-env-no-user-data')
mock.module('electron', () => ({ app: { isPackaged: false, getPath: () => userData } }))
const { shellEnvLoader } = await import('../src/main/shell-env')

/** What `$SHELL -ilc` prints: profile noise, the marker, then the env, NUL-separated. */
const shellOutput = (env: Record<string, string>) =>
  `Welcome!\n__GUI_ENV__${Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\0')}\0`

/** A shell read the test answers by hand, recording each call's time limit. */
function fakeShell() {
  const calls: { timeoutMs: number; answer: (output: string | null) => void }[] = []
  const read = (timeoutMs: number) =>
    new Promise<string | null>((resolve) => calls.push({ timeoutMs, answer: resolve }))
  return { read, calls }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

let home: string
let savedGuiPath: string | undefined
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gui-shell-env-'))
  savedGuiPath = process.env.GUI_PATH
  delete process.env.GUI_PATH
  spyOn(console, 'log').mockImplementation(() => {})
  spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  mock.restore()
  if (savedGuiPath !== undefined) process.env.GUI_PATH = savedGuiPath
  await rm(home, { recursive: true, force: true })
})

describe("the login shell's environment", () => {
  test('a shell that answers in time is used, read once, with no retry', async () => {
    const shell = fakeShell()
    const loader = shellEnvLoader(shell.read, home)
    const pending = loader.get()
    expect(loader.get()).toBe(pending)
    shell.calls[0].answer(shellOutput({ PATH: '/Users/me/.nvm/versions/node/v22/bin:/usr/bin' }))
    const env = await pending
    expect(env.PATH?.split(':')[0]).toBe('/Users/me/.nvm/versions/node/v22/bin')
    await tick()
    expect(shell.calls.map((c) => c.timeoutMs)).toEqual([8000])
  })

  test('a slow shell: the fallback now, the real env for what starts after it answers', async () => {
    await mkdir(join(home, '.bun/bin'), { recursive: true })
    await mkdir(join(home, '.local/bin'), { recursive: true })
    const shell = fakeShell()
    const loader = shellEnvLoader(shell.read, home)
    let arrived = 0
    loader.onArrived(() => arrived++)
    const pending = loader.get()
    shell.calls[0].answer(null)
    const env = await pending
    const fallback = env.PATH?.split(':') ?? []
    // Tools installed for this user, when they exist, and the usual folders.
    expect(fallback).toContain(join(home, '.bun/bin'))
    expect(fallback).toContain(join(home, '.local/bin'))
    expect(fallback).not.toContain(join(home, '.volta/bin'))
    expect(fallback).toContain('/usr/local/bin')
    expect(console.warn).toHaveBeenCalledTimes(1)

    // Read again in the background, with a longer limit; meanwhile a runtime is added.
    expect(shell.calls.map((c) => c.timeoutMs)).toEqual([8000, 60_000])
    await loader.addToPath('/gui/node/bin')
    expect(arrived).toBe(0)
    shell.calls[1].answer(shellOutput({ PATH: '/Users/me/.nvm/bin:/usr/bin', NVM_DIR: '/n' }))
    await tick()

    // The same object, now the real env: later spawns (and holders of it) get it.
    expect(await loader.get()).toBe(env)
    const real = env.PATH?.split(':') ?? []
    expect(real[0]).toBe('/Users/me/.nvm/bin')
    expect(real).toContain('/gui/node/bin')
    expect(real).not.toContain(join(home, '.bun/bin'))
    expect(env.NVM_DIR).toBe('/n')
    expect(arrived).toBe(1)
    expect(console.log).toHaveBeenCalledTimes(1)
  })

  test('a shell that never answers keeps the fallback and tells no one', async () => {
    const shell = fakeShell()
    const loader = shellEnvLoader(shell.read, home)
    let arrived = 0
    loader.onArrived(() => arrived++)
    const pending = loader.get()
    shell.calls[0].answer(null)
    const env = await pending
    const before = env.PATH
    shell.calls[1].answer(null)
    await tick()
    expect(env.PATH).toBe(before)
    expect(arrived).toBe(0)
    expect(shell.calls).toHaveLength(2)
    expect(console.warn).toHaveBeenCalledTimes(2)
  })

  test('a listener that throws does not stop the others', async () => {
    const shell = fakeShell()
    const loader = shellEnvLoader(shell.read, home)
    let reached = false
    spyOn(console, 'error').mockImplementation(() => {})
    loader.onArrived(() => {
      throw new Error('boom')
    })
    loader.onArrived(() => {
      reached = true
    })
    const pending = loader.get()
    shell.calls[0].answer(null)
    await pending
    shell.calls[1].answer(shellOutput({ PATH: '/usr/bin' }))
    await tick()
    expect(reached).toBe(true)
  })
})
