import { spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test as base, expect } from '@playwright/test'
import type { WindowState } from '../src/shared/types'
import { REPO_ROOT, waitFor } from './helpers/env'
import { FIXTURES, type FixtureCopy, git } from './helpers/fixtures'
import { devServerPids, killAll, pidsInDirectory } from './helpers/processes'
import { type GuiSession, launchGui } from './helpers/session'

// Opening a project someone just cloned: no node_modules, no env file, and in a monorepo a
// root dev script that would start every package. Gui sets it up and previews one app.
//
// The fixtures (e2e/fixtures/fresh, e2e/fixtures/monorepo) have no registry dependencies:
// `bun install` only links a local `file:` package or the monorepo's own workspaces, so it
// runs offline in milliseconds, and each dev server imports what the install linked, so it
// can't start unless the install really ran.

type SetupFixture = 'fresh' | 'monorepo'

interface Fixtures {
  /**
   * Copies a setup fixture as a fresh clone (own git repo, no node_modules), lets `prepare`
   * add files to it, launches Gui on it (trusted), and cleans up after the test.
   */
  open: (name: SetupFixture, prepare?: (root: string) => void) => Promise<GuiSession>
  /** Keep the temp directories after the test (GUI_E2E_KEEP=1) to inspect a failure. */
  keepTemp: boolean
}

function copyFixture(name: SetupFixture, prepare?: (root: string) => void): FixtureCopy {
  // realpath: the app trusts and compares real paths, and macOS tmp is a symlink.
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'gui-e2e-setup-'))
  const root = join(base, `fixture-${name}`)
  const userData = join(base, 'user-data')
  mkdirSync(userData)
  cpSync(join(REPO_ROOT, 'e2e', 'fixtures', name), root, {
    recursive: true,
    // Left behind if someone ran the fixture by hand; a clone wouldn't have them.
    filter: (path) => !['node_modules', 'bun.lock'].includes(basename(path)),
  })
  prepare?.(root)
  git(root, 'init', '--quiet')
  git(root, 'add', '-A')
  git(root, 'commit', '--quiet', '-m', 'fixture')
  // launchGui takes a page fixture's copy, but only reads `spec` to seed recent projects,
  // which these tests don't do.
  return { spec: FIXTURES[0], base, root, userData }
}

const test = base.extend<Fixtures>({
  keepTemp: [process.env.GUI_E2E_KEEP === '1', { option: true }],

  open: async ({ keepTemp }, use, testInfo) => {
    const copies: FixtureCopy[] = []
    const sessions: GuiSession[] = []

    await use(async (name, prepare) => {
      const copy = copyFixture(name, prepare)
      copies.push(copy)
      const session = await launchGui(copy, { fixture: copy.spec.name }, testInfo)
      sessions.push(session)
      return session
    })

    const failed = testInfo.status !== testInfo.expectedStatus
    for (const session of sessions) {
      if (failed) await session.captureDiagnostics()
      await session.close()
    }
    const problems: string[] = []
    for (const copy of copies) {
      const gone = async () => devServerPids(copy.root).length === 0
      await waitFor(gone, 'dev server shutdown', { timeout: 15_000 }).catch(() => undefined)
      const left = devServerPids(copy.root)
      if (left.length > 0) problems.push(`Dev server still listening after quit (pids ${left})`)
      killAll(pidsInDirectory(copy.root))
      if (keepTemp) console.log(`[e2e] kept ${copy.base}`)
      else spawn('rm', ['-rf', copy.base], { detached: true, stdio: 'ignore' }).unref()
    }
    if (problems.length > 0) throw new Error(problems.join('\n'))
  },
})

/** Waits through install, dev server start and preview load; fails fast if a step fails. */
async function waitForPreview(session: GuiSession): Promise<WindowState> {
  const settled = async () => {
    const state = await session.state()
    const { status } = state.devServer
    const failed = state.setup?.dependencies === 'failed' || status === 'exited'
    return failed || (status === 'running' && state.preview.visible) ? state : null
  }
  const state = await waitFor(settled, 'install, dev server and preview', { timeout: 120_000 })
  if (state.setup?.dependencies === 'failed') {
    throw new Error(`Installing dependencies failed: ${state.devServer.lastLine}`)
  }
  if (state.devServer.status === 'exited') {
    const { exitCode, lastLine } = state.devServer
    throw new Error(`Dev server exited (code ${exitCode}): ${lastLine}`)
  }
  return state
}

