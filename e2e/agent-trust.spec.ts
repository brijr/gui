import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type AgentId, CUSTOM_AGENT_PREFIX } from '../src/shared/types'
import { waitFor } from './helpers/env'
import { git, gitStatus } from './helpers/fixtures'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// Agents load the project's own agent settings (Claude Code's .claude/settings.json hooks,
// OpenCode's opencode.json), which can run commands, so no agent may start in a project
// the user hasn't trusted. A custom agent stands in for a real one: a script that records
// the folder it was started in and quits, so no agent login or usage is needed.

const MARKER: AgentId = `${CUSTOM_AGENT_PREFIX}Marker`
const NOT_STARTED = 'Not started: agree to start this project first, on its card.'

/**
 * Adds the marker agent to agents.json and waits for Gui to list it. Returns the folders
 * it has been started in so far; Gui's own health checks start it in its data folder.
 */
async function addMarkerAgent(session: GuiSession): Promise<() => string[]> {
  const { base, userData } = session.fixture
  const runs = join(base, 'agent-runs.txt')
  const script = join(base, 'marker-agent.sh')
  writeFileSync(script, `#!/bin/sh\npwd -P >> '${runs}'\nexit 1\n`, { mode: 0o755 })
  const agents = { Marker: { command: script, args: [], env: {} } }
  writeFileSync(join(userData, 'agents.json'), JSON.stringify(agents))
  await session.chrome.evaluate(() => window.gui.checkAgents())
  const listed = async () => (await session.state()).agents.some((agent) => agent.id === MARKER)
  await waitFor(listed, 'the marker agent to be listed')
  return () => (existsSync(runs) ? readFileSync(runs, 'utf8').split('\n').filter(Boolean) : [])
}

/** Switches the open project's chat to the marker agent. */
async function useMarker(session: GuiSession) {
  await session.chrome.evaluate((id) => window.gui.setAgent(id), MARKER)
  const selected = async () => (await session.chatSnapshot()).meta.agentId === MARKER
  await waitFor(selected, 'the marker agent to be selected')
}

const send = (session: GuiSession) =>
  session.chat.evaluate(() => window.gui.send('Make the counter button red.'))

test('an untrusted project starts no agent until its card agrees, and asks nothing else', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite', trusted: false, open: 'recent' })
  await session.declineConsentDialogs()
  const { root, userData } = session.fixture
  const runs = await addMarkerAgent(session)

  // Opening shows the card; by then the chat is set up.
  await session.chrome.evaluate((path) => window.gui.openRecent(path), root)
  await session.consentCard()
  await useMarker(session)

  // The first message doesn't ask a second time: it points at the card.
  expect(await send(session)).toBe(true)
  const first = await session.waitForTurn(0, 30_000)
  expect(first.turn.status).toBe('cancelled')
  expect(first.turn.error).toBeNull()
  expect(first.turn.items).toContainEqual(expect.objectContaining({ text: NOT_STARTED }))
  expect(first.meta.status).not.toBe('error')
  expect(await session.consentPrompts()).toEqual([])
  expect(runs()).not.toContain(root)
  expect(existsSync(join(userData, 'trusted-projects.json'))).toBe(false)
  expect(gitStatus(root)).toBe('')

  // The card's one agreement covers the agent too: it starts in the project from then on.
  await session.agreeOnCard()
  await waitFor(() => existsSync(join(userData, 'trusted-projects.json')), 'the project trusted')
  expect(await send(session)).toBe(true)
  const second = await session.waitForTurn(1, 60_000)
  expect(await session.consentPrompts()).toEqual([])
  expect(runs()).toContain(root)
  const trusted: unknown = JSON.parse(readFileSync(join(userData, 'trusted-projects.json'), 'utf8'))
  expect(trusted).toEqual([root])
  // The marker quits before speaking ACP, so the turn ends in its error.
  expect(second.turn.status).toBe('error')
})

test('a trusted project starts the agent without asking, and Gui leaves its branch alone', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  const { root } = session.fixture
  git(root, 'branch', '-M', 'main')
  const runs = await addMarkerAgent(session)
  const open = async () => (await session.state()).project !== null
  await waitFor(open, 'the project to open')
  await useMarker(session)

  expect(await send(session)).toBe(true)
  const turn = await session.waitForTurn(0, 60_000)
  expect(runs()).toContain(root)
  expect(turn.turn.status).toBe('error')
  expect(turn.turn.items).not.toContainEqual(expect.objectContaining({ text: NOT_STARTED }))
  expect(await session.consentPrompts()).toEqual([])

  // The first message on main starts no branch: Git is the agent's and the terminal's.
  expect(git(root, 'branch', '--format=%(refname:short)').trim()).toBe('main')
  // The project button names the branch after the project, read only: no menu of its own.
  await expect(session.chrome.getByRole('button', { name: /, branch main$/ })).toBeVisible()
  await expect(session.chrome.getByRole('button', { name: /^Branch / })).toHaveCount(0)
})
