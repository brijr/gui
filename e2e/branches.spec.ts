import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { waitFor } from './helpers/env'
import { git } from './helpers/fixtures'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// Opening a project on main opens it straight away, and keeps main as it was: the first
// message starts a new branch, unless the user stays on main. The bar over the chat then has
// one button that commits, pushes and creates the pull request. Worktrees come from the
// toolbar's branch menu. The fixture is a fresh repository, already trusted.

function onMain(root: string) {
  git(root, 'branch', '-M', 'main')
}

async function openOnMain(session: GuiSession) {
  const { root } = session.fixture
  onMain(root)
  await session.chrome.evaluate((root) => window.gui.openRecent(root), root)
  return opened(session, root)
}

async function opened(session: GuiSession, root: string) {
  return waitFor(async () => {
    const state = await session.state()
    return state.project?.root === root ? state : null
  }, `${root} to open`)
}

/** The chat page that isn't `known`: the new tab's a worktree opens in. */
async function newChatPage(session: GuiSession, known: Page) {
  const find = () =>
    session.app
      .context()
      .pages()
      .find((page) => page.url().endsWith('/chat.html') && page !== known)
  const page = await waitFor(find, "the new tab's chat")
  await page.waitForFunction(() => 'gui' in window)
  return page
}

/** Answers the next native question with its button numbered `response`. */
async function answerDialogs(session: GuiSession, response: number) {
  await session.app.evaluate(({ dialog }, response) => {
    dialog.showMessageBox = (async () => ({ response, checkboxChecked: false })) as never
  }, response)
}

const NEW_BRANCH =
  /Your first message starts a separate version of this project, called a Git branch\. main stays unchanged/

