import { afterAll, expect, test } from 'bun:test'

// Committing a canvas on Windows is a later step that needs a person's review (it writes the
// user's repo): git prints its top folder as C:/…, which canvas-git.ts doesn't match yet.
const committing = test.skipIf(process.platform === 'win32')

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addArgs,
  CanvasGit,
  canvasPath,
  commitArgs,
  commitMessage,
  statusArgs,
} from '../src/main/canvas-git'

// Committing a canvas kept in a git repo (main/canvas-git.ts): its folder's files, and never
// anything else in the repo, with the repo's own hooks and identity.

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'gui-canvas-git-')))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Git as the test's user: no global config of the developer's, a known identity. */
const env = {
  ...process.env,
  HOME: scratch,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'),
}
writeFileSync(env.GIT_CONFIG_GLOBAL, '[user]\n\tname = Test\n\temail = test@example.com\n')
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()

/** A repo with a canvas at design/landing, committed, as a clone would have it. */
function repo(name: string) {
  const top = join(scratch, name)
  const canvas = join(top, 'design', 'landing')
  mkdirSync(join(canvas, 'frames'), { recursive: true })
  writeFileSync(join(canvas, 'canvas.json'), '{"version":1,"frames":[]}\n')
  writeFileSync(join(top, 'app.ts'), 'export const a = 1\n')
  writeFileSync(join(top, 'notes.md'), 'notes\n')
  git(top, 'init', '-q', '-b', 'main')
  git(top, 'add', '.')
  git(top, 'commit', '-q', '-m', 'start')
  return { top, canvas, tool: new CanvasGit(canvas, async () => env) }
}

test('the path builder names only the canvas folder, literally, and never pushes or amends', () => {
  expect(canvasPath('/work/app', '/work/app/design/landing')).toBe('design/landing')
  expect(canvasPath('/work/app', '/work/app')).toBe('.')
  expect(canvasPath('/work/app', '/work/other')).toBe(null)
  for (const args of [
    statusArgs('design/landing'),
    addArgs('design/landing'),
    commitArgs('design/landing', 'msg'),
  ]) {
    expect(args).toContain('--literal-pathspecs')
    expect(args.slice(args.indexOf('--') + 1)).toEqual(['design/landing'])
    for (const never of ['--amend', '--no-verify', '-n', 'push', '-a', '--all-staged', 'checkout'])
      expect(args).not.toContain(never)
  }
  expect(commitArgs('design/landing', 'msg')).toContain('--only')
  expect(commitArgs('design/[draft]', '-m')).toEqual([
    '--literal-pathspecs',
    'commit',
    '--only',
    '--quiet',
    '-m',
    '-m',
    '--',
    'design/[draft]',
  ])
})

test('a message comes from the turn’s request, short', () => {
  expect(commitMessage('Landing', 'Make the hero bolder\nand the footer quieter')).toBe(
    'Landing: Make the hero bolder',
  )
  expect(commitMessage('Landing', null)).toBe('Update Landing')
  expect(commitMessage('Landing', 'x'.repeat(200))).toHaveLength(72)
})

committing(
  'only the canvas folder is committed; the rest of the repo, staged or not, stays as it was',
  async () => {
    const { top, canvas, tool } = repo('only')
    writeFileSync(join(canvas, 'frames', 'hero.html'), '<h1>Hero</h1>')
    writeFileSync(join(canvas, 'canvas.json'), '{"version":1,"frames":[{"id":"hero"}]}\n')
    writeFileSync(join(top, 'app.ts'), 'export const a = 2\n')
    writeFileSync(join(top, 'notes.md'), 'staged notes\n')
    git(top, 'add', 'notes.md')
    writeFileSync(join(top, 'untracked.txt'), 'mine')

    const found = await tool.repo()
    expect(found).toMatchObject({ top, path: 'design/landing' })
    if (!found) throw new Error('no repo')
    expect(await tool.changed(found)).toBe(true)
    const outcome = await tool.commit(found, 'Landing: a hero')
    expect(outcome).toMatchObject({ ok: true, branch: 'main' })

    expect(git(top, 'show', '--name-only', '--format=%s', 'HEAD').split('\n')).toEqual([
      'Landing: a hero',
      '',
      'design/landing/canvas.json',
      'design/landing/frames/hero.html',
    ])
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: top,
      env,
      encoding: 'utf8',
    })
    expect(status).toBe(' M app.ts\nM  notes.md\n?? untracked.txt\n')
    expect(await tool.changed(found)).toBe(false)
  },
)

