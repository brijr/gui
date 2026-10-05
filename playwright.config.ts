import { defineConfig } from '@playwright/test'

/**
 * End-to-end suite for the built Electron app. `bun run test:e2e` builds first, then each
 * test launches Gui against a fresh copy of a fixture project (e2e/fixtures) and drives it
 * through the `window.gui` preload API.
 *
 * Runs serially: every test starts Electron plus a dev server and they share ports.
 *
 * Agent turns spend real usage and are skipped unless GUI_E2E_AGENT=claude|codex.
 * Other switches: GUI_E2E_SHOTS=1 attaches screenshots at key steps,
 * GUI_E2E_KEEP=1 keeps the temp project directories.
 *
 * Gui runs in the background (GUI_E2E_BACKGROUND=1): its windows show without coming to the
 * front, so the suite doesn't take over the window you're working in. The two tests about
 * where the keyboard goes need Gui to be the active app; they run in CI, and locally only
 * with GUI_E2E_FOCUS=1.
 */
export default defineConfig({
  testDir: 'e2e',
  testIgnore: /e2e\/fixtures\//,
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 3 * 60_000,
  expect: { timeout: 15_000 },
  outputDir: 'test-results',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
})
