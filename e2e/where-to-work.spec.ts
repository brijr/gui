import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { waitFor } from './helpers/env'
import { git } from './helpers/fixtures'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// Opening a project on main asks where to work, in place of the start screen's open buttons:
// on main, or on a new branch named from the first message.
// The fixture is a fresh repository on its main branch, already trusted.

function onMain(root: string) {
  git(root, 'branch', '-M', 'main')
}

async function asked(session: GuiSession) {
  await expect(
    session.chrome.getByRole('heading', { name: 'Where do you want to work?' }),
  ).toBeVisible()
  expect((await session.state()).project).toBeNull()
}

async function opened(session: GuiSession, root: string) {
  return waitFor(async () => {
    const state = await session.state()
    return state.project?.root === root ? state : null
  }, `${root} to open`)
}

test('opening on main asks where to work, and On main opens it as it is', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', askWhereToWork: true, open: 'recent' })
  const { root } = session.fixture
  onMain(root)
  await session.chrome.evaluate((root) => window.gui.openRecent(root), root)
  await asked(session)
  await session.shot('where-to-work')
  await session.chrome.getByRole('button', { name: /^On main/ }).click()
  const state = await opened(session, root)
  expect(state.whereToWork).toBeNull()
  expect(git(root, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main')
})

test('Cancel leaves the start screen as it was', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', askWhereToWork: true, open: 'recent' })
  const { root } = session.fixture
  onMain(root)
  await session.chrome.evaluate((root) => window.gui.openRecent(root), root)
  await asked(session)
  await session.chrome.getByRole('button', { name: 'Cancel' }).click()
  await waitFor(async () => (await session.state()).whereToWork === null, 'the question to close')
  expect((await session.state()).project).toBeNull()
  await expect(session.chrome.getByRole('button', { name: 'Open project…' })).toBeVisible()
})

test('Always open on main is remembered, and the project opens', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', askWhereToWork: true, open: 'recent' })
  const { root, userData } = session.fixture
  onMain(root)
  await session.chrome.evaluate((root) => window.gui.openRecent(root), root)
  await asked(session)
  await session.chrome.getByRole('button', { name: /Always open .* on main/ }).click()
  await opened(session, root)
  await waitFor(() => {
    const prefs = JSON.parse(readFileSync(join(userData, 'prefs.json'), 'utf8'))
    return prefs.defaultBranchRoots?.includes(realpathSync(root))
  }, 'the choice to be saved')
})

test('On a new branch names the branch from the first message, without asking', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', askWhereToWork: true, open: 'recent' })
  const { root } = session.fixture
  onMain(root)
  await session.chrome.evaluate((root) => window.gui.openRecent(root), root)
  await asked(session)
  await session.chrome.getByRole('button', { name: /^On a new branch/ }).click()
  await opened(session, root)
  expect(git(root, 'symbolic-ref', '--short', 'HEAD').trim()).toBe('main')
  // Sent whether or not an agent takes it: the branch comes first.
  await session.chat.evaluate(() => window.gui.send('Make the header sticky please'))
  await waitFor(
    () => git(root, 'symbolic-ref', '--short', 'HEAD').trim() === 'gui/make-the-header-sticky',
    'the new branch',
  )
})