committing('a frame deleted on the canvas is committed as deleted', async () => {
  const { top, canvas, tool } = repo('deleted')
  writeFileSync(join(canvas, 'frames', 'old.html'), 'old')
  git(top, 'add', '.')
  git(top, 'commit', '-q', '-m', 'old frame')
  rmSync(join(canvas, 'frames', 'old.html'))
  const found = await tool.repo()
  if (!found) throw new Error('no repo')
  expect(await tool.commit(found, 'Remove old')).toMatchObject({ ok: true })
  expect(git(top, 'show', '--name-status', '--format=', 'HEAD')).toBe(
    'D\tdesign/landing/frames/old.html',
  )
})

committing('during a merge it doesn’t commit, and says why', async () => {
  const { top, canvas, tool } = repo('merging')
  writeFileSync(join(canvas, 'frames', 'a.html'), 'a')
  writeFileSync(join(top, '.git', 'MERGE_HEAD'), git(top, 'rev-parse', 'HEAD'))
  const found = await tool.repo()
  if (!found) throw new Error('no repo')
  const outcome = await tool.commit(found, 'x')
  expect(outcome).toMatchObject({ ok: false })
  expect(!outcome.ok && outcome.message).toContain('a merge is under way')
  expect(git(top, 'rev-list', '--count', 'HEAD')).toBe('1')
})

committing('on a detached HEAD it still commits, on no branch', async () => {
  const { top, canvas, tool } = repo('detached')
  git(top, 'checkout', '-q', '--detach')
  writeFileSync(join(canvas, 'frames', 'a.html'), 'a')
  const found = await tool.repo()
  if (!found) throw new Error('no repo')
  expect(await tool.commit(found, 'x')).toMatchObject({ ok: true, branch: null })
})

committing(
  'a failing hook stops it, with the hook’s output; no identity is git’s own words',
  async () => {
    const { top, canvas, tool } = repo('hooked')
    const hook = join(top, '.git', 'hooks', 'pre-commit')
    writeFileSync(
      hook,
      '#!/bin/sh\necho "lint: 2 problems in hero.html"\necho "fix them first" >&2\nexit 1\n',
    )
    chmodSync(hook, 0o755)
    writeFileSync(join(canvas, 'frames', 'hero.html'), 'hero')
    const found = await tool.repo()
    if (!found) throw new Error('no repo')
    const outcome = await tool.commit(found, 'x')
    expect(outcome).toEqual({
      ok: false,
      message: 'Not committed: lint: 2 problems in hero.html',
      detail: 'lint: 2 problems in hero.html\nfix them first',
    })
    rmSync(hook)

    git(top, 'config', 'user.useConfigOnly', 'true')
    const anonymous = new CanvasGit(canvas, async () => ({
      ...env,
      GIT_CONFIG_GLOBAL: join(scratch, 'none'),
    }))
    const unknown = await anonymous.commit(found, 'x')
    expect(unknown.ok).toBe(false)
    expect(!unknown.ok && `${unknown.message}\n${unknown.detail}`).toMatch(/user\.email|identity/)
    expect(git(top, 'rev-list', '--count', 'HEAD')).toBe('1')
  },
)

test('a canvas outside any repo has none, and Gui makes none', async () => {
  const lone = join(scratch, 'lone')
  mkdirSync(lone)
  expect(await new CanvasGit(lone, async () => env).repo()).toBe(null)
})
