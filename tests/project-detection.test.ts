import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  chooseDevScript,
  detectProject,
  servesProduction,
  stripJsonComments,
} from '../src/main/project'

const roots: string[] = []

/** A throwaway project from `files` (path → contents; objects are written as JSON). */
function project(files: Record<string, unknown>) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'gui-detect-'))
  roots.push(root)
  for (const [path, contents] of Object.entries(files)) {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof contents === 'string' ? contents : JSON.stringify(contents))
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('choosing the dev script', () => {
  test('dev comes before start', () => {
    const { script } = chooseDevScript({ scripts: { start: 'node server.js', dev: 'vite' } })
    expect(script).toEqual({ name: 'dev', body: 'vite' })
  })

  test("a web app's own dev script stands in for a missing dev", () => {
    const pkg = { scripts: { 'dev:api': 'tsx api.ts', 'dev:web': 'vite', start: 'node .' } }
    expect(chooseDevScript(pkg).script?.name).toBe('dev:web')
    expect(chooseDevScript({ scripts: { 'web:dev': 'vite' } }).script?.name).toBe('web:dev')
    expect(chooseDevScript({ scripts: { 'dev:frontend': 'vite' } }).script?.name).toBe(
      'dev:frontend',
    )
    // A backend's own script isn't the app.
    expect(chooseDevScript({ scripts: { 'dev:api': 'tsx api.ts' } }).script).toBeNull()
  })

  test('start runs when it starts a server, not when it serves a build', () => {
    const express = { scripts: { start: 'node server.js' }, dependencies: { express: '5' } }
    expect(chooseDevScript(express).script?.name).toBe('start')

    const next = {
      scripts: { start: 'next start', build: 'next build' },
      dependencies: { next: '16' },
    }
    expect(chooseDevScript(next)).toEqual({ script: null, production: 'start' })

    const cra = { scripts: { start: 'react-scripts start' } }
    expect(chooseDevScript(cra).script?.name).toBe('start')

    // A production start, but a serve script that is a dev server.
    const vue = { scripts: { start: 'serve -s dist', serve: 'vue-cli-service serve' } }
    expect(chooseDevScript(vue)).toEqual({
      script: { name: 'serve', body: 'vue-cli-service serve' },
      production: null,
    })
  })

  test('production servers', () => {
    const framework = { dependencies: { nuxt: '4' } }
    for (const script of [
      'next start',
      'next start -p 4000',
      'npx next start',
      'NODE_ENV=production next start',
      'nuxt preview',
      'nuxi start',
      'astro preview',
      'vite preview --port 4173',
      'svelte-kit preview',
      'remix-serve ./build/server/index.js',
      'react-router-serve ./build/server/index.js',
      'serve -s build',
      'gatsby serve',
      'docusaurus serve',
    ]) {
      expect([script, servesProduction(script)]).toEqual([script, true])
    }
    expect(servesProduction('node .output/server/index.mjs', framework)).toBe(true)
    expect(servesProduction('node build', { dependencies: { '@sveltejs/kit': '2' } })).toBe(true)

    for (const script of [
      'next dev',
      'next',
      'vite',
      'astro dev',
      'nuxt dev',
      'node server.js',
      'remix vite:dev',
      'react-router dev',
      'node --watch index.js',
    ]) {
      expect([script, servesProduction(script)]).toEqual([script, false])
    }
    // Node running a build without a web framework is someone's own server.
    expect(servesProduction('node dist/index.js', { dependencies: { express: '5' } })).toBe(false)
  })
})