/**
 * Intercepts `open -t` (how the app opens the env file) so creating it doesn't launch an
 * editor; returns what it opened. Patches child_process and syncs it into the app's ESM
 * imports; every other command still runs.
 */
async function recordOpenedFiles(session: GuiSession) {
  await session.app.evaluate(() => {
    const opened: string[] = []
    Object.assign(globalThis, { guiOpenedFiles: opened })
    const childProcess = process.getBuiltinModule('node:child_process')
    const execFile = childProcess.execFile
    const record = (file: string, ...rest: unknown[]) => {
      if (file !== '/usr/bin/open') return Reflect.apply(execFile, childProcess, [file, ...rest])
      const [args, callback] = rest
      opened.push(Array.isArray(args) ? String(args.at(-1)) : '')
      if (typeof callback === 'function') callback(null, '', '')
      return undefined
    }
    Object.assign(childProcess, { execFile: record })
    process.getBuiltinModule('node:module').syncBuiltinESMExports()
  })
  return () =>
    session.app.evaluate(() => {
      const store = globalThis as unknown as { guiOpenedFiles?: string[] }
      return store.guiOpenedFiles ?? []
    })
}

test('a fresh clone installs its dependencies, then starts and shows the app', async ({ open }) => {
  const session = await open('fresh')
  const { root } = session.fixture

  const state = await waitForPreview(session)
  expect(state.project?.devCommand).toBe('bun run dev')
  expect(state.project?.appDir).toBeNull()
  // Nothing left to set up once it's running.
  expect(state.setup).toBeNull()
  expect(existsSync(join(root, 'node_modules', 'greeting'))).toBe(true)

  // One terminal: the install's output, then the dev server's.
  const { data: logs } = await session.chrome.evaluate(() => window.gui.getLogs())
  const install = logs.indexOf('$ bun install')
  expect(install).toBeGreaterThanOrEqual(0)
  expect(install).toBeLessThan(logs.indexOf('$ bun run dev'))

  const preview = await session.previewPage()
  await expect(preview.locator('h1')).toHaveText('Gui fresh fixture')
  await session.shot('fresh-preview')
})

test('a project with nothing to start yet starts once its package.json appears', async ({
  open,
}) => {
  // Like a new project the agent is about to set up: nothing tells Gui how to start it.
  const session = await open('fresh', (root) =>
    renameSync(join(root, 'package.json'), join(root, 'package.later.json')),
  )
  const { root } = session.fixture
  await waitFor(async () => {
    const state = await session.state()
    return state.project && !state.project.devCommand ? state : null
  }, 'the project open with no dev script')

  await session.chrome.getByRole('button', { name: 'Toggle chat', exact: true }).click()
  await waitFor(async () => !(await session.state()).chatVisible, 'chat hidden')
  await session.chrome.getByRole('button', { name: 'Open chat', exact: true }).click()
  await waitFor(async () => (await session.state()).chatVisible, 'chat opened from the setup card')

  renameSync(join(root, 'package.later.json'), join(root, 'package.json'))
  const state = await waitForPreview(session)
  expect(state.project?.devCommand).toBe('bun run dev')
  const preview = await session.previewPage()
  await expect(preview.locator('h1')).toHaveText('Gui fresh fixture')
})

