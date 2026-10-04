import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { type AgentId, CUSTOM_AGENT_PREFIX, type TurnItem } from '../src/shared/types'
import { electronExecutable, sleep, waitFor } from './helpers/env'
import type { GuiSession } from './helpers/session'
import { expect, test } from './helpers/test'

// Auto mode, on unless the user turns it off for a project: Gui answers the agent's
// permission requests itself, except for requests that name files outside the project,
// change sensitive files, or that the agent flags. A stand-in ACP agent (a small Node script) asks a fixed list of questions, one after
// the other, and records how Gui answered each. No agent login or usage is needed.

const AGENT: AgentId = `${CUSTOM_AGENT_PREFIX}Approvals`
/** Asks to run a command, then to edit a file outside the project. */
const BASIC = 'SCENARIO=basic Run the tests, then edit a file outside the project'
/** Asks the questions Auto mode must still put to the user, then some it answers itself. */
const CAREFUL = 'SCENARIO=careful Look around and tidy up'

/**
 * Speaks ACP (ndjson JSON-RPC) on stdio. Each prompt sends the `session/request_permission`
 * requests of the scenario its text names, each only after the one before is answered.
 * Every answer goes into the log, tagged with the prompt's number, the moment it arrives;
 * the prompt ends once all are in.
 */
const AGENT_SCRIPT = String.raw`
const { appendFileSync } = require('node:fs')
const [log, outside, root] = process.argv.slice(2)
const ALLOW = { optionId: 'allow', name: 'Allow', kind: 'allow_once' }
const REJECT = { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
const SCENARIOS = {
  basic: [
    { toolCallId: 'run-1', title: 'npm test', kind: 'execute' },
    { toolCallId: 'edit-1', title: 'Edit ' + outside, kind: 'edit', locations: [{ path: outside }] },
  ],
  careful: [
    // The agent leads with No: its way of saying a person should decide.
    { toolCallId: 'flagged-1', title: 'rm -rf build', kind: 'execute', options: [REJECT, ALLOW] },
    { toolCallId: 'plan-1', title: 'Ready to code?', kind: 'switch_mode' },
    { toolCallId: 'read-out-1', title: 'Read ' + outside, kind: 'read', locations: [{ path: outside }] },
    {
      toolCallId: 'config-1',
      title: 'Edit package.json',
      kind: 'edit',
      locations: [{ path: root + '/package.json' }],
    },
    // Auto mode answers these itself.
    {
      toolCallId: 'read-in-1',
      title: 'Read src/App.tsx',
      kind: 'read',
      locations: [{ path: root + '/src/App.tsx' }],
    },
    { toolCallId: 'search-1', title: 'Search the project', kind: 'search', locations: [{ path: root }] },
    // Like Muse: no locations, the path is in the tool's input.
    { toolCallId: 'edit-in-1', title: 'edit_file', kind: 'edit', rawInput: { path: 'src/App.tsx' } },
  ],
}
const write = (message) => {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
}

// Requests sent to Gui that it hasn't answered yet, by id.
const pending = new Map()
let lastId = 1000
let turns = 0
const ask = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++lastId
    pending.set(id, { resolve, reject })
    write({ id, method, params })
  })

// Announces a tool call, asks about it, and records the answer.
const requestPermission = async (sessionId, turn, { options = [ALLOW, REJECT], ...tool }) => {
  const toolCall = { ...tool, status: 'pending' }
  const update = { sessionUpdate: 'tool_call', ...toolCall }
  write({ method: 'session/update', params: { sessionId, update } })
  const { outcome } = await ask('session/request_permission', { sessionId, toolCall, options })
  appendFileSync(log, JSON.stringify({ turn, toolCallId: tool.toolCallId, outcome }) + '\n')
}

const prompt = async ({ sessionId, prompt }) => {
  const turn = turns++
  const text = prompt.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  const scenario = /SCENARIO=(\w+)/.exec(text)?.[1] ?? 'basic'
  for (const tool of SCENARIOS[scenario]) await requestPermission(sessionId, turn, tool)
  return { stopReason: 'end_turn' }
}

const handle = (message) => {
  const { id, method, params } = message
  if (method === undefined) {
    // Gui's answer to a request above.
    const request = pending.get(id)
    if (!request) return
    pending.delete(id)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
    return
  }
  // Notifications, such as session/cancel, need no answer.
  if (id === undefined) return
  if (method === 'initialize') {
    return write({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
  }
  if (method === 'session/new') {
    return write({ id, result: { sessionId: 'session-' + process.pid } })
  }
  if (method === 'session/prompt') {
    prompt(params).then(
      (result) => write({ id, result }),
      (error) => write({ id, error: { code: -32603, message: error.message } }),
    )
    return
  }
  write({ id, error: { code: -32601, message: 'Method not found' } })
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    if (line) handle(JSON.parse(line))
  }
})
`

