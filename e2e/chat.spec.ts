import { gitStatus } from './helpers/fixtures'
import { expect, test } from './helpers/test'

/** Runs in the chat page: two sends back to back, so the first is still starting. */
function sendTwice() {
  const first = window.gui.send('Make the counter button red.')
  const second = window.gui.send('A second message while the first is running.')
  return Promise.all([first, second])
}

// No agent login is needed: both cancels land while the agent process is still starting,
// so no prompt ever reaches an agent and no real usage is spent.
test('busy chat queues sends and a cancelled start leaves no trace', async ({ launch }) => {
  const session = await launch({ fixture: 'vite' })
  await session.waitForPreview()
  // The project is trusted, so no agent trust prompt may appear; one would be declined here.
  await session.declineConsentDialogs()
  const { root } = session.fixture

  // One turn at a time: the second message waits in the queue instead of interleaving.
  const accepted = await session.chat.evaluate(sendTwice)
  expect.soft(accepted).toEqual([true, true])

  // Stopping during startup is a cancel, not an agent error, and nothing was written.
  await session.chat.evaluate(() => window.gui.cancel())
  const first = await session.waitForTurn(0, 30_000)
  expect(first.turn.status).toBe('cancelled')
  expect(first.turn.error).toBeNull()
  expect(first.meta.status).not.toBe('error')
  expect(first.meta.error).toBeNull()
  expect(gitStatus(root)).toBe('')

  // Stopping pauses the queue: the waiting message stays put rather than starting on its own.
  const meta = () => session.chat.evaluate(() => window.gui.getChat().then((chat) => chat.meta))
  await expect.poll(async () => (await meta()).queuePaused).toBe(true)
  const { queue } = await meta()
  expect(queue.map((message) => message.prompt)).toEqual([
    'A second message while the first is running.',
  ])
  await session.chat.evaluate((id) => window.gui.removeQueued(id), queue[0]?.id ?? '')
  await expect.poll(async () => (await meta()).queue.length).toBe(0)

  // The busy lock is released by the cancel; otherwise the chat would be stuck for good.
  const again = await session.chat.evaluate(() => window.gui.send('Try once more.'))
  expect(again).toBe(true)
  await session.chat.evaluate(() => window.gui.cancel())
  const second = await session.waitForTurn(1, 30_000)
  expect(second.turn.status).toBe('cancelled')
  expect(gitStatus(root)).toBe('')
  expect(await session.consentPrompts()).toEqual([])
})
