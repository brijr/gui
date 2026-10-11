import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { ShipInfo, ShipRequest } from '../src/shared/types'
import { waitFor } from './helpers/env'
import { git } from './helpers/fixtures'
import { chooseFromChatMenu } from './helpers/menus'
import { expect, test } from './helpers/test'

const MARKER = '// Shipped from Gui e2e'
const SECRET = 'VITE_API_TOKEN=do-not-commit'

test('retrying a failed push keeps excluded edits out of the saved commit', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  const { base, root } = session.fixture
  git(root, 'branch', '-M', 'main')
  git(root, 'config', 'user.name', 'Gui E2E')
  git(root, 'config', 'user.email', 'e2e@example.com')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.hooksPath', '/dev/null')
  const origin = join(base, 'origin.git')
  git(base, 'init', '--quiet', '--bare', origin)
  git(root, 'remote', 'add', 'origin', origin)
  git(root, 'push', '--quiet', '-u', 'origin', 'main')
  git(root, 'remote', 'set-head', 'origin', 'main')
  git(root, 'remote', 'set-url', 'origin', join(base, 'unavailable.git'))
  appendFileSync(join(root, 'src/App.tsx'), `${MARKER}\n`)
  appendFileSync(join(root, 'src/index.css'), '\n/* Exclude this edit */\n')
  git(root, 'add', 'src/index.css')
  await waitFor(() => session.chat.evaluate(getShipInfo), 'ship info')

  await chooseFromChatMenu(session.app, session.chat, 'Source Control…')
  await session.chat.getByRole('checkbox', { name: 'Include src/index.css' }).dispatchEvent('click')
  await session.chat
    .getByRole('button', { name: 'Commit and push', exact: true })
    .dispatchEvent('click')
  await expect(session.chat.getByRole('alert')).toBeVisible()
  await expect(session.chat.getByRole('button', { name: 'Push', exact: true })).toBeEnabled()
  await expect(
    session.chat.getByRole('checkbox', { name: 'Include src/index.css' }),
  ).not.toBeChecked()
  const saved = git(root, 'rev-parse', 'HEAD').trim()
  const branch = git(root, 'symbolic-ref', '--short', 'HEAD').trim()
  expect(git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').trim()).toBe(
    'src/App.tsx',
  )

  git(root, 'remote', 'set-url', 'origin', origin)
  await session.chat.getByRole('button', { name: 'Push', exact: true }).dispatchEvent('click')
  await expect(session.chat.getByText('Pushed', { exact: true })).toBeVisible()
  expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(saved)
  expect(git(origin, 'rev-parse', branch).trim()).toBe(saved)
  expect(git(root, 'diff', '--cached', '--name-only').trim()).toBe('src/index.css')
})

