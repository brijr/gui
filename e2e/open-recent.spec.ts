import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sleep, waitFor } from './helpers/env'
import { devServerPids } from './helpers/processes'
import { expect, test } from './helpers/test'

/** Runs in the chrome page: two open requests back to back, like a double click. */
function openTwice(root: string) {
  return Promise.all([window.gui.openRecent(root), window.gui.openRecent(root)])
}

// A double click on a recent project must not open a second window or start a second
// dev server (the second server would also grab another port and shadow the first).
test('double openRecent yields one window and one dev server', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { root } = session.fixture
  expect((await session.state()).project).toBeNull()
  // The start screen: its agent card settles once the launch check has run.
  const settled = async () => {
    const { agents, agentId } = await session.state()
    const status = agents.find((agent) => agent.id === agentId)?.status
    return status !== undefined && status !== 'unknown' && status !== 'checking'
  }
  await waitFor(settled, 'the agent check to settle', { timeout: 60_000 }).catch(() => undefined)
  await session.shot('start-screen')

  await session.chrome.evaluate(openTwice, root)
  await session.waitForPreview()
  // Give a duplicate window or server time to show up before counting.
  await sleep(2_000)

  expect(await session.windowCount()).toBe(1)
  expect((await session.state()).project?.root).toBe(root)
  expect(devServerPids(root)).toHaveLength(1)

  // The drawer's logs stream the dev server's own output (not just the echoed command).
  await session.chrome.evaluate(() => window.gui.showLogs())
  const readTerminal = () =>
    session.chrome.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '')
  const hasServerOutput = async () => /VITE|Local:|localhost/i.test(await readTerminal())
  await waitFor(hasServerOutput, 'dev server output in the logs terminal', { timeout: 15_000 })
  await session.shot('logs')
})

// A project with a chat is listed by its last message, so you can pick up where you left off.
test('the start screen lists recent chats by their last message', async ({ launch }) => {
  const session = await launch({ fixture: 'vite', open: 'recent' })
  const { root, userData } = session.fixture
  const real = realpathSync(root)
  const file = join(
    userData,
    'chats',
    `${createHash('sha1').update(real).digest('hex').slice(0, 16)}.json`,
  )
  mkdirSync(dirname(file), { recursive: true })
  const turn = (index: number, prompt: string, startedAt: number) => ({
    id: `t${index}`,
    index,
    prompt,
    context: null,
    items: [],
    status: 'done',
    error: null,
    startedAt,
    endedAt: startedAt + 1000,
    changes: [],
  })
  const now = Date.now()
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      agentId: 'claude',
      sessionId: null,
      turns: [
        turn(0, 'Make the header sticky', now - 3 * 3600_000),
        turn(1, 'Use a softer blue for the buttons', now - 2 * 3600_000),
      ],
      checkpoints: {},
      redo: null,
    }),
  )

  // A new tab's start screen reads the recent list, and the chats with it, afresh.
  await session.chrome.evaluate(() => window.gui.newTab())
  const row = session.chrome.getByRole('button', { name: /^Use a softer blue for the buttons/ })
  await expect(row).toBeVisible()
  await expect(row).toContainText('2 hours ago')
  await expect(session.chrome.getByRole('heading', { name: 'Recent chats' })).toBeVisible()
  const summary = file.replace(/\.json$/, '.summary.json')
  await expect.poll(() => existsSync(summary)).toBe(true)
  expect(JSON.parse(readFileSync(summary, 'utf8')).recent).toEqual({
    prompt: 'Use a softer blue for the buttons',
    at: now - 2 * 3600_000,
  })
  await session.shot('start-screen-chats', true)

  await row.click()
  await session.waitForPreview()
  expect((await session.state()).project?.root).toBe(real)
})
