import { expect, mock, test } from 'bun:test'
import type { AgentId } from '../../src/shared/types'

// Opening a website asks the user first, which Gui can't make an agent whose own settings
// decide what it asks (Amp, fx, Kiro, OpenCode, Pi) do: such an agent isn't offered the
// website tool, nor told of it. Its own process: agents.ts needs Electron's `shell`, which
// other test files' Electron stubs leave out. Run by tests/ask-first.test.ts.

mock.module('electron', () => ({
  app: { getPath: () => '/nonexistent' },
  shell: { openExternal: async () => undefined },
}))

const { opensWebsites } = await import('../../src/main/agents')
const { sessionToolNames } = await import('../../src/main/mcp-server')
const { buildPrompt } = await import('../../src/main/prompt')

/** Gui's instructions, as the agent's first message carries them. */
const preamble = (agentId: AgentId) =>
  buildPrompt({
    text: 'Hi',
    selection: [],
    viewport: null,
    problems: [],
    preamble: true,
    tools: true,
    websites: opensWebsites(agentId),
    images: true,
    attachments: [],
  })
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')

test("an agent whose own settings decide what it asks isn't offered a website, nor told of one", () => {
  for (const agentId of ['amp', 'fx', 'kiro', 'opencode', 'pi'] as AgentId[]) {
    expect(opensWebsites(agentId)).toBe(false)
    const tools = sessionToolNames(false, opensWebsites(agentId))
    expect(tools).not.toContain('preview_open_website')
    expect(tools).toContain('preview_navigate')
    expect(preamble(agentId)).not.toContain('preview_open_website')
    expect(preamble(agentId)).toContain('preview_navigate')
  }
})

test('Claude, Codex and the agents Gui makes ask first still open websites', () => {
  for (const agentId of ['claude', 'codex', 'gemini'] as AgentId[]) {
    expect(opensWebsites(agentId)).toBe(true)
    expect(sessionToolNames(false, opensWebsites(agentId))).toContain('preview_open_website')
    expect(preamble(agentId)).toContain('preview_open_website')
  }
})