test('source control saves selected files locally, then shares the saved commit', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const { base, root } = session.fixture
  git(root, 'branch', '-M', 'main')
  git(root, 'config', 'user.name', 'Gui E2E')
  git(root, 'config', 'user.email', 'e2e@example.com')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.hooksPath', '/dev/null')
  const origin = join(base, 'origin.git')
  git(base, 'init', '--quiet', '--bare', origin)
  git(root, 'remote', 'add', 'origin', origin)
  git(root, 'push', '--quiet', '-u', 'origin', 'main')
  git(root, 'remote', 'set-head', 'origin', 'main')
  const before = git(root, 'rev-parse', 'HEAD').trim()

  appendFileSync(join(root, 'src/App.tsx'), `${MARKER}\n`)
  appendFileSync(join(root, 'src/index.css'), '\n/* Keep this edit for later */\n')
  // An excluded file must remain staged, even though the commit reads the working tree.
  git(root, 'add', 'src/index.css')

  const info = await waitFor(() => session.chat.evaluate(getShipInfo), 'ship info')
  await chooseFromChatMenu(session.app, session.chat, 'Source Control…')
  await expect(session.chat.getByRole('checkbox', { name: 'Include src/App.tsx' })).toBeChecked()
  await session.chat.getByRole('radio', { name: /^Save a commit/ }).dispatchEvent('click')
  await session.chat.getByRole('checkbox', { name: 'Include src/index.css' }).dispatchEvent('click')
  await session.chat.getByRole('textbox', { name: 'Commit message' }).fill('Save only the app edit')
  await session.chat
    .getByRole('button', { name: 'Save commit', exact: true })
    .dispatchEvent('click')
  await expect(session.chat.getByText('Commit saved', { exact: true })).toBeVisible()

  const branch = info.suggestion.branch
  const saved = git(root, 'rev-parse', 'HEAD').trim()
  expect(saved).not.toBe(before)
  expect(git(root, 'symbolic-ref', '--short', 'HEAD').trim()).toBe(branch)
  expect(git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').trim()).toBe(
    'src/App.tsx',
  )
  expect(git(root, 'diff', '--cached', '--name-only').trim()).toBe('src/index.css')
  expect(git(origin, 'for-each-ref', '--format=%(refname)', `refs/heads/${branch}`).trim()).toBe('')
  expect(git(origin, 'rev-parse', 'main').trim()).toBe(before)

  expect((await session.chat.evaluate(() => window.gui.getProposal(false)))?.ahead).toBe(1)
  // Share just the saved commit while the excluded file remains staged.
  await session.chat.getByRole('button', { name: 'Back to chat' }).first().dispatchEvent('click')
  await chooseFromChatMenu(session.app, session.chat, 'Source Control…')
  await session.chat.getByRole('button', { name: 'Clear selection' }).dispatchEvent('click')
  await expect(
    session.chat.getByText('Only saved commits will be pushed. Unselected edits stay here.'),
  ).toBeVisible()
  await session.chat.getByRole('button', { name: 'Push', exact: true }).dispatchEvent('click')
  await expect(session.chat.getByText('Pushed', { exact: true })).toBeVisible()
  expect(git(origin, 'rev-parse', branch).trim()).toBe(saved)
  expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(saved)
  expect(git(root, 'diff', '--cached', '--name-only').trim()).toBe('src/index.css')

  // Explicit empty or stale selections must fail before changing branches or the index.
  appendFileSync(join(root, 'src/App.tsx'), `${MARKER} again\n`)
  for (const files of [[], ['missing.tsx']]) {
    await expect(
      session.chat.evaluate(shipChanges, {
        ...info.suggestion,
        branch: 'should-not-exist',
        mode: 'commit',
        files,
      }),
    ).rejects.toThrow()
    expect(git(root, 'symbolic-ref', '--short', 'HEAD').trim()).toBe(branch)
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(saved)
  }
})

/** Runs in the chat page. */
function getShipInfo() {
  return window.gui.getShipInfo()
}

/** Runs in the chat page. */
function shipChanges(request: ShipRequest) {
  return window.gui.ship(request)
}