interface Outcome {
  /** Index of the turn the request belonged to */
  turn: number
  toolCallId: string
  /** What Gui answered with: a chosen option, or cancelled */
  outcome: { outcome: string; optionId?: string }
}

interface StandIn {
  /** The file the agent asks about: in the test's scratch folder, outside the project. */
  outside: string
  /** How Gui answered the agent's requests in a turn, oldest first. */
  outcomes: (turn: number) => Outcome[]
}

/** The answer Gui gives when it picks `optionId`. */
const chose = (turn: number, toolCallId: string, optionId: string): Outcome => ({
  turn,
  toolCallId,
  outcome: { outcome: 'selected', optionId },
})

/**
 * Adds the stand-in agent to agents.json (run on Electron's own Node), waits for Gui to list
 * it, and selects it once the project is open. Its health check starts a session too,
 * outside the project, but never prompts.
 */
async function useAgent(session: GuiSession): Promise<StandIn> {
  const { base, root, userData } = session.fixture
  // `base` holds the project, not the other way round, so this is outside it.
  const outside = join(base, 'outside.txt')
  const log = join(base, 'outcomes.ndjson')
  const script = join(base, 'approvals-agent.cjs')
  writeFileSync(script, AGENT_SCRIPT)
  const agents = {
    Approvals: {
      command: electronExecutable(),
      args: [script, log, outside, root],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
  }
  writeFileSync(join(userData, 'agents.json'), JSON.stringify(agents))
  await session.chrome.evaluate(() => window.gui.checkAgents())
  const listed = async () => (await session.state()).agents.some((agent) => agent.id === AGENT)
  await waitFor(listed, 'the agent to be listed')
  await waitFor(async () => (await session.state()).project !== null, 'the project to open')
  await session.chrome.evaluate((id) => window.gui.setAgent(id), AGENT)
  const selected = async () => (await session.chatSnapshot()).meta.agentId === AGENT
  await waitFor(selected, 'the agent to be selected')
  return {
    outside,
    outcomes: (turn: number) => {
      if (!existsSync(log)) return []
      return readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Outcome)
        .filter((entry) => entry.turn === turn)
    },
  }
}

type PermissionCard = Extract<TurnItem, { kind: 'permission' }>

/** A permission card, with the turn it's in. */
interface OpenCard {
  turnId: string
  card: PermissionCard
}

/** The permission cards in a turn's transcript, oldest first. */
const cardsIn = (items: TurnItem[]) =>
  items.filter((item): item is PermissionCard => item.kind === 'permission')

/** What a card shows of itself: what it was for, and how it ended (null while open). */
const shown = ({ toolKind, resolved }: PermissionCard) => ({ toolKind, resolved })

async function cardsOf(session: GuiSession, index: number) {
  const turn = (await session.chatSnapshot()).turns[index]
  return cardsIn(turn?.items ?? [])
}

/** Waits for turn `index` to show a card for a `toolKind` request that nobody answered yet. */
function openCard(session: GuiSession, index: number, toolKind: string) {
  return waitFor(
    async () => {
      const turn = (await session.chatSnapshot()).turns[index]
      const card = cardsIn(turn?.items ?? []).find(
        (item) => item.toolKind === toolKind && item.resolved === null,
      )
      return turn && card ? { turnId: turn.id, card } : null
    },
    `a ${toolKind} permission card in turn ${index + 1}`,
  )
}

interface Answer {
  turnId: string
  itemId: string
  optionId: string
}

/** Runs in the chat page: answers one permission card, as clicking its option does. */
function respond({ turnId, itemId, optionId }: Answer) {
  window.gui.respondPermission(turnId, itemId, optionId)
}

function answer(session: GuiSession, { turnId, card }: OpenCard, optionId: string) {
  return session.chat.evaluate(respond, { turnId, itemId: card.id, optionId })
}

const send = (chat: Page, text: string) =>
  chat.evaluate((message) => window.gui.send(message), text)

async function autoApprove(chat: Page): Promise<boolean> {
  return (await chat.evaluate(() => window.gui.getChat())).meta.autoApprove
}

