import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { opener, xdgOpen } from '../src/main/desktop-open'
import type { ChildProcess, SpawnProcessOptions } from '../src/main/process'

function fakeSpawn() {
  const calls: { command: string; args: readonly string[]; options: SpawnProcessOptions }[] = []
  const child = Object.assign(new EventEmitter(), { unref: () => undefined })
  const spawn = (command: string, args: readonly string[], options: SpawnProcessOptions = {}) => {
    calls.push({ command, args, options })
    return child as unknown as ChildProcess
  }
  return { calls, child, spawn }
}

const saved = { ...process.env }
let dir: string | null = null
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = null
})

describe('the opener for each platform', () => {
  test("the Mac and Windows use Electron's shell", () => {
    expect(opener({ mac: true, windows: false })).toBe('shell')
    expect(opener({ mac: false, windows: true })).toBe('shell')
  })

  test('Linux and the other Unixes run xdg-open themselves', () => {
    expect(opener({ mac: false, windows: false })).toBe('xdg-open')
  })
})

describe('xdg-open on Linux', () => {
  test('starts detached with no stdio and no tty', async () => {
    const { calls, child, spawn } = fakeSpawn()
    const opened = xdgOpen('https://usegui.com', { wait: false, cwd: '/home/me' }, spawn)
    child.emit('spawn')
    await opened
    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe('xdg-open')
    expect(calls[0].args).toEqual(['https://usegui.com'])
    expect(calls[0].options).toMatchObject({
      cwd: '/home/me',
      detached: true,
      stdio: 'ignore',
      extra: { MM_NOTTTY: '1' },
    })
  })

  test('a link resolves once xdg-open starts; a file once it exits cleanly', async () => {
    const link = fakeSpawn()
    const opened = xdgOpen('https://usegui.com', { wait: false, cwd: '/' }, link.spawn)
    link.child.emit('spawn')
    await expect(opened).resolves.toBeUndefined()

    const file = fakeSpawn()
    const ok = xdgOpen('/tmp/a.txt', { wait: true, cwd: '/tmp' }, file.spawn)
    file.child.emit('spawn')
    file.child.emit('exit', 0, null)
    await expect(ok).resolves.toBeUndefined()

    const failed = fakeSpawn()
    const bad = xdgOpen('/tmp/a.txt', { wait: true, cwd: '/tmp' }, failed.spawn)
    failed.child.emit('exit', 3, null)
    await expect(bad).rejects.toThrow('(3)')
  })

  test('says so when xdg-open is missing', async () => {
    const { child, spawn } = fakeSpawn()
    const opened = xdgOpen('https://usegui.com', { wait: false, cwd: '/' }, spawn)
    child.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' }))
    await expect(opened).rejects.toThrow("Couldn't run xdg-open")
  })

  test('what xdg-open starts never sees the AppImage', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gui-xdg-open-'))
    const out = join(dir, 'env')
    const mount = '/tmp/.mount_GuiAbc'
    await writeFile(join(dir, 'xdg-open'), `#!/bin/sh\nenv > "${out}"\n`)
    await chmod(join(dir, 'xdg-open'), 0o755)
    process.env.APPDIR = mount
    process.env.APPIMAGE = '/home/me/Gui.AppImage'
    process.env.ARGV0 = 'Gui.AppImage'
    process.env.OWD = '/home/me'
    process.env.PATH = `${mount}/usr/bin:${dir}:/usr/bin:/bin`

    await xdgOpen('https://usegui.com', { wait: true, cwd: dir })

    const env = Object.fromEntries(
      (await readFile(out, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    )
    expect(env.ARGV0).toBeUndefined()
    expect(env.APPIMAGE).toBeUndefined()
    expect(env.APPDIR).toBeUndefined()
    expect(env.OWD).toBeUndefined()
    expect(env.PATH).toBe(`${dir}:/usr/bin:/bin`)
    expect(env.MM_NOTTTY).toBe('1')
    // Gui's own env is left alone: updates still read APPIMAGE.
    expect(process.env.APPIMAGE).toBe('/home/me/Gui.AppImage')
  })
})
