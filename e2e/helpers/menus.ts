import type { ElectronApplication, Page } from '@playwright/test'
import { waitFor } from './env'

/** State the main-process stub below keeps on `globalThis`. */
interface ChatMenuStore {
  /** Label of the chat menu item to choose next */
  guiChatMenuChoice?: string | null
  guiChatMenuStubbed?: boolean
  /** The items the chat's More menu offered last time */
  guiChatMenuItems?: string[]
}

/**
 * Chooses `label` from the chat header's More menu, as the user would: a native menu no test
 * can click, so main's next menu offering `label` clicks it instead of showing. Returns what
 * the menu offered.
 */
export function chooseFromChatMenu(app: ElectronApplication, chat: Page, label: string) {
  // dispatchEvent: the chat view can be hidden or offscreen; only its page matters here.
  return chooseFromMenu(app, label, 'the chat menu', () =>
    chat.getByRole('button', { name: 'More', exact: true }).dispatchEvent('click'),
  )
}

/** Chooses `label` from the toolbar's branch menu, the way into Source Control. */
export function chooseFromBranchMenu(app: ElectronApplication, chrome: Page, label: string) {
  return chooseFromMenu(app, label, 'the branch menu', () =>
    chrome.getByRole('button', { name: /^Branch / }).dispatchEvent('click'),
  )
}

async function chooseFromMenu(
  app: ElectronApplication,
  label: string,
  name: string,
  open: () => Promise<void>,
): Promise<string[]> {
  await app.evaluate(({ Menu }, choice) => {
    const store = globalThis as unknown as ChatMenuStore
    store.guiChatMenuChoice = choice
    if (store.guiChatMenuStubbed) return
    store.guiChatMenuStubbed = true
    const build = Menu.buildFromTemplate.bind(Menu)
    Menu.buildFromTemplate = (template) => {
      const menu = build(template)
      const wanted = store.guiChatMenuChoice
      if (!wanted || !menu.items.some((item) => item.label === wanted)) return menu
      menu.popup = (options) => {
        store.guiChatMenuChoice = null
        store.guiChatMenuItems = menu.items
          .filter((item) => item.type !== 'separator')
          .map((item) => item.label)
        menu.items.find((item) => item.label === wanted && item.enabled)?.click()
        options?.callback?.()
      }
      return menu
    }
  }, label)
  await open()
  // Answered once main has built and "shown" it.
  return waitFor(
    () =>
      app.evaluate(() => {
        const store = globalThis as unknown as ChatMenuStore
        return store.guiChatMenuChoice === null ? (store.guiChatMenuItems ?? []) : null
      }),
    `${name} to offer ${label}`,
  )
}
