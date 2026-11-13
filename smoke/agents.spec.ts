import type { TestInfo } from '@playwright/test'
import { sleep, waitFor } from '../e2e/helpers/env'
import { FIXTURES, type FixtureCopy } from '../e2e/helpers/fixtures'
import { type GuiSession, launchGui, standInsFile } from '../e2e/helpers/session'
import { test } from '../e2e/helpers/test'
import {
  AGENTS,
  type AgentHealth,
  type AgentId,
  agentName,
  type ModelSettings,
  type Turn,
} from '../src/shared/types'
import { parseFakes, writeFakeStandIns } from './fake-agent'
import { recordResult, type SmokeResult } from './results'

// One real turn per agent: does it still connect to Gui over ACP, see Gui's MCP tools, call
// one, and finish? Real turns spend the developer's own agent usage, so this runs only through
// `bun run smoke:agents` (GUI_SMOKE=1), or against fake agents (GUI_SMOKE_FAKE, fake-agent.ts).

const fakes = parseFakes(process.env.GUI_SMOKE_FAKE)
const optedIn = process.env.GUI_SMOKE === '1' || fakes !== null

function requestedAgents(): AgentId[] {
  const list = process.env.GUI_SMOKE_AGENTS?.split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  if (!list?.length) return fakes ? [...fakes.keys()] : AGENTS.map((agent) => agent.id)
  for (const id of list) {
    if (!AGENTS.some((agent) => agent.id === id)) {
      throw new Error(`GUI_SMOKE_AGENTS: unknown agent "${id}"`)
    }
  }
  return list as AgentId[]
}

const FIXTURE = 'vite'
/** The fixture page's <title> (e2e/fixtures/vite/index.html), which the reply should name. */
const TITLE = FIXTURES.find((fixture) => fixture.name === FIXTURE)?.heading ?? 'Gui Vite fixture'
const PROMPT =
  'Use the gui preview_screenshot tool once to look at the preview, then reply with only the ' +
  "page's title. Don't edit any files or run any commands."
const HEALTH_TIMEOUT = 90_000
const TURN_TIMEOUT = Number(process.env.GUI_SMOKE_TURN_SECONDS || 180) * 1_000
/**
 * Models named like these are the cheap, fast tier. The first one an agent offers is picked
 * for the turn; an agent with none keeps its default.
 */
const CHEAP_MODEL = /haiku|mini|nano|flash|lite|small|fast/i
/** The lowest effort worth asking for: some agents refuse tools at `minimal`. */
const LOW_EFFORT = /^low$/i
/** Where Gui's own check leaves an agent: ready, or what stops it. */
const SETTLED: AgentHealth['status'][] = ['ready', 'not-installed', 'signed-out', 'error']

interface McpTraceEntry {
  method: string
  tool: string | null
}

class Skip extends Error {}

/** Waits for Gui's own check of the agent (it starts a session, without a prompt). */
async function checkedHealth(session: GuiSession, id: AgentId): Promise<AgentHealth> {
  await session.chrome.evaluate((agent) => window.gui.setAgent(agent), id)
  const start = Date.now()
  let nudged = false
  return waitFor(
    async () => {
      const { meta } = await session.chatSnapshot()
      const health = meta.agentId === id ? meta.agent : null
      if (health && SETTLED.includes(health.status)) return health
      if (health?.status === 'unknown' && !nudged && Date.now() - start > 3_000) {
        nudged = true
        await session.chrome.evaluate((agent) => window.gui.checkAgents(agent), id)
      }
      return null
    },
    `Gui's check of ${agentName(id)}`,
    { timeout: HEALTH_TIMEOUT, interval: 500 },
  )
}

/** Picks the cheapest model and a low effort, when the agent offers them; returns the model. */
async function pickCheapModel(session: GuiSession): Promise<string | null> {
  const models = (await session.chatSnapshot()).meta.models
  if (!models) return null
  const choose = async (setting: ModelSettings['effort'], wanted: RegExp) => {
    const option = setting?.options.find((o) => wanted.test(o.value) || wanted.test(o.name))
    if (!setting || !option || option.value === setting.value) return
    await session.chat.evaluate(([id, value]) => window.gui.setAgentSetting(id, value), [
      setting.id,
      option.value,
    ] as const)
    await waitFor(async () => {
      const now = (await session.chatSnapshot()).meta.models
      return [now?.model, now?.effort].some((s) => s?.id === setting.id && s.value === option.value)
    }, `${setting.id} ${option.value}`)
  }
  await choose(models.model, CHEAP_MODEL)
  await choose(models.effort, LOW_EFFORT)
  const picked = (await session.chatSnapshot()).meta.models
  const model = picked?.model.options.find((o) => o.value === picked.model.value)
  const effort = picked?.effort?.value
  return `${model?.name ?? picked?.model.value}${effort ? ` (${effort})` : ''}`
}

/**
 * Runs the turn the way a user watches it: approves whatever the agent asks (the result must
 * not depend on the developer's own permission settings), and gives up after TURN_TIMEOUT.
 */
