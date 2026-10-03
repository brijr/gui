import { defineConfig } from '@playwright/test'

/**
 * End-to-end suite for the built Electron app. `bun run test:e2e` builds first, then each
 * test launches Grat against a fresh copy of a fixture project (e2e/fixtures) and drives it
 * through the `window.grat` preload API.
 *
 * Runs serially: every test starts Electron plus a dev server and they share ports.
 *
 * Agent turns spend real usage and are skipped unless GRAT_E2E_AGENT=claude|codex.
 * Other switches: GRAT_E2E_SHOTS=1 attaches screenshots at key steps,
 * GRAT_E2E_KEEP=1 keeps the temp project directories.
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
