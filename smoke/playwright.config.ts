import { defineConfig } from '@playwright/test'

/**
 * The agent smoke test (smoke/agents.spec.ts): one real turn per installed agent, to catch an
 * agent update that breaks Gui. It spends real agent usage, so it runs only through
 * `bun run smoke:agents` (scripts/smoke-agents.ts), never in `bun run test:e2e`, CI or
 * `bun run check`. It launches Gui the way the e2e suite does (e2e/helpers), on the vite
 * fixture.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.ts$/,
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  expect: { timeout: 15_000 },
  outputDir: '../test-results/smoke',
  reporter: [['list'], ['html', { outputFolder: '../playwright-report/smoke', open: 'never' }]],
})