test('a failed install says so in the address bar and offers its output', async ({ open }) => {
  const session = await open('fresh', (root) => {
    const pkg = join(root, 'package.json')
    writeFileSync(pkg, readFileSync(pkg, 'utf8').replace('./vendor/greeting', './vendor/missing'))
  })
  const failed = await waitFor(
    async () => {
      const state = await session.state()
      return state.setup?.dependencies === 'failed' ? state : null
    },
    'the install to fail',
    { timeout: 60_000 },
  )
  // Not "Stopped": the address bar's status is the install's, and red.
  const toolbar = session.chrome.getByRole('banner')
  await expect(toolbar.getByRole('button', { name: /^Dev server: / })).toHaveAccessibleName(
    "Dev server: Couldn't install dependencies",
  )
  await expect(toolbar.getByLabel('App address')).toHaveAttribute(
    'placeholder',
    "Couldn't install dependencies",
  )
  // The output waits behind the card's button rather than opening on its own.
  expect(failed.drawer.open).toBe(false)
  await expect(session.chrome.getByText("Couldn't install dependencies")).toHaveCount(1)
  await session.shot('install-failed')
  await session.chrome.getByRole('button', { name: 'Show logs' }).click()
  await waitFor(async () => (await session.state()).drawer.open, 'the output to open')
  await expect(
    session.chrome.getByRole('tab', { name: 'Dev server', selected: true }),
  ).toBeVisible()
})

test('a monorepo asks which app to preview, then runs the one picked', async ({ open }) => {
  const session = await open('monorepo', (root) => {
    // Committed fixtures can't hold .env files (the repo ignores .env*).
    writeFileSync(join(root, 'apps', 'web', '.env.example'), 'API_URL=\n')
  })
  const { root, userData } = session.fixture

  const asking = await waitFor(async () => {
    const state = await session.state()
    return state.setup?.apps ? state : null
  }, 'the app chooser')
  // The root's `bun run --filter '*' dev` would start everything; the shared library's
  // watch script isn't an app.
  expect(asking.setup?.apps).toEqual([
    { dir: 'apps/docs', name: 'docs' },
    { dir: 'apps/web', name: 'web' },
  ])
  expect(asking.project?.appDir).toBeNull()
  expect(asking.project?.devCommand).toBeNull()
  // Nothing runs before the choice, not even the install.
  expect(asking.devServer.status).toBe('idle')
  expect(existsSync(join(root, 'node_modules'))).toBe(false)
  await session.shot('monorepo-chooser')

  await session.chrome.getByRole('button', { name: /apps\/web/ }).click()
  const state = await waitForPreview(session)
  expect(state.project?.appDir).toBe('apps/web')
  expect(state.project?.devCommand).toBe('bun run dev')
  expect(state.setup?.apps ?? null).toBeNull()
  // Installed once, at the workspace root.
  expect(existsSync(join(root, 'node_modules'))).toBe(true)
  // The env example is looked up in the app's folder first.
  expect(state.setup?.env).toEqual({
    example: 'apps/web/.env.example',
    target: 'apps/web/.env.local',
    created: false,
  })

  const preview = await session.previewPage()
  await expect(preview.locator('h1')).toHaveText('Gui monorepo: web')
  // The dev server runs inside the app's folder, and the pick is remembered.
  expect(devServerPids(join(root, 'apps', 'web')).length).toBeGreaterThan(0)
  const prefs: unknown = JSON.parse(readFileSync(join(userData, 'prefs.json'), 'utf8'))
  expect(prefs).toMatchObject({ apps: { [root]: 'apps/web' } })
})

test('an env example is offered and copied to .env.local without blocking the preview', async ({
  open,
}) => {
  const example = 'API_URL=https://example.com\nAPI_KEY=\n'
  const session = await open('fresh', (root) => writeFileSync(join(root, '.env.example'), example))
  const { root } = session.fixture
  const opened = await recordOpenedFiles(session)

  // The dev server starts anyway: many apps run without their env.
  const state = await waitForPreview(session)
  expect(state.setup?.env).toEqual({
    example: '.env.example',
    target: '.env.local',
    created: false,
  })
  const target = join(root, '.env.local')
  expect(existsSync(target)).toBe(false)

  await session.chrome.getByRole('button', { name: 'Create', exact: true }).click()
  await waitFor(async () => (await session.state()).setup?.env?.created, 'the env file')
  expect(readFileSync(target, 'utf8')).toBe(example)
  // It will hold secrets: readable by the user only.
  expect(statSync(target).mode & 0o777).toBe(0o600)
  expect(await opened()).toEqual([target])
  await expect(session.chrome.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
  await session.shot('env-created')
})
