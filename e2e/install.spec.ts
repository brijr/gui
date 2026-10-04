import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { expect, test } from './helpers/agent-install'

// Gui doesn't ship the agent CLIs, so a Mac without one has to be offered a download.
// What it downloads becomes the program Gui runs on the user's behalf, which is why the
// checks here are about what ends up on disk, not only about what the UI says.
//
// Everything runs against a local registry and a fake codex package (a shell script that
// prints a version); the real npm registry is never contacted. The fake CLI can't speak
// ACP, so the health check that follows an install may end in `error`. These tests only
// look at which CLI Gui chose and whether an install is still on offer.

test('a missing agent CLI is offered, then installed into the data folder', async ({
  launchInstall,
}) => {
  const gui = await launchInstall({ registry: 'serves-package' })

  // `install` reads 'update' instead of 'install' when the developer's own codex is the
  // wrong version; either way the user is offered Gui's copy and nothing is running yet.
  const offered = await gui.waitForCodex(
    (health) => health.status === 'not-installed',
    'codex to be offered for install',
  )
  expect(offered.install).not.toBeNull()
  expect(offered.binary).toBeNull()
  // Finding out that a CLI is missing must not download anything: the user hasn't agreed.
  expect(gui.requests).toEqual([])
  expect(gui.installedEntries()).toEqual([])

  await gui.install()
  // An install error leaves `binary` null; a later health-check error does not.
  const installed = await gui.waitForCodex(
    (health) => health.binary !== null || health.status === 'error',
    'codex to be installed',
  )
  expect(installed.binary, `the install failed: ${installed.message}`).not.toBeNull()

  // Gui now runs its own verified copy, so the adapter gets a CLI that matches it exactly.
  expect(installed.binary).toEqual({ source: 'gui', version: gui.cliVersion })
  expect(installed.install).toBeNull()
  expect(installed.status).not.toBe('not-installed')

  // The file the app resolves "Gui's own copy" from is the one that was served, and it runs.
  expect(gui.requests).toEqual([gui.route])
  expect(() => accessSync(gui.binaryPath, constants.X_OK)).not.toThrow()
  const printed = execFileSync(gui.binaryPath, ['--version'], { encoding: 'utf8' })
  expect(printed.trim()).toBe(gui.cliOutput)

  // An interrupted or finished install must not leave temp files behind, or the folder
  // would grow with every attempt.
  const entries = gui.installedEntries()
  expect(entries.filter((name) => name.startsWith('.'))).toEqual([])
  expect(entries).toEqual([gui.version])

  // The window can show a progress bar: it saw the download start and finish. The final
  // update skips the 150ms throttle, so a tiny file still reports its full size.
  const history = await gui.history()
  expect(history.some((health) => health.status === 'installing')).toBe(true)
  expect(history.map((health) => health.progress)).toContainEqual({
    received: gui.tarballSize,
    total: gui.tarballSize,
  })
})

test('a download that fails its checksum is rejected and nothing is installed', async ({
  launchInstall,
}) => {
  // The manifest pins one checksum, the registry serves other bytes: a tampered or
  // truncated package must never become the program Gui runs.
  const gui = await launchInstall({ registry: 'serves-package', checksum: 'differs' })
  await gui.waitForCodex(
    (health) => health.status === 'not-installed',
    'codex to be offered for install',
  )

  await gui.install()
  const failed = await gui.waitForCodex(
    (health) => health.status === 'error',
    'the install to fail',
  )

  expect(failed.message).toMatch(/checksum/i)
  // The bytes did arrive; they were refused on content, not lost on the way.
  expect(gui.requests).toEqual([gui.route])
  // Nothing was unpacked, and the rejected download was deleted.
  expect(gui.installedEntries()).toEqual([])
  expect(existsSync(gui.binaryPath)).toBe(false)
  // Still on offer, so the user can retry; no CLI was chosen and no progress bar is stuck.
  expect(failed.install).not.toBeNull()
  expect(failed.binary).toBeNull()
  expect(failed.progress).toBeNull()
})

test('a registry error is reported and installs nothing, leaving the install on offer', async ({
  launchInstall,
}) => {
  const gui = await launchInstall({ registry: 'not-found' })
  await gui.waitForCodex(
    (health) => health.status === 'not-installed',
    'codex to be offered for install',
  )

  await gui.install()
  const failed = await gui.waitForCodex(
    (health) => health.status === 'error',
    'the install to fail',
  )

  // The user is told what went wrong (the HTTP status), rather than seeing a stuck spinner.
  expect(failed.message).toContain('404')
  expect(gui.requests).toEqual([gui.route])
  expect(gui.installedEntries()).toEqual([])
  expect(existsSync(gui.binaryPath)).toBe(false)
  expect(failed.install).not.toBeNull()
  expect(failed.binary).toBeNull()
  expect(failed.progress).toBeNull()
})
