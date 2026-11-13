import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chooseFromChatMenu } from './helpers/menus'
import { expect, test } from './helpers/test'

/** Writes a project's own chat, as Gui saves it, with a turn for each prompt. */
function seedChat(userData: string, root: string, prompts: string[]) {
  const name = createHash('sha1').update(realpathSync(root)).digest('hex').slice(0, 16)
  const chats = join(userData, 'chats')
  mkdirSync(chats, { recursive: true })
  const now = Date.now()
  writeFileSync(
    join(chats, `${name}.json`),
    JSON.stringify({
      version: 1,
      agentId: 'claude',
      sessionId: null,
      turns: prompts.map((prompt, index) => ({
        id: `t${index}`,
        index,
        prompt,
        context: [],
        items: [],
        status: 'done',
        error: null,
        startedAt: now - (prompts.length - index) * 3600_000,
        endedAt: now - (prompts.length - index) * 3600_000 + 1000,
        changes: [],
      })),
      checkpoints: {},
      redo: null,
    }),
  )
  return join(chats, name)
}

// New chat and switching agents used to erase the transcript; now both archive it, and the
// archive lists, reopens, renames and deletes chats.
test('new chat and agent switches archive the chat, which can be reopened', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { root, userData } = session.fixture
  seedChat(userData, root, ['Make the header sticky', 'Use a softer blue for the buttons'])
  await session.chrome.evaluate((at) => window.gui.openRecent(at), root)
  await expect.poll(async () => (await session.chatSnapshot()).turns.length).toBe(2)

  const list = () => session.chat.evaluate(() => window.gui.listChats())

  // New chat: an empty transcript, and the old one archived and offered back.
  await session.chat.evaluate(() => window.gui.newSession())
  await expect.poll(async () => (await session.chatSnapshot()).turns.length).toBe(0)
  const { meta } = await session.chatSnapshot()
  expect(meta.archived?.agentName).toBe('Claude Code')
  const [archived] = await list()
  expect(archived).toMatchObject({ prompt: 'Make the header sticky', turns: 2, agentId: 'claude' })
  await expect(session.chat.getByText('Your chat with Claude Code is archived.')).toBeVisible()

  // The list from the header's More menu: rename, then reopen it from there.
  await chooseFromChatMenu(session.app, session.chat, 'Archived Chats')
  const dialog = session.chat.getByRole('dialog', { name: 'Archived chats' })
  await expect(dialog.getByText('Make the header sticky')).toBeVisible()
  await session.shot('chat-archive-list', true)
  await session.chat.evaluate((id) => window.gui.renameChat(id, 'Header work'), archived.id)
  expect((await list())[0]?.title).toBe('Header work')
  await session.chat.keyboard.press('Escape')
  await chooseFromChatMenu(session.app, session.chat, 'Archived Chats')
  await dialog.getByRole('button', { name: /^Header work/ }).click()
  await expect.poll(async () => (await session.chatSnapshot()).turns.length).toBe(2)
  // It's the open chat again, and the empty one wasn't worth archiving.
  expect(await list()).toEqual([])

  // A started chat keeps its agent; another one starts a new chat, and this one is archived
  // under the agent it was with.
  await session.chrome.evaluate(() => window.gui.setAgent('codex'))
  await session.chat.evaluate(() => window.gui.newSession('codex'))
  await expect.poll(async () => (await session.chatSnapshot()).turns.length).toBe(0)
  expect((await session.chatSnapshot()).meta.agentId).toBe('codex')
  const [switched] = await list()
  expect(switched).toMatchObject({ agentId: 'claude', title: 'Header work' })

  // Reopening it brings its agent back too.
  await session.chat.evaluate((id) => window.gui.openChat(id), switched.id)
  await expect.poll(async () => (await session.chatSnapshot()).meta.agentId).toBe('claude')
  expect((await session.chatSnapshot()).turns).toHaveLength(2)

  // Deleting is for good.
  await session.chat.evaluate(() => window.gui.newSession())
  await expect.poll(async () => (await list()).length).toBe(1)
  const [last] = await list()
  await session.chat.evaluate((id) => window.gui.deleteChat(id), last.id)
  expect(await list()).toEqual([])
})