async function runTurn(session: GuiSession): Promise<Turn> {
  const sent = await session.chat.evaluate((text) => window.gui.send(text), PROMPT)
  if (!sent) throw new Error("Gui didn't accept the message")
  const deadline = Date.now() + TURN_TIMEOUT
  for (;;) {
    const { meta, turns } = await session.chatSnapshot()
    const turn = turns[0]
    if (turn && turn.status !== 'running') return turn
    if (meta.status === 'error' && meta.error) throw new Error(`Agent error: ${meta.error}`)
    for (const item of turn?.items ?? []) {
      if (item.kind !== 'permission' || item.resolved !== null) continue
      const allow = item.options.find((option) => option.kind.startsWith('allow'))
      await session.chat.evaluate(
        ([turnId, itemId, optionId]) => window.gui.respondPermission(turnId, itemId, optionId),
        [turn?.id ?? '', item.id, allow?.optionId ?? null] as const,
      )
    }
    if (Date.now() > deadline) {
      await session.chat.evaluate(() => window.gui.cancel()).catch(() => undefined)
      throw new Error(`The turn didn't finish in ${TURN_TIMEOUT / 1_000}s`)
    }
    await sleep(1_000)
  }
}

const mcpTrace = (session: GuiSession) =>
  session.app.evaluate(() => (globalThis as { guiMcpTrace?: McpTraceEntry[] }).guiMcpTrace ?? [])

const replyText = (turn: Turn) =>
  turn.items.flatMap((item) => (item.kind === 'text' ? [item.text] : [])).join('')

async function smoke(id: AgentId, copy: FixtureCopy, testInfo: TestInfo, result: SmokeResult) {
  if (fakes) writeFakeStandIns(standInsFile(copy), copy.base, fakes, TITLE)
  const session = await launchGui(
    copy,
    { fixture: FIXTURE, env: { GUI_E2E_MCP_TRACE: '1' } },
    testInfo,
  )
  try {
    const health = await checkedHealth(session, id)
    result.installed = health.status !== 'not-installed'
    result.version = health.binary?.version ?? null
    const why = health.message ?? health.detail
    if (health.status === 'not-installed') throw new Skip(why ?? 'Not installed')
    if (health.status === 'signed-out') throw new Skip(`Not signed in${why ? `: ${why}` : ''}`)
    if (health.status === 'error') throw new Error(`Gui's check failed: ${why ?? 'no reason'}`)

    await session.waitForPreview()
    await session.chat.evaluate(() => window.gui.setAutoApprove(true))
    result.model = await pickCheapModel(session)

    let trace: McpTraceEntry[] = []
    const turn = await runTurn(session).finally(async () => {
      trace = await mcpTrace(session).catch(() => [])
      result.tools = trace.flatMap((entry) => (entry.tool ? [entry.tool] : []))
    })
    const reply = replyText(turn)
    result.titleInReply = reply.toLowerCase().includes(TITLE.toLowerCase())
    await testInfo.attach('reply.txt', { body: reply || '(empty)', contentType: 'text/plain' })

    // In order, so the reason names the first step that broke.
    if (turn.status !== 'done' || turn.error) {
      throw new Error(`The turn ended ${turn.status}: ${turn.error ?? 'no error given'}`)
    }
    if (!trace.some((entry) => entry.method === 'tools/list')) {
      throw new Error("The agent never listed Gui's MCP tools")
    }
    if (!result.tools.length) throw new Error('The agent called no Gui tool')
    if (!result.titleInReply) result.reason = `Reply didn't name "${TITLE}" (soft check)`
  } catch (error) {
    // Anything the session shows is worth having when a real agent fails.
    if (!(error instanceof Skip)) await session.captureDiagnostics().catch(() => undefined)
    throw error
  } finally {
    await session.close()
  }
}

test.describe('agent smoke', () => {
  test.skip(!optedIn, 'Uses real agent turns; run `bun run smoke:agents` (GUI_SMOKE=1)')

  for (const id of optedIn ? requestedAgents() : AGENTS.map((agent) => agent.id)) {
    test(id, async ({ copyFixture }, testInfo) => {
      test.setTimeout(HEALTH_TIMEOUT + 150_000 + TURN_TIMEOUT + 60_000)
      const started = Date.now()
      const result: SmokeResult = {
        agent: id,
        name: agentName(id),
        installed: null,
        result: 'pass',
        seconds: 0,
        reason: null,
        version: null,
        model: null,
        tools: [],
        titleInReply: null,
      }
      let outcome: unknown = null
      try {
        await smoke(id, copyFixture(FIXTURE), testInfo, result)
      } catch (error) {
        outcome = error
        result.result = error instanceof Skip ? 'skipped' : 'fail'
        result.reason = error instanceof Error ? error.message : String(error)
      }
      result.seconds = (Date.now() - started) / 1_000
      recordResult(process.env.GUI_SMOKE_RESULTS, result)
      testInfo.annotations.push({ type: 'smoke', description: JSON.stringify(result) })
      if (outcome instanceof Skip) test.skip(true, outcome.message)
      if (outcome) throw outcome
    })
  }
})