/** The projects Auto mode was turned off for, as saved in prefs.json; [] before any. */
function askRoots(session: GuiSession): unknown {
  const file = join(session.fixture.userData, 'prefs.json')
  if (!existsSync(file)) return []
  const prefs = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  return prefs.askRoots ?? []
}

/** Waits for the chat to report Auto mode as `on`, and for prefs.json to remember it by root. */
async function autoModeIs(session: GuiSession, on: boolean) {
  const label = `Auto mode to be ${on ? 'on' : 'off'}`
  await waitFor(async () => (await autoApprove(session.chat)) === on, label)
  const roots = JSON.stringify(on ? [] : [session.fixture.root])
  await waitFor(() => JSON.stringify(askRoots(session)) === roots, `${label} in prefs.json`)
}

/** Runs in the main process: Agent → Auto Mode, as choosing it or ⇧⌘A does. */
function chooseAutoModeItem(session: GuiSession) {
  return session.app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('auto-mode')
    if (!item) throw new Error('Agent → Auto Mode is missing')
    item.click()
  })
}

/** Agent → Auto Mode as the menu shows it. */
function autoModeItem(session: GuiSession) {
  return session.app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('auto-mode')
    return item ? { label: item.label, checked: item.checked } : null
  })
}

/** The chat's Ask/Auto chip, by its fixed accessible name. */
const autoChip = (chat: Page) => chat.getByRole('button', { name: 'Auto mode', exact: true })

/**
 * Opens a second, empty project through Open Recent, which puts it in a new tab, and returns
 * that tab's chat page once its project is open. The first tab is shown again afterwards, so
 * the test carries on in the first project's chat.
 */
async function openSecondProject(session: GuiSession): Promise<Page> {
  const { base, userData } = session.fixture
  const second = join(base, 'second-project')
  mkdirSync(second)
  writeFileSync(join(second, 'package.json'), JSON.stringify({ name: 'second-project' }))
  const recentFile = join(userData, 'recent-projects.json')
  const recent = existsSync(recentFile)
    ? (JSON.parse(readFileSync(recentFile, 'utf8')) as unknown[])
    : []
  const entry = { root: second, name: 'second-project', openedAt: 2 }
  writeFileSync(recentFile, JSON.stringify([entry, ...recent]))
  const first = (await session.state()).activeTab
  await session.chrome.evaluate((root) => window.gui.openRecent(root), second)
  const page = () =>
    session.app
      .context()
      .pages()
      .find((p) => p.url().endsWith('/chat.html') && p !== session.chat)
  const chat = await waitFor(page, "the second tab's chat")
  await chat.waitForFunction(() => 'gui' in window)
  const opened = async () => (await session.state()).project?.root
  await waitFor(async () => (await opened()) === second, 'the second project to open')
  await session.chrome.evaluate((id) => window.gui.selectTab(id), first)
  await waitFor(async () => (await session.state()).activeTab === first, 'the first tab again')
  return chat
}

