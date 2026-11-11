import { expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AgentDefinition } from '../src/main/agents'

// Opening a website can carry data out in its address, so the user decides every call:
// Claude isn't allowed the website tools up front and keeps asking about them in its own Auto
// mode, and Gui never answers a request for one by itself, whichever agent sends it.

const { sessionMeta } = await import('../src/main/session-meta')
const { asksFirst } = await import('../src/main/chat-tools')

const claude = { id: 'claude', permissions: undefined } as unknown as AgentDefinition

test("Claude may call Gui's tools without asking, but never the ones that open websites", () => {
  const meta = sessionMeta(claude, 'auto') as {
    claudeCode: {
      options: { allowedTools: string[]; settings: { permissions: { ask: string[] } } }
    }
  }
  const { allowedTools, settings } = meta.claudeCode.options
  expect(allowedTools).toContain('mcp__gui__preview_navigate')
  expect(allowedTools).toContain('mcp__gui__preview_click')
  expect(allowedTools).not.toContain('mcp__gui__preview_open_website')
  expect(allowedTools).not.toContain('mcp__gui__canvas_screenshot_url')
  expect(settings.permissions.ask.sort()).toEqual([
    'mcp__gui__canvas_screenshot_url',
    'mcp__gui__preview_open_website',
  ])
})

test('Gui leaves a request to open a website to the user, by its title or its call', () => {
  expect(asksFirst('claude', { title: 'mcp__gui__preview_open_website' }, undefined)).toBe(true)
  expect(asksFirst('claude', { title: 'mcp__gui__preview_navigate' }, undefined)).toBe(false)
  expect(asksFirst('gemini', { title: 'gui.preview_open_website' }, undefined)).toBe(true)
  // A shell command that merely names the tool is never taken for it.
  expect(
    asksFirst('gemini', { title: 'mcp__gui__preview_open_website', kind: 'execute' }, undefined),
  ).toBe(false)
  // codex-acp asks with no title: the call it's about carries the tool's label.
  expect(
    asksFirst(
      'codex',
      { title: null },
      { title: 'Open a website in the preview', toolKind: 'preview' },
    ),
  ).toBe(true)
  expect(
    asksFirst(
      'codex',
      { title: null },
      { title: 'Open a page in the preview', toolKind: 'preview' },
    ),
  ).toBe(false)
  // A command the model titled like the label isn't one of Gui's tools.
  expect(
    asksFirst(
      'codex',
      { title: null },
      { title: 'Open a website in the preview', toolKind: 'execute' },
    ),
  ).toBe(false)
})

test("agents Gui can't make ask first aren't offered a website, in their own process", async () => {
  const file = join(import.meta.dirname, 'fast', 'agent-websites.ts')
  const result = await promisify(execFile)(process.execPath, ['test', file]).catch(
    (error: { stdout: string; stderr: string }) => error,
  )
  // The whole report, so a failure in there is shown here.
  const report = `${result.stdout}${result.stderr}`
  expect(report).toContain('\n 0 fail\n')
  expect(report).toMatch(/\n 2 pass\n/)
}, 10_000)
