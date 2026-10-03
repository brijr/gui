import { sleep, waitFor } from './helpers/env'
import { devServerPids } from './helpers/processes'
import { expect, test } from './helpers/test'

/** Runs in the chrome page: two open requests back to back, like a double click. */
function openTwice(root: string) {
  return Promise.all([window.grat.openRecent(root), window.grat.openRecent(root)])
}

// A double click on a recent project must not open a second window or start a second
// dev server (the second server would also grab another port and shadow the first).
test('double openRecent yields one window and one dev server', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { root } = session.fixture
  expect((await session.state()).project).toBeNull()

  await session.chrome.evaluate(openTwice, root)
  await session.waitForPreview()
  // Give a duplicate window or server time to show up before counting.
  await sleep(2_000)

  expect(await session.windowCount()).toBe(1)
  expect((await session.state()).project?.root).toBe(root)
  expect(devServerPids(root)).toHaveLength(1)

  // The logs drawer streams the dev server's own output (not just the echoed command).
  await session.chrome.evaluate(() => window.grat.setLogsOpen(true))
  const readTerminal = () =>
    session.chrome.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '')
  const hasServerOutput = async () => /VITE|Local:|localhost/i.test(await readTerminal())
  await waitFor(hasServerOutput, 'dev server output in the logs terminal', { timeout: 15_000 })
  await session.shot('logs')
})
