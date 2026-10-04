import { spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test as base, expect } from '@playwright/test'
import { detectProject, findWorkspaceRoot } from '../src/main/project'
import type { WindowState } from '../src/shared/types'
import { REPO_ROOT, sleep, waitFor } from './helpers/env'
import { FIXTURES, git } from './helpers/fixtures'
import { devServerPids, killAll, pidsInDirectory } from './helpers/processes'
import { type GuiSession, launchGui } from './helpers/session'

// Monorepos and non-React pages. Opening one app's folder of a monorepo opens the monorepo
// (installs, the agent and checkpoints work from its root) with that app chosen; the
// root's own app is offered next to the workspace apps; and Astro-style source attributes
// map a picked element to its file when there's no React to ask.
//
// The fixtures have no registry dependencies (see setup.spec.ts), so installs run offline.

type Fixture = 'monorepo' | 'astro-like'

interface Copy {
  base: string
  /** Real path of the project (a git work tree) */
  root: string
  userData: string
}

interface OpenOptions {
  /** Changes files before the copy is committed */
  prepare?: (root: string) => void
  /**
   * Starts on an empty window with this folder (relative to the root) in recent projects,
   * for the test to open itself; by default the root opens at launch.
   */
  recent?: string
}

interface Opened {
  session: GuiSession
  root: string
}

interface Fixtures {
  /** Copies a fixture as a fresh clone, launches Gui on it (root trusted), cleans up. */
  open: (name: Fixture, options?: OpenOptions) => Promise<Opened>
  /** Keep the temp directories after the test (GUI_E2E_KEEP=1) to inspect a failure. */
  keepTemp: boolean
}

function copyFixture(name: Fixture, prepare?: (root: string) => void): Copy {
  // realpath: the app trusts and compares real paths, and macOS tmp is a symlink.
  const base = mkdtempSync(join(realpathSync(tmpdir()), 'gui-e2e-monorepo-'))
  const root = join(base, `fixture-${name}`)
  const userData = join(base, 'user-data')
  mkdirSync(userData)
  cpSync(join(REPO_ROOT, 'e2e', 'fixtures', name), root, {
    recursive: true,
    filter: (path) => !['node_modules', 'bun.lock'].includes(basename(path)),
  })
  prepare?.(root)
  git(root, 'init', '--quiet')
  git(root, 'add', '-A')
  git(root, 'commit', '--quiet', '-m', 'fixture')
  return { base, root, userData }
}