/** Files at `ref` in a repository (bare or not). */
function treeOf(repo: string, ref: string): string[] {
  return git(repo, 'ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean)
}

// "Create pull request" runs git in the user's real repository. A local bare repo stands in
// for GitHub so nothing touches the network; it isn't a host Gui can link, so the outcome
// is a push without a pull request page. No agent turn runs, so no usage is spent.
test('create pull request commits to a new branch, pushes it, and leaves secrets out', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const { base, root } = session.fixture

  // The fixture ignores *.local; track it so leaving .env.local out is up to the app.
  const gitignore = readFileSync(join(root, '.gitignore'), 'utf8')
  writeFileSync(join(root, '.gitignore'), gitignore.replace(/^\*\.local\n/m, ''))
  git(root, 'branch', '-M', 'main')
  git(root, 'commit', '--quiet', '-am', 'track .local files')
  // The app commits with the repository's own identity and hooks; pin both for the test.
  git(root, 'config', 'user.name', 'Gui E2E')
  git(root, 'config', 'user.email', 'e2e@example.com')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.hooksPath', '/dev/null')

  const origin = join(base, 'origin.git')
  git(base, 'init', '--quiet', '--bare', origin)
  git(root, 'remote', 'add', 'origin', origin)
  git(root, 'push', '--quiet', '-u', 'origin', 'main')
  git(root, 'remote', 'set-head', 'origin', 'main')
  const mainBefore = git(origin, 'rev-parse', 'main').trim()

  // What the agent would have done, plus a secret it must never share.
  appendFileSync(join(root, 'src/App.tsx'), `${MARKER}\n`)
  writeFileSync(join(root, '.env.local'), `${SECRET}\n`)

  // Null until the project's chat is set up.
  const info = await waitFor(() => session.chat.evaluate(getShipInfo), 'ship info', {
    timeout: 60_000,
  })
  expect(info.blocked).toBeNull()
  expect(info.branch).toBe('main')
  expect(info.onDefaultBranch).toBe(true)
  expect(info.files).toContainEqual({ path: 'src/App.tsx', status: 'modified' })
  expect(info.files.map((file) => file.path)).not.toContain('.env.local')
  expect(info.skipped).toContain('.env.local')
  expect(info.remote?.host).toBe('other')
  expect(info.suggestion.branch).toMatch(/^gui\/[a-z0-9-]+$/)
  expect(info.suggestion.title).not.toBe('')

  await checkSheet(session.app, session.chat, info)

  // Pushed: committed on a new branch that now exists on the remote too.
  const request: ShipRequest = { ...info.suggestion, title: 'Mark the fixture as shipped' }
  const pushed = await session.chat.evaluate(shipChanges, request)
  expect(pushed.outcome).toBe('pushed')
  expect(pushed.url).toBeNull()
  expect(pushed.branch).toBe(info.suggestion.branch)

  const remoteHead = git(origin, 'rev-parse', '--verify', `refs/heads/${pushed.branch}`).trim()
  expect(remoteHead.startsWith(pushed.commit)).toBe(true)
  expect(git(origin, 'log', '-1', '--format=%s', pushed.branch).trim()).toBe(request.title)
  expect(git(origin, 'show', `${pushed.branch}:src/App.tsx`)).toContain(MARKER)
  expect(treeOf(origin, pushed.branch)).not.toContain('.env.local')
  expect(git(origin, 'rev-parse', 'main').trim()).toBe(mainBefore)

  // Locally: on the new branch, the secret still on disk and still untracked.
  expect(git(root, 'symbolic-ref', '--short', 'HEAD').trim()).toBe(pushed.branch)
  expect(git(root, 'status', '--porcelain', '--', '.env.local').trim()).toBe('?? .env.local')
  expect(readFileSync(join(root, '.env.local'), 'utf8')).toContain(SECRET)

  const after = await session.chat.evaluate(getShipInfo)
  expect(after?.blocked).toBe('No changes to share yet.')

  // Committed: without a remote the commit stays local, on the branch it's already on.
  git(root, 'remote', 'remove', 'origin')
  appendFileSync(join(root, 'src/App.tsx'), `${MARKER} again\n`)
  const local = await session.chat.evaluate(getShipInfo)
  expect(local?.blocked).toBeNull()
  expect(local?.remote).toBeNull()
  expect(local?.suggestion.branch).toBe(pushed.branch)
  if (!local) throw new Error('No ship info')

  const committed = await session.chat.evaluate(shipChanges, local.suggestion)
  expect(committed.outcome).toBe('committed')
  expect(committed.url).toBeNull()
  expect(committed.branch).toBe(pushed.branch)
  expect(git(root, 'rev-parse', 'HEAD').trim().startsWith(committed.commit)).toBe(true)
  expect(git(root, 'show', 'HEAD:src/App.tsx')).toContain(`${MARKER} again`)
  expect(treeOf(root, 'HEAD')).not.toContain('.env.local')
  expect(git(root, 'rev-parse', 'main').trim()).toBe(mainBefore)
  expect(existsSync(join(root, '.env.local'))).toBe(true)
})

/**
 * The chat header's More menu opens the sheet, prefilled from the same suggestion. Soft: the
 * git assertions above and below are what this test is for.
 */
async function checkSheet(app: ElectronApplication, chat: Page, info: ShipInfo) {
  await chooseFromChatMenu(app, chat, 'Source Control…')
  await expect.soft(chat.getByRole('textbox', { name: 'Title' })).toHaveValue(info.suggestion.title)
  // A remote Gui can't link: no pull request page, so the action is a plain push.
  await expect.soft(chat.getByRole('button', { name: 'Commit and push' })).toHaveCount(1)
  const back = chat.getByRole('button', { name: 'Back to chat' })
  if ((await back.count()) > 0) await back.first().dispatchEvent('click')
  await expect.soft(chat.getByRole('textbox', { name: 'Title' })).toHaveCount(0)
}
