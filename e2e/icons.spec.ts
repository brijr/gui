import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as base, type ElectronApplication, expect, type Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import { SYMBOLS } from '../src/shared/symbols'
import { electronExecutable, REPO_ROOT, waitFor } from './helpers/env'

const test = base.extend<{ app: ElectronApplication; chrome: Page }>({
  app: async ({ colorScheme }, use) => {
    const profile = mkdtempSync(join(tmpdir(), 'gui-symbols-'))
    const env = { ...process.env, GUI_OPEN: '', GUI_AGENT_STAND_INS: '', GUI_E2E_BACKGROUND: '1' }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    const app = await electron.launch({
      executablePath: electronExecutable(),
      args: [REPO_ROOT, `--user-data-dir=${profile}`],
      env,
      colorScheme,
    })
    try {
      await use(app)
    } finally {
      await app.close()
      rmSync(profile, { recursive: true, force: true })
    }
  },
  chrome: async ({ app }, use) => {
    const page = await waitFor(
      () =>
        app
          .context()
          .pages()
          .find((p) => p.url().endsWith('/index.html')),
      'chrome',
    )
    await use(page)
  },
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`SF Symbols render in ${colorScheme} controls`, async ({ app, chrome }, testInfo) => {
    test.skip(process.platform !== 'darwin', 'SF Symbols are provided by macOS')
    await chrome.emulateMedia({ colorScheme })
    const images = await chrome.evaluate(() => window.gui.getSymbols())
    for (const name of new Set(Object.values(SYMBOLS))) {
      expect(images[name], name).toMatch(/^data:image\/png;base64,/)
    }
    const symbol = chrome.locator('[data-symbol="folder.badge.plus"]').first()
    await expect(symbol).toBeVisible()
    const style = await symbol.evaluate((el) => {
      const css = getComputedStyle(el)
      return {
        color: css.color,
        background: css.backgroundColor,
        mask: css.maskImage,
        width: el.getBoundingClientRect().width,
      }
    })
    expect(style.background).toBe(style.color)
    expect(style.mask).toContain('data:image/png;base64,')
    expect(style.width).toBe(14)
    await chrome.screenshot({ path: testInfo.outputPath(`sf-symbols-${colorScheme}.png`) })

    await chrome.evaluate(() => window.gui.openSettings('agents'))
    const settings = await waitFor(
      () =>
        app
          .context()
          .pages()
          .find((p) => p.url().endsWith('/settings.html')),
      'settings',
    )
    await settings.emulateMedia({ colorScheme })
    await expect(settings.locator('[data-symbol="cpu"]').first()).toBeVisible()
    await settings.screenshot({
      path: testInfo.outputPath(`sf-symbols-settings-${colorScheme}.png`),
    })
  })
}

test('controls retain fallback icons when native symbols are unavailable', async ({
  app,
  chrome,
}) => {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('symbols:get')
    ipcMain.handle('symbols:get', () => ({}))
  })
  await chrome.reload()
  await expect(chrome.locator('svg.lucide-folder-plus').first()).toBeVisible()
  await expect(chrome.locator('[data-symbol]')).toHaveCount(0)
})
