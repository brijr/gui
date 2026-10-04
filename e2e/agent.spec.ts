import { AGENTS, type AgentId } from '../src/shared/types'
import { sleep, waitFor } from './helpers/env'
import { gitStatus } from './helpers/fixtures'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// Real agent turns spend usage on the developer's own login, so they only run on request.
const requested = process.env.GUI_E2E_AGENT || undefined
if (requested !== undefined && !AGENTS.some((agent) => agent.id === requested)) {
  const ids = AGENTS.map((agent) => agent.id).join(', ')
  throw new Error(`GUI_E2E_AGENT must be one of ${ids}; got "${requested}"`)
}

const BUTTON = 'button.counter'
const PROMPT = "Make this button's background color pure red (#ff0000). Change nothing else."
const RED = 'rgb(255, 0, 0)'
const TURN_TIMEOUT = 5 * 60_000

interface Approval {
  turnId: string
  itemId: string
  optionId: string | null
}

/** Runs in the chat page: answers one permission prompt. */
function approve({ turnId, itemId, optionId }: Approval) {
  window.gui.respondPermission(turnId, itemId, optionId)
}

/**
 * Waits for a turn the way a user watches it. Whatever the agent asks about is approved
 * (the outcome must not depend on the developer's own agent permission settings) and
 * recorded in `approved`. If the agent fails to start, fails with its own message.
 */
async function finishTurn(session: GuiSession, index: number, approved: string[]) {
  const deadline = Date.now() + TURN_TIMEOUT
  for (;;) {
    const { meta, turns } = await session.chatSnapshot()
    const turn = turns[index]
    if (turn && turn.status !== 'running') return turn
    if (meta.status === 'error' && meta.error) throw new Error(`Agent error: ${meta.error}`)
    for (const item of turn?.items ?? []) {
      if (item.kind !== 'permission' || item.resolved !== null) continue
      const allow = item.options.find((option) => option.kind.startsWith('allow'))
      approved.push(item.title)
      await session.chat.evaluate(approve, {
        turnId: turn.id,
        itemId: item.id,
        optionId: allow?.optionId ?? null,
      })
    }
    if (Date.now() > deadline) throw new Error(`Turn ${index + 1} did not finish in time`)
    await sleep(1_000)
  }
}

// The product in one run: ask for a change on a picked element, see it land through hot
// reload, then undo must put the project back exactly as it was and redo must reapply it.
test.describe('agent turn', () => {
  test.skip(!requested, 'Set GUI_E2E_AGENT to an agent id to run agent turns (spends real usage)')

  test('edit, undo and redo round-trip the picked element', async ({ launch }) => {
    test.setTimeout(10 * 60_000)
    const agentId: AgentId = requested ?? 'claude'
    const session = await launch({ fixture: 'vite' })
    const { root } = session.fixture
    await session.waitForPreview()

    await session.chrome.evaluate((id) => window.gui.setAgent(id), agentId)
    const switched = async () => (await session.chatSnapshot()).meta.agentId === agentId
    await waitFor(switched, `the ${agentId} agent to be selected`)

    const initial = await session.styleOf(BUTTON, 'backgroundColor')
    expect(initial).not.toBe(RED)
    const isRed = async () => (await session.styleOf(BUTTON, 'backgroundColor')) === RED
    const isOriginal = async () => (await session.styleOf(BUTTON, 'backgroundColor')) === initial

    await session.pickElement(BUTTON)
    const sent = await session.chat.evaluate((text) => window.gui.send(text), PROMPT)
    expect(sent).toBe(true)

    const approved: string[] = []
    const turn = await finishTurn(session, 0, approved)
    for (const title of approved) {
      test.info().annotations.push({ type: 'approved permission', description: title })
    }
    expect(turn.error, 'the agent reported an error').toBeNull()
    expect(turn.status).toBe('done')
    expect(turn.changes ?? []).not.toHaveLength(0)
    expect(gitStatus(root)).not.toBe('')
    // The edit has to show up in the running preview, not just on disk.
    await waitFor(isRed, 'the button to turn red in the preview', { timeout: 45_000 })
    // The turn shows how the picked element looked before the change and after it reloaded.
    const shown = async () => {
      const preview = (await session.chatSnapshot()).turns[0]?.preview
      return preview?.before && preview.after ? preview : null
    }
    await waitFor(shown, 'before/after images of the change', { timeout: 20_000 })
    await session.shot('edited')

    // Undo: the files go back to how they were before the turn, and the preview follows.
    await session.chat.evaluate((id) => window.gui.restoreTurn(id), turn.id)
    expect(gitStatus(root)).toBe('')
    const undone = await session.chatSnapshot()
    expect(undone.turns[0]?.reverted).toBe(true)
    expect(undone.meta.redoTurnIds).toEqual([turn.id])
    await waitFor(isOriginal, 'the original background after undo', { timeout: 45_000 })

    // Redo reverses the undo.
    await session.chat.evaluate(() => window.gui.redo())
    expect(gitStatus(root)).not.toBe('')
    const redone = await session.chatSnapshot()
    expect(redone.turns[0]?.reverted).toBe(false)
    expect(redone.meta.redoTurnIds).toEqual([])
    await waitFor(isRed, 'the red background after redo', { timeout: 45_000 })

    // Edit → Undo (⌘Z) undoes the last change when no text field has focus.
    await session.chrome.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })
    await session.app.evaluate(({ Menu }) => {
      const edit = Menu.getApplicationMenu()?.items.find((item) => item.label === 'Edit')
      edit?.submenu?.items.find((item) => item.label === 'Undo')?.click()
    })
    await waitFor(isOriginal, 'the original background after Edit → Undo', { timeout: 45_000 })
  })
})