test('opening on main opens straight away, and the first message starts a new branch', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', newBranchOnSend: true, open: 'recent' })
  const { root } = session.fixture
  const state = await openOnMain(session)
  expect(state.branch).toEqual({ branch: 'main', worktree: null })
  await expect(session.chat.getByText(NEW_BRANCH)).toBeVisible()
  await session.shot('opened-on-main')
  expect(git(root, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main')

  // Sent whether or not an agent takes it: the branch comes first.
  await session.chat.evaluate(() => window.gui.send('Make the header sticky please'))
  await waitFor(
    () => git(root, 'symbolic-ref', '--short', 'HEAD').trim() === 'gui/make-the-header-sticky',
    'the new branch',
  )
  await waitFor(
    async () => (await session.state()).branch?.branch === 'gui/make-the-header-sticky',
    'the toolbar to show it',
  )
  await expect(session.chat.getByText(NEW_BRANCH)).toHaveCount(0)
  await expect(
    session.chrome.getByRole('button', { name: 'Branch gui/make-the-header-sticky' }),
  ).toBeVisible()
})

test('Stay on main keeps the work on main, and is remembered for the project', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', newBranchOnSend: true, open: 'recent' })
  const { root, userData } = session.fixture
  await openOnMain(session)
  await session.chat.getByRole('button', { name: 'Stay on main' }).click()
  await expect(session.chat.getByText(NEW_BRANCH)).toHaveCount(0)
  await waitFor(() => {
    const prefs = JSON.parse(readFileSync(join(userData, 'prefs.json'), 'utf8'))
    return prefs.defaultBranchRoots?.includes(realpathSync(root))
  }, 'the choice to be saved')

  await session.chat.evaluate(() => window.gui.send('Make the header sticky'))
  // A branch would have been made before the message went in.
  await waitFor(async () => (await session.chatSnapshot()).turns.length > 0, 'the message')
  expect(git(root, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main')
})

test('the bar’s one button commits every change, pushes it on a new branch, and leaves secrets out', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { base, root } = session.fixture

  // The app commits with the repository's own identity and hooks; pin both for the test.
  git(root, 'config', 'user.name', 'Gui E2E')
  git(root, 'config', 'user.email', 'e2e@example.com')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.hooksPath', '/dev/null')
  onMain(root)
  const origin = join(base, 'origin.git')
  git(base, 'init', '--quiet', '--bare', origin)
  git(root, 'remote', 'add', 'origin', origin)
  git(root, 'push', '--quiet', '-u', 'origin', 'main')
  git(root, 'remote', 'set-head', 'origin', 'main')
  const mainBefore = git(origin, 'rev-parse', 'main').trim()
  await openOnMain(session)

  // What the agent would have done, plus a secret it must never share.
  appendFileSync(join(root, 'src/App.tsx'), '// shared from the bar\n')
  writeFileSync(join(root, '.env'), 'API_KEY=sk-live-do-not-share\n')
  await session.chat.evaluate(() => window.dispatchEvent(new Event('focus')))

  // A remote Gui can't open pull requests on: the button commits and pushes.
  const button = session.chat.getByRole('button', { name: 'Commit and push' })
  await expect(button).toBeVisible({ timeout: 30_000 })
  await expect(session.chat.getByText(/1 uncommitted change on main/)).toBeVisible()
  await session.shot('ready-to-share')
  await button.click()

  const branch = await waitFor(() => {
    const now = git(root, 'symbolic-ref', '--short', 'HEAD').trim()
    return now !== 'main' ? now : null
  }, 'a new branch')
  expect(branch).toMatch(/^gui\/[a-z0-9-]+$/)
  await waitFor(
    () => git(origin, 'branch', '--list', branch).includes(branch),
    'the branch to be pushed',
  )
  expect(git(origin, 'show', `${branch}:src/App.tsx`)).toContain('shared from the bar')
  expect(git(origin, 'ls-tree', '-r', '--name-only', branch)).not.toContain('.env')
  expect(git(origin, 'rev-parse', 'main').trim()).toBe(mainBefore)
  expect(git(root, 'status', '--porcelain', '--', '.env').trim()).toBe('?? .env')
  // Nothing left to share: the bar goes quiet.
  await expect(button).toHaveCount(0)
  await session.shot('shared')
})

test('a new worktree opens beside main, and removing it never loses work', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { root, base } = session.fixture
  writeFileSync(join(root, 'uncommitted.txt'), 'stays on main\n')
  await openOnMain(session)
  await session.chat.evaluate(() => window.gui.createWorktree('Pricing page'))

  const folder = join(realpathSync(base), 'worktrees', 'fixture-vite', 'pricing-page')
  const state = await opened(session, folder)
  expect(state.branch).toEqual({
    branch: 'gui/pricing-page',
    worktree: { of: 'fixture-vite', name: 'pricing-page' },
  })
  expect(git(folder, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('gui/pricing-page')
  expect(existsSync(join(folder, 'uncommitted.txt'))).toBe(false)
  expect(existsSync(join(root, 'uncommitted.txt'))).toBe(true)
  // It opens in a tab of its own, with its own chat.
  const chat = await newChatPage(session, session.chat)

  // Uncommitted work blocks removal, before any question.
  writeFileSync(join(folder, 'draft.txt'), 'not committed\n')
  await expect(chat.evaluate(() => window.gui.removeWorktree())).rejects.toThrow(
    /pricing-page has 1 uncommitted change/,
  )
  expect(existsSync(join(folder, 'draft.txt'))).toBe(true)

  // Committed, it goes once confirmed; the branch and its commit stay.
  git(folder, 'add', 'draft.txt')
  git(folder, 'commit', '--quiet', '-m', 'Draft')
  const commit = git(folder, 'rev-parse', 'HEAD').trim()
  await answerDialogs(session, 0)
  await chat.evaluate(() => window.gui.removeWorktree())
  await waitFor(() => !existsSync(folder), 'the worktree folder to go')
  expect(git(root, 'rev-parse', 'gui/pricing-page').trim()).toBe(commit)
})

test('a worktree deleted outside Gui shows as missing and can be cleared', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { root, base } = session.fixture
  await openOnMain(session)
  await session.chat.evaluate(() => window.gui.createWorktree('Gone soon'))
  const folder = join(realpathSync(base), 'worktrees', 'fixture-vite', 'gone-soon')
  await opened(session, folder)
  await session.chrome.evaluate(() => window.gui.newTab())
  git(root, 'worktree', 'remove', '--force', folder)
  // A fresh start screen reads the recents again.
  await session.chrome.evaluate(() => window.gui.newTab())
  await expect(session.chrome.getByText('Folder missing')).toBeVisible()

  await answerDialogs(session, 0)
  await session.chrome.evaluate((folder) => window.gui.openRecent(folder), folder)
  await waitFor(
    async () => !((await session.state()).recent ?? []).some((p) => p.root === folder),
    'the missing worktree to leave recents',
  )
  expect(git(root, 'branch', '--list', 'gui/gone-soon')).toContain('gui/gone-soon')
})
