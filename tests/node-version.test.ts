import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withPathFirst } from '../src/main/dev-server'
import {
  nodeRanges,
  nodeVersionIn,
  oldestAllowed,
  parseNodeVersion,
  wantsGuiNode,
} from '../src/main/node-version'
import { writeTemplate } from '../src/main/templates'

const VITE = '^20.19.0 || >=22.12.0'

async function scratch(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'gui-node-version-'))
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), text)
  }
  return root
}

const pkg = (engines?: unknown) => JSON.stringify({ name: 'x', ...(engines ? { engines } : {}) })

describe('what Node.js a project needs', () => {
  test('reads engines.node from the app and, in a monorepo, the root', async () => {
    const root = await scratch({
      'package.json': pkg({ node: '>=20' }),
      'apps/web/package.json': pkg({ node: VITE }),
      'apps/plain/package.json': pkg(),
    })
    try {
      expect(await nodeRanges(root, null)).toEqual(['>=20'])
      expect(await nodeRanges(root, 'apps/web')).toEqual([VITE, '>=20'])
      expect(await nodeRanges(root, 'apps/plain')).toEqual(['>=20'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('no package.json, no engines, broken JSON or a range that is not one say nothing', async () => {
    const root = await scratch({
      'a/package.json': pkg(),
      'b/package.json': '{ not json',
      'c/package.json': pkg({ node: 'latest and greatest' }),
      'd/package.json': pkg({ node: 20 }),
      'e/package.json': pkg({ npm: '>=10' }),
    })
    try {
      for (const dir of ['a', 'b', 'c', 'd', 'e', 'missing']) {
        expect(await nodeRanges(join(root, dir), null)).toEqual([])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("Gui's starters say what Vite needs", async () => {
    const root = await mkdtemp(join(tmpdir(), 'gui-node-version-'))
    try {
      await writeTemplate(root, 'website', 'Site')
      expect(await nodeRanges(root, null)).toEqual([VITE])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("when a project runs on Gui's Node.js", () => {
  test('only when the user’s is known, too old, and Gui’s fits', () => {
    // Vite 8 on Node 18, or a 20 or 22 too early in its line.
    expect(wantsGuiNode([VITE], '18.20.8', '24.21.0')).toBe(true)
    expect(wantsGuiNode([VITE], '20.11.1', '24.21.0')).toBe(true)
    expect(wantsGuiNode([VITE], '22.11.0', '24.21.0')).toBe(true)
    // The user's meets it: theirs, always.
    expect(wantsGuiNode([VITE], '20.19.0', '24.21.0')).toBe(false)
    expect(wantsGuiNode([VITE], '26.13.0', '24.21.0')).toBe(false)
    // Nothing stated, or the user's version unknown: nothing changes.
    expect(wantsGuiNode([], '18.20.8', '24.21.0')).toBe(false)
    expect(wantsGuiNode([VITE], null, '24.21.0')).toBe(false)
  })

  test("never when Gui's doesn't meet it either", () => {
    // Pinned to an older line: switching wouldn't help.
    expect(wantsGuiNode(['18.x'], '16.20.2', '24.21.0')).toBe(false)
    expect(wantsGuiNode(['>=16 <21'], '22.0.0', '24.21.0')).toBe(false)
    // Asks for newer than Gui has.
    expect(wantsGuiNode(['>=26'], '22.12.0', '24.21.0')).toBe(false)
  })

  test('every stated range must be met (app and root)', () => {
    expect(wantsGuiNode([VITE, '>=20'], '20.11.0', '24.21.0')).toBe(true)
    expect(wantsGuiNode([VITE, '<24'], '18.20.8', '24.21.0')).toBe(false)
  })

  test('a prerelease Node counts as its version', () => {
    expect(wantsGuiNode(['>=22.12.0'], '25.0.0-pre', '24.21.0')).toBe(false)
  })

  test('names the oldest version every range allows', () => {
    expect(oldestAllowed([VITE])).toBe('20.19.0')
    expect(oldestAllowed(['>=18', '>=22.12'])).toBe('22.12.0')
    expect(oldestAllowed(['<10', '>=20'])).toBeNull()
  })
})

describe('the Node.js the project would run', () => {
  test('reads the version after anything a profile printed', () => {
    expect(parseNodeVersion('v18.20.8\n')).toBe('18.20.8')
    expect(parseNodeVersion('Welcome v1.2.3 shell\nv22.12.0\n')).toBe('22.12.0')
    expect(parseNodeVersion('zsh: command not found: node')).toBeNull()
  })

  test('asks the login shell, in the project folder', async () => {
    // A stand-in shell (a real login shell reads this Mac's profile) and a `node` that answers
    // with what the folder it runs in says.
    const root = await scratch({
      'bin/shell': '#!/bin/sh\n[ "$1" = -lc ] || exit 9\nexec /bin/sh -c "$2"\n',
      'bin/node': '#!/bin/sh\necho "v$(cat .version)"\n',
      'app/.version': '18.20.8\n',
    })
    try {
      await chmod(join(root, 'bin/shell'), 0o755)
      await chmod(join(root, 'bin/node'), 0o755)
      const shell = join(root, 'bin/shell')
      const env = { SHELL: shell, PATH: `${join(root, 'bin')}:/usr/bin:/bin` }
      expect(await nodeVersionIn(join(root, 'app'), env)).toBe('18.20.8')
      expect(await nodeVersionIn(join(root, 'app'), { ...env, PATH: '/usr/bin:/bin' })).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("Gui's bin goes first after the profile, through the env, and only when chosen", async () => {
    expect(withPathFirst('npm run dev', null)).toBe('npm run dev')
    const line = withPathFirst('npm run dev', '/x')
    expect(line).toBe('export PATH="$GUI_PATH_FIRST:$PATH"; npm run dev')
    const { execFileSync } = await import('../src/main/process')
    const out = execFileSync('/bin/sh', ['-c', withPathFirst('echo "$PATH"', 'set')], {
      env: { PATH: '/usr/bin:/bin', GUI_PATH_FIRST: "/it's here" },
    })
    expect(String(out).trim()).toBe("/it's here:/usr/bin:/bin")
  })
})