const test = base.extend<Fixtures>({
  keepTemp: [process.env.GUI_E2E_KEEP === '1', { option: true }],

  open: async ({ keepTemp }, use, testInfo) => {
    const copies: Copy[] = []
    const sessions: GuiSession[] = []

    await use(async (name, { prepare, recent } = {}) => {
      const copy = copyFixture(name, prepare)
      copies.push(copy)
      // Trust the project root, which is what the app opens even when given an app folder.
      writeFileSync(join(copy.userData, 'trusted-projects.json'), JSON.stringify([copy.root]))
      // launchGui opens `root` at launch, or with open: 'recent' lists it in recent projects.
      const launched = { ...copy, spec: FIXTURES[0] }
      const session = await launchGui(
        recent === undefined ? launched : { ...launched, root: join(copy.root, recent) },
        { fixture: 'vite', trusted: false, open: recent === undefined ? 'project' : 'recent' },
        testInfo,
      )
      sessions.push(session)
      return { session, root: copy.root }
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

/** Opens a folder the way Finder does (the app's `open-file` event). */
function openFromFinder(session: GuiSession, path: string) {
  return session.app.evaluate(({ app }, folder) => {
    app.emit('open-file', { preventDefault: () => undefined }, folder)
  }, path)
}

function prefsOf(userData: string): unknown {
  return JSON.parse(readFileSync(join(userData, 'prefs.json'), 'utf8'))
}

test('only a workspace app folder leads to its monorepo', async () => {
  const { base: scratch, root } = copyFixture('monorepo')
  try {
    expect(await findWorkspaceRoot(join(root, 'apps', 'web'))).toEqual({ root, appDir: 'apps/web' })
    // A library's watch script isn't an app; nor is the root, a folder of apps, or one inside an app.
    expect(await findWorkspaceRoot(join(root, 'packages', 'ui'))).toBeNull()
    expect(await findWorkspaceRoot(root)).toBeNull()
    expect(await findWorkspaceRoot(join(root, 'apps'))).toBeNull()
    mkdirSync(join(root, 'apps', 'web', 'src'))
    expect(await findWorkspaceRoot(join(root, 'apps', 'web', 'src'))).toBeNull()
    // An app that is a repo of its own stays on its own.
    mkdirSync(join(root, 'apps', 'docs', '.git'))
    expect(await findWorkspaceRoot(join(root, 'apps', 'docs'))).toBeNull()

    // A pnpm workspace whose root is an app too, with the lockfile only at the root.
    const pnpm = join(scratch, 'pnpm')
    mkdirSync(join(pnpm, '.git'), { recursive: true })
    writeFileSync(
      join(pnpm, 'package.json'),
      JSON.stringify({
        name: 'shape',
        packageManager: 'pnpm@10.0.0',
        scripts: { dev: 'tsx dev.ts' },
      }),
    )
    writeFileSync(join(pnpm, 'pnpm-workspace.yaml'), 'packages:\n  - website\n  - cli\n')
    writeFileSync(join(pnpm, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    mkdirSync(join(pnpm, 'website'))
    writeFileSync(
      join(pnpm, 'website', 'package.json'),
      JSON.stringify({ name: 'site', scripts: { dev: 'astro dev' }, dependencies: { astro: '7' } }),
    )
    mkdirSync(join(pnpm, 'cli'))
    writeFileSync(
      join(pnpm, 'cli', 'package.json'),
      JSON.stringify({ name: 'cli', scripts: { build: 'tsc' } }),
    )
    const member = await findWorkspaceRoot(join(pnpm, 'website'))
    expect(member).toEqual({ root: pnpm, appDir: 'website' })
    expect(await findWorkspaceRoot(join(pnpm, 'cli'))).toBeNull()
    const { project } = await detectProject(pnpm, member?.appDir ?? null)
    expect(project).toMatchObject({ packageManager: 'pnpm', appDir: 'website' })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('opening an app folder inside a monorepo opens the monorepo with that app', async ({
  open,
}) => {
  // Opened from recent projects, as an entry saved before Gui redirected app folders would be.
  const { session, root } = await open('monorepo', { recent: 'apps/web' })
  const { userData } = session.fixture
  await session.chrome.evaluate((path) => window.gui.openRecent(path), join(root, 'apps', 'web'))

  const state = await waitForPreview(session)
  expect(state.project?.root).toBe(root)
  expect(state.project?.appDir).toBe('apps/web')
  expect(state.project?.devCommand).toBe('bun run dev')
  expect(state.setup?.apps ?? null).toBeNull()
  // Installed once, at the workspace root.
  expect(existsSync(join(root, 'node_modules'))).toBe(true)
  const preview = await session.previewPage()
  await expect(preview.locator('h1')).toHaveText('Gui monorepo: web')
  expect(devServerPids(join(root, 'apps', 'web')).length).toBeGreaterThan(0)
  expect(prefsOf(userData)).toMatchObject({ apps: { [root]: 'apps/web' } })
  // Recent projects list the monorepo from now on.
  expect(state.recent[0]?.root).toBe(root)
  await session.shot('app-folder-opened')

  // Another app of the same monorepo switches this window rather than opening a second.
  await openFromFinder(session, join(root, 'apps', 'docs'))
  await waitFor(async () => {
    const { project, devServer } = await session.state()
    return project?.appDir === 'apps/docs' && devServer.status === 'running'
  }, 'the switch to the docs app')
  const switched = await session.previewPage()
  await expect(switched.locator('h1')).toHaveText('Gui monorepo: docs')
  expect(await session.windowCount()).toBe(1)
  expect(prefsOf(userData)).toMatchObject({ apps: { [root]: 'apps/docs' } })

  // The monorepo itself, already open, just comes to the front.
  await openFromFinder(session, root)
  await openFromFinder(session, join(root, 'apps', 'docs'))
  // Give a second window or another app switch time to show up.
  await sleep(2_000)
  expect(await session.windowCount()).toBe(1)
  const after = await session.state()
  expect(after.project?.appDir).toBe('apps/docs')
  expect(after.devServer.status).toBe('running')
  await expect(switched.locator('h1')).toHaveText('Gui monorepo: docs')
})

test("the root's own app is offered next to the workspace apps", async ({ open }) => {
  const { session, root } = await open('monorepo', {
    prepare: (dir) => {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      pkg.scripts.dev = 'bun server.js'
      writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
      writeFileSync(
        join(dir, 'server.js'),
        [
          'const server = Bun.serve({',
          '  port: 0,',
          "  fetch: () => new Response('<!doctype html><h1>Gui monorepo: root</h1>', {",
          "    headers: { 'content-type': 'text/html' },",
          '  }),',
          '})',
          "console.log('Local: ' + server.url)",
          '',
        ].join('\n'),
      )
    },
  })
  const { userData } = session.fixture

  const asking = await waitFor(async () => {
    const state = await session.state()
    return state.setup?.apps ? state : null
  }, 'the app chooser')
  expect(asking.setup?.apps).toEqual([
    { dir: '.', name: 'gui-e2e-monorepo' },
    { dir: 'apps/docs', name: 'docs' },
    { dir: 'apps/web', name: 'web' },
  ])
  expect(asking.devServer.status).toBe('idle')
  await session.shot('root-app-chooser')

  await session.chrome.getByRole('button', { name: /project root/ }).click()
  const state = await waitForPreview(session)
  expect(state.project?.appDir).toBeNull()
  expect(state.project?.devCommand).toBe('bun run dev')
  const preview = await session.previewPage()
  await expect(preview.locator('h1')).toHaveText('Gui monorepo: root')
  expect(prefsOf(userData)).toMatchObject({ apps: { [root]: '.' } })
})

test('Astro-style source attributes map a picked element to its file', async ({ open }) => {
  const { session } = await open('astro-like')
  await waitForPreview(session)

  // The label has no attributes; the button around it is the nearest that has them.
  const selection = await session.pickElement('span.label')
  await session.shot('astro-selected')
  expect(selection.tag).toBe('span')
  expect(selection.source).toEqual({
    file: 'src/components/Hero.astro',
    line: 12,
    column: 5,
    approximate: false,
  })
  expect(selection.componentStack).toEqual(['Hero', 'Layout'])
  // The rest of the context is unaffected.
  expect(selection.text).toBe('Get started')
  expect(Object.keys(selection.styles)).toContain('font-family')
  expect(selection.screenshot).toMatch(/^data:image\/png;base64,/)
})