// The start screen's recent chats archive instead of disappearing.
test('a recent chat archives from the start screen', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { root, userData } = session.fixture
  const folder = seedChat(userData, root, ['Make the header sticky'])
  // A new tab reads the recent list, and the chats with it, afresh.
  await session.chrome.evaluate(() => window.gui.newTab())
  await session.chrome.getByRole('button', { name: 'Archive chat: Make the header sticky' }).click()
  await expect(session.chrome.getByRole('heading', { name: 'Recent chats' })).toBeHidden()
  await expect(session.chrome.getByRole('heading', { name: 'Recent' })).toBeVisible()
  expect(existsSync(`${folder}.json`)).toBe(false)
  expect(existsSync(`${folder}.summary.json`)).toBe(false)
  expect(readdirSync(folder).filter((name) => name !== 'index.json')).toHaveLength(1)
})

test('archive mounts one page and filters across every archived chat', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { root, userData } = session.fixture
  const folder = seedChat(userData, root, ['Current chat'])
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    join(folder, 'index.json'),
    JSON.stringify(
      Array.from({ length: 120 }, (_, index) => ({
        id: index.toString(16).padStart(36, '0'),
        title: null,
        prompt: `Archived request ${index}`,
        agentId: 'claude',
        turns: 1,
        startedAt: Date.now() - index,
        lastAt: Date.now() - index,
      })),
    ),
  )
  await session.chrome.evaluate((at) => window.gui.openRecent(at), root)
  await expect.poll(async () => (await session.chatSnapshot()).turns.length).toBe(1)
  await chooseFromChatMenu(session.app, session.chat, 'Archived Chats')
  const dialog = session.chat.getByRole('dialog', { name: 'Archived chats' })
  await expect(dialog.getByRole('listitem')).toHaveCount(51)
  await dialog.getByRole('button', { name: 'Show more', exact: true }).click()
  await expect(dialog.getByRole('listitem')).toHaveCount(101)
  await dialog.getByLabel('Filter archived chats').fill('request 119')
  await expect(dialog.getByRole('listitem')).toHaveCount(1)
  await expect(dialog.getByText('Archived request 119', { exact: true })).toBeVisible()
  console.log(
    '[archive] 120 matches mount 50 chats; Show more mounts 100; filter reaches final match',
  )
})

test('archive confirmation keeps keyboard focus through cancel and delete', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  seedChat(session.fixture.userData, session.fixture.root, ['Focus archive'])
  await session.chrome.evaluate((root) => window.gui.openRecent(root), session.fixture.root)
  await expect.poll(async () => (await session.chatSnapshot()).turns.length).toBe(1)
  await session.chat.evaluate(() => window.gui.newSession())
  await expect.poll(async () => (await session.chatSnapshot()).turns.length).toBe(0)
  const expand = session.chat.getByRole('button', { name: 'Show conversation' })
  if (await expand.isVisible()) await expand.click()
  await chooseFromChatMenu(session.app, session.chat, 'Archived Chats')
  const dialog = session.chat.getByRole('dialog', { name: 'Archived chats' })
  await dialog.getByRole('button', { name: 'Delete Focus archive' }).focus()
  await dialog.getByRole('button', { name: 'Delete Focus archive' }).press('Enter')
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await session.shot('archive-confirm-focus', true)
  await session.chat.keyboard.press('Escape')
  await expect(dialog.getByRole('button', { name: /^Focus archive/ })).toBeFocused()
  await dialog.getByRole('button', { name: 'Delete Focus archive' }).focus()
  await dialog.getByRole('button', { name: 'Delete Focus archive' }).press('Enter')
  await dialog.getByRole('button', { name: 'Delete Focus archive' }).focus()
  await dialog.getByRole('button', { name: 'Delete Focus archive' }).press('Enter')
  await expect(dialog.getByText('No archived chats yet')).toBeVisible()
  await expect(dialog).toBeFocused()
  await session.chat.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})