describe('detecting a project', () => {
  test('a single app runs its dev script', async () => {
    const root = project({ 'package.json': { name: 'site', scripts: { dev: 'vite' } } })
    const { project: info, apps, choosing } = await detectProject(root)
    expect(info.devCommand).toBe('npm run dev')
    expect(info.devScript).toBe('vite')
    expect(info.productionScript).toBeNull()
    expect(apps).toEqual([])
    expect(choosing).toBe(false)
  })

  test('the package manager comes from packageManager, else the lockfile', async () => {
    const declared = project({
      'package.json': { packageManager: 'pnpm@9.0.0', scripts: { dev: 'vite' } },
      'yarn.lock': '',
    })
    expect((await detectProject(declared)).project.devCommand).toBe('pnpm run dev')
    const locked = project({ 'package.json': { scripts: { dev: 'vite' } }, 'bun.lock': '' })
    expect((await detectProject(locked)).project.devCommand).toBe('bun run dev')
  })

  test('only a production start: nothing runs, and it says which script it passed over', async () => {
    const root = project({
      'package.json': {
        scripts: { build: 'next build', start: 'next start' },
        dependencies: { next: '16' },
      },
    })
    const { project: info } = await detectProject(root)
    expect(info.devCommand).toBeNull()
    expect(info.productionScript).toBe('start')
  })

  test('a monorepo with one app runs it in its folder', async () => {
    const root = project({
      'package.json': { workspaces: ['apps/*', 'packages/*'], scripts: { dev: 'turbo dev' } },
      'apps/web/package.json': {
        name: 'web',
        scripts: { dev: 'next dev' },
        dependencies: { next: '16' },
      },
      'packages/ui/package.json': {
        name: 'ui',
        main: 'index.js',
        scripts: { dev: 'tsup --watch' },
      },
    })
    const { project: info, apps, choosing } = await detectProject(root)
    expect(choosing).toBe(false)
    expect(apps).toEqual([{ dir: 'apps/web', name: 'web' }])
    expect(info.appDir).toBe('apps/web')
    expect(info.devCommand).toBe('npm run dev')
  })

  test('a monorepo app with only dev:web is found', async () => {
    const root = project({
      'package.json': { workspaces: ['apps/*'] },
      'apps/web/package.json': {
        name: 'web',
        scripts: { 'dev:web': 'vite' },
        devDependencies: { vite: '7' },
      },
    })
    const { project: info } = await detectProject(root)
    expect(info.appDir).toBe('apps/web')
    expect(info.devCommand).toBe('npm run dev:web')
  })

  test('a Turborepo app runs through turbo, so its dependsOn builds run first', async () => {
    const files = {
      'package.json': {
        packageManager: 'pnpm@9.0.0',
        devDependencies: { turbo: '^2.5.0' },
        scripts: { dev: 'turbo run dev' },
      },
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
      // Comments and trailing commas, as turbo.json allows.
      'turbo.json':
        '{\n  // tasks\n  "tasks": {\n    "dev": { "dependsOn": ["^build"], "persistent": true, },\n    "build": {},\n  },\n}\n',
      'apps/web/package.json': {
        name: '@acme/web',
        scripts: { dev: 'next dev' },
        dependencies: { next: '16' },
      },
    }
    const { project: info } = await detectProject(project(files))
    expect(info.appDir).toBe('apps/web')
    expect(info.devCommand).toBe('pnpm exec turbo run dev --filter=@acme/web')
    expect(info.devScript).toBe('next dev')

    // A task turbo.json doesn't define runs as the package's own script.
    const other = { ...files, 'turbo.json': '{ "tasks": { "build": {} } }' }
    expect((await detectProject(project(other))).project.devCommand).toBe('pnpm run dev')

    // Turbo 2 won't run without a declared package manager.
    const undeclared = {
      ...files,
      'package.json': { devDependencies: { turbo: '^2.5.0' }, workspaces: ['apps/*'] },
    }
    expect((await detectProject(project(undeclared))).project.devCommand).toBe('npm run dev')
  })

  test('several apps: nothing runs until one is picked, and the pick is kept', async () => {
    const root = project({
      'package.json': { workspaces: ['apps/*'] },
      'apps/docs/package.json': {
        name: 'docs',
        scripts: { dev: 'astro dev' },
        dependencies: { astro: '5' },
      },
      'apps/web/package.json': {
        name: 'web',
        scripts: { dev: 'vite' },
        dependencies: { vite: '7' },
      },
    })
    const asking = await detectProject(root)
    expect(asking.choosing).toBe(true)
    expect(asking.project.devCommand).toBeNull()
    const picked = await detectProject(root, 'apps/docs')
    expect(picked.choosing).toBe(false)
    expect(picked.project.appDir).toBe('apps/docs')
  })
})

describe('turbo.json comments', () => {
  test('strips comments and trailing commas, leaving strings alone', () => {
    const text = '{ "a": "x // not a comment", /* gone */ "b": [1, 2,], // end\n "c": "/*kept*/", }'
    expect(JSON.parse(stripJsonComments(text))).toEqual({
      a: 'x // not a comment',
      b: [1, 2],
      c: '/*kept*/',
    })
  })
})
