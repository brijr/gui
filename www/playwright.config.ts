import { defineConfig } from '@playwright/test'

/**
 * Browser tests for the site. `bun run test` builds it, serves dist/, and
 * runs e2e/ in the Chrome that is installed on this computer (so there is no browser to
 * download).
 */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  expect: { timeout: 30_000 },
  outputDir: 'test-results',
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4329',
    channel: 'chrome',
    viewport: { width: 1440, height: 900 },
    // Each test's page keeps full frame and timer rates, though several run at once.
    launchOptions: {
      args: [
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
      ],
    },
  },
  webServer: {
    command: 'bun e2e/serve.ts',
    url: 'http://127.0.0.1:4329',
    reuseExistingServer: false,
  },
})
