import { waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'
import { ask, installToolAgent } from './helpers/tool-agent'

// File → Reopen Closed Tab (⇧⌘T) opens the window's tab closed last again, where it was in
// the strip, as a fresh opening: the project's chat as it was saved, its dev server again.

/** Clicks a visible item of the app menu by label, as tabs.spec.ts does. */
function clickMenu(session: GuiSession, label: string) {
  return session.app.evaluate(({ Menu }, name) => {
    type Item = Electron.MenuItem
    const find = (items: Item[]): Item | undefined => {
      for (const item of items) {
        if (item.label === name && item.visible) return item
        const inner = item.submenu && find(item.submenu.items)
        if (inner) return inner
      }
      return undefined
    }
    const item = find(Menu.getApplicationMenu()?.items ?? [])
    if (!item) throw new Error(`No menu item "${name}"`)
    item.click()
  }, label)
}

const canReopen = (session: GuiSession) =>
  session.app.evaluate(
    ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('reopen-tab')?.enabled ?? null,
  )

test('Reopen Closed Tab brings a closed project back where it was, with its chat', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  const first = await session.waitForPreview()
  const root = session.fixture.root
  const name = first.project?.name ?? ''

  // A turn in its chat, from a stand-in agent: what reopening should bring back.
  await installToolAgent(session)
  await ask(session, [{ wait: 10 }])
  const prompt = (await session.chatSnapshot()).turns[0]?.prompt
  expect(prompt).toContain('TOOLS')

  // Nothing closed yet: nothing to reopen.
  expect(await canReopen(session)).toBe(false)

  // A second tab after it, then the project's tab closed: the start tab is left.
  await clickMenu(session, 'New Tab')
  const startTab = (
    await waitFor(async () => {
      const state = await session.state()
      return state.tabs.length === 2 ? state : null
    }, 'a second tab')
  ).activeTab
  await session.chrome.evaluate((id) => window.gui.selectTab(id), first.activeTab)
  await waitFor(
    async () => (await session.state()).activeTab === first.activeTab,
    'the project’s tab',
  )
  await clickMenu(session, 'Close Tab')
  await waitFor(async () => (await session.state()).tabs.length === 1, 'one tab')
  expect(session.chat.isClosed()).toBe(true)
  await waitFor(() => canReopen(session), 'Reopen Closed Tab to be enabled')

  // Reopened: a new tab in its old place, before the start tab, shown, running its project.
  await clickMenu(session, 'Reopen Closed Tab')
  const reopened = await waitFor(
    async () => {
      const state = await session.state()
      const running = state.devServer.status === 'running' && state.preview.visible
      return state.tabs.length === 2 && state.project?.root === root && running ? state : null
    },
    'the project to run again in a reopened tab',
    { timeout: 120_000 },
  )
  expect(reopened.activeTab).not.toBe(first.activeTab)
  expect(reopened.tabs.map((tab) => tab.id)).toEqual([reopened.activeTab, startTab])
  expect(reopened.tabs.map((tab) => tab.title)).toEqual([name, null])

  // Its chat, as it was saved: the chat in the window, which is the active tab's.
  await waitFor(async () => {
    const chats = await session.app.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const pages = (win?.contentView.children ?? [])
        .filter((child) => child instanceof WebContentsView)
        .map((view) => (view as Electron.WebContentsView).webContents)
        .filter((wc) => wc.getURL().endsWith('/chat.html'))
      return Promise.all(
        pages.map((wc) =>
          wc.executeJavaScript(
            'window.gui.getChat().then((chat) => chat.turns.map((t) => t.prompt))',
          ),
        ),
      )
    })
    return chats.length === 1 && chats[0]?.[0] === prompt
  }, 'the reopened tab’s chat')

  // Each closed tab reopens once.
  await waitFor(async () => (await canReopen(session)) === false, 'Reopen to be disabled again')
})