test('Auto mode is on per project; off, it asks; on, it still asks about outside edits', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  const agent = await useAgent(session)
  const { chat } = session

  // A fresh profile starts in Auto.
  expect(await autoApprove(chat)).toBe(true)
  await expect(autoChip(chat)).toHaveAttribute('aria-pressed', 'true')
  await expect(autoChip(chat)).toHaveText('Auto')
  await expect(autoChip(chat)).toHaveAccessibleDescription(/outside this project/)
  expect(await autoModeItem(session)).toEqual({ label: 'Auto Mode', checked: true })

  // The chip turns it off, remembered for this project.
  await autoChip(chat).click()
  await autoModeIs(session, false)
  await expect(autoChip(chat)).toHaveAttribute('aria-pressed', 'false')
  await expect(autoChip(chat)).toHaveText('Ask')
  expect(await autoModeItem(session)).toEqual({ label: 'Auto Mode', checked: false })

  // Off, the command waits for the user, and so does the edit.
  expect(await send(chat, BASIC)).toBe(true)
  const command = await openCard(session, 0, 'execute')
  await answer(session, command, 'allow')
  const edit = await openCard(session, 0, 'edit')
  expect(edit.card.locations).toEqual([agent.outside])
  await answer(session, edit, 'reject')
  const first = await session.waitForTurn(0)
  expect(first.turn.status).toBe('done')
  expect(cardsIn(first.turn.items).map(shown)).toEqual([
    { toolKind: 'execute', resolved: 'allow' },
    { toolKind: 'edit', resolved: 'reject' },
  ])
  // The agent heard what the user chose, the refusal included.
  expect(agent.outcomes(0)).toEqual([chose(0, 'run-1', 'allow'), chose(0, 'edit-1', 'reject')])

  // Auto on from the menu while a card Auto would have answered is open: the card stays
  // open for the user, and only requests after it are answered by Gui.
  expect(await send(chat, BASIC)).toBe(true)
  const waiting = await openCard(session, 1, 'execute')
  await chooseAutoModeItem(session)
  await autoModeIs(session, true)
  expect(await autoModeItem(session)).toEqual({ label: 'Auto Mode', checked: true })
  await expect(autoChip(chat)).toHaveAttribute('aria-pressed', 'true')
  await session.shot('auto-mode-on')
  await sleep(1000)
  expect((await cardsOf(session, 1)).map(shown)).toEqual([{ toolKind: 'execute', resolved: null }])
  expect(agent.outcomes(1)).toEqual([])
  await answer(session, waiting, 'allow')
  const stillAsks = await openCard(session, 1, 'edit')
  await answer(session, stillAsks, 'reject')
  const second = await session.waitForTurn(1)
  expect(cardsIn(second.turn.items).map(shown)).toEqual([
    { toolKind: 'execute', resolved: 'allow' },
    { toolKind: 'edit', resolved: 'reject' },
  ])

  // The command is approved with no card. Only the edit outside the project asks, and the
  // agent already has the command's answer by then, because it asks one at a time.
  expect(await send(chat, BASIC)).toBe(true)
  const outsideEdit = await openCard(session, 2, 'edit')
  expect(outsideEdit.card.locations).toEqual([agent.outside])
  expect((await cardsOf(session, 2)).map(shown)).toEqual([{ toolKind: 'edit', resolved: null }])
  expect(agent.outcomes(2)).toEqual([chose(2, 'run-1', 'allow')])
  await answer(session, outsideEdit, 'reject')
  const third = await session.waitForTurn(2)
  expect(third.turn.status).toBe('done')
  expect(cardsIn(third.turn.items).map(shown)).toEqual([{ toolKind: 'edit', resolved: 'reject' }])
  expect(agent.outcomes(2)).toEqual([chose(2, 'run-1', 'allow'), chose(2, 'edit-1', 'reject')])

  // Auto mode belongs to the project: turning it off here leaves another project in Auto.
  const other = await openSecondProject(session)
  expect(await autoApprove(other)).toBe(true)
  await autoChip(chat).click()
  await autoModeIs(session, false)
  await expect(autoChip(other)).toHaveAttribute('aria-pressed', 'true')
  expect(await autoApprove(other)).toBe(true)
})

test('Auto mode still asks when the agent flags a request, about outside reads and sensitive edits', async ({
  launch,
}) => {
  const session = await launch({ fixture: 'vite' })
  await session.declineConsentDialogs()
  const agent = await useAgent(session)
  // On from the start, with nothing saved.
  expect(await autoApprove(session.chat)).toBe(true)
  await expect(autoChip(session.chat)).toHaveAttribute('aria-pressed', 'true')

  expect(await send(session.chat, CAREFUL)).toBe(true)
  // Each asks in turn, nothing answered before the user does.
  const flagged = await openCard(session, 0, 'execute')
  expect(agent.outcomes(0)).toEqual([])
  await answer(session, flagged, 'reject')
  await answer(session, await openCard(session, 0, 'switch_mode'), 'allow')
  const outsideRead = await openCard(session, 0, 'read')
  expect(outsideRead.card.locations).toEqual([agent.outside])
  await answer(session, outsideRead, 'reject')
  const config = await openCard(session, 0, 'edit')
  expect(config.card.locations).toEqual(['package.json'])
  expect(config.card.sensitive).toBe(true)
  await answer(session, config, 'reject')

  // The in-project read, the search of the project and the ordinary edit need no one.
  const turn = await session.waitForTurn(0)
  expect(turn.turn.status).toBe('done')
  expect(cardsIn(turn.turn.items).map(shown)).toEqual([
    { toolKind: 'execute', resolved: 'reject' },
    { toolKind: 'switch_mode', resolved: 'allow' },
    { toolKind: 'read', resolved: 'reject' },
    { toolKind: 'edit', resolved: 'reject' },
  ])
  expect(agent.outcomes(0)).toEqual([
    chose(0, 'flagged-1', 'reject'),
    chose(0, 'plan-1', 'allow'),
    chose(0, 'read-out-1', 'reject'),
    chose(0, 'config-1', 'reject'),
    chose(0, 'read-in-1', 'allow'),
    chose(0, 'search-1', 'allow'),
    chose(0, 'edit-in-1', 'allow'),
  ])
})
