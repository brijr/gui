import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installLinuxLauncher, LINUX_LAUNCHER_PREFIX } from '../src/main/linux-cli'

const root = mkdtempSync(join(tmpdir(), 'gui-linux-cli-'))
const script = join(root, 'gui-script')
const target = join(root, 'bin', 'gui')
writeFileSync(script, '#!/bin/sh\necho gui script\n')
afterAll(() => rmSync(root, { recursive: true, force: true }))
beforeEach(() => rmSync(join(root, 'bin'), { recursive: true, force: true }))

const install = (confirmReplace: () => Promise<boolean>) =>
  installLinuxLauncher({ target, executable: "/opt/Gui's/gui", script, confirmReplace })

// A Linux launcher with Unix permission bits; Windows has neither.
describe.skipIf(process.platform === 'win32')('installing the gui command on Linux', () => {
  test('writes a launcher that names the executable and runs the script', async () => {
    let asked = false
    const done = await install(async () => {
      asked = true
      return true
    })
    expect(done).toBe(true)
    expect(asked).toBe(false)
    const launcher = readFileSync(target, 'utf8')
    expect(launcher.startsWith(`${LINUX_LAUNCHER_PREFIX}'/opt/Gui'\\''s/gui'\n`)).toBe(true)
    expect(launcher).toContain('echo gui script')
    expect(statSync(target).mode & 0o777).toBe(0o755)
  })

  test("replaces Gui's own launcher without asking", async () => {
    await install(async () => true)
    let asked = false
    expect(
      await install(async () => {
        asked = true
        return false
      }),
    ).toBe(true)
    expect(asked).toBe(false)
  })

  test("keeps a command Gui didn't install when the user cancels", async () => {
    mkdirSync(join(root, 'bin'))
    writeFileSync(target, '#!/bin/sh\necho someone else\n')
    expect(await install(async () => false)).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('#!/bin/sh\necho someone else\n')
  })

  test("replaces a command Gui didn't install once the user agrees", async () => {
    mkdirSync(join(root, 'bin'))
    writeFileSync(target, '#!/bin/sh\necho someone else\n')
    expect(await install(async () => true)).toBe(true)
    expect(readFileSync(target, 'utf8').startsWith(LINUX_LAUNCHER_PREFIX)).toBe(true)
  })
})
