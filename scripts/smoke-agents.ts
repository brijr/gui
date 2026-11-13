// `bun run smoke:agents [agent ...]`: one real turn per installed, signed-in agent, to check
// it still works with Gui (smoke/agents.spec.ts). Prints a table; exits 1 if any agent that is
// installed and signed in fails. Agents that aren't are skipped.
//
// GUI_SMOKE_FAKE=grok=pass,kiro=hang runs fake agents instead (smoke/fake-agent.ts), for
// working on the test itself without spending anything.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { formatTable, readResults } from '../smoke/results'
import { AGENTS, type AgentId, agentName } from '../src/shared/types'

const root = resolve(import.meta.dirname, '..')
const ids = process.argv.slice(2)
const unknown = ids.filter((id) => !AGENTS.some((agent) => agent.id === id))
if (unknown.length) {
  console.error(
    `Unknown agent: ${unknown.join(', ')}. Pick from ${AGENTS.map((a) => a.id).join(', ')}.`,
  )
  process.exit(2)
}
const fake = process.env.GUI_SMOKE_FAKE
if (fake) console.log(`Fake agents (${fake}); no real agent runs.`)
else {
  console.warn(
    '⚠ This sends one real prompt to each installed, signed-in agent, using your paid agent usage.',
  )
}

const dir = mkdtempSync(join(tmpdir(), 'gui-smoke-'))
const results = join(dir, 'results.jsonl')
const env: Record<string, string | undefined> = {
  ...process.env,
  GUI_SMOKE: '1',
  GUI_SMOKE_AGENTS: ids.join(','),
  GUI_SMOKE_RESULTS: results,
  // Gui stays out of sight and behind the window you're in.
  GUI_E2E_HIDDEN: process.env.GUI_E2E_HIDDEN ?? '1',
}
delete env.ELECTRON_RUN_AS_NODE

const run = (command: string, args: string[]) =>
  spawnSync(command, args, { cwd: root, env, stdio: 'inherit' }).status ?? 1

if (run('bun', ['run', 'build']) !== 0) process.exit(1)
run('bunx', ['playwright', 'test', '-c', 'smoke/playwright.config.ts'])

// An agent the run never reported on (Playwright stopped first) counts as failed.
const recorded = readResults(results)
const wanted: AgentId[] = ids.length
  ? (ids as AgentId[])
  : fake
    ? recorded.map((result) => result.agent)
    : AGENTS.map((agent) => agent.id)
const rows = wanted.map(
  (id) =>
    recorded.find((result) => result.agent === id) ?? {
      agent: id,
      name: agentName(id),
      installed: null,
      result: 'fail' as const,
      seconds: 0,
      reason: 'No result; see the Playwright output above',
      version: null,
      model: null,
      tools: [],
      titleInReply: null,
    },
)
rmSync(dir, { recursive: true, force: true })

console.log(`\nAgent smoke test\n\n${formatTable(rows)}\n`)
const failed = rows.filter((row) => row.result === 'fail')
console.log(
  failed.length
    ? `${failed.length} failed. Report: bunx playwright show-report playwright-report/smoke`
    : 'No failures.',
)
process.exit(failed.length ? 1 : 0)
