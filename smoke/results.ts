import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import type { AgentId } from '../src/shared/types'

/** One agent's smoke run, as the spec records it and `bun run smoke:agents` prints it. */
export interface SmokeResult {
  agent: AgentId
  name: string
  /** Null when the run stopped before Gui said */
  installed: boolean | null
  result: 'pass' | 'fail' | 'skipped'
  seconds: number
  /** Why it failed or was skipped */
  reason: string | null
  /** The CLI version Gui ran, when it says */
  version: string | null
  /** The model the turn asked for, when the agent offers a choice */
  model: string | null
  /** Gui tools the agent called, in order */
  tools: string[]
  /** The reply named the page's title: reported, but not required to pass */
  titleInReply: boolean | null
}

export function recordResult(file: string | undefined, result: SmokeResult) {
  if (file) appendFileSync(file, `${JSON.stringify(result)}\n`)
}

export function readResults(file: string): SmokeResult[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SmokeResult)
}

const cell = (value: string, width: number) => value.padEnd(width)

/** The results as a plain-text table, one row per agent. */
export function formatTable(results: SmokeResult[]): string {
  const rows = results.map((r) => [
    r.version ? `${r.name} ${r.version}` : r.name,
    r.installed === null ? '?' : r.installed ? 'yes' : 'no',
    r.result.toUpperCase(),
    `${r.seconds.toFixed(0)}s`,
    r.model ?? '',
    r.tools.length ? [...new Set(r.tools)].join(', ') : '',
    r.titleInReply === null ? '' : r.titleInReply ? 'yes' : 'no',
    r.reason ?? '',
  ])
  const header = ['Agent', 'Installed', 'Result', 'Time', 'Model', 'Gui tools', 'Title', 'Reason']
  const widths = header.map((title, column) =>
    // The reason runs to the end of the line.
    column === header.length - 1
      ? 0
      : Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  )
  const line = (row: string[]) =>
    row
      .map((value, column) => cell(value, widths[column] ?? 0))
      .join('  ')
      .trimEnd()
  return [
    line(header),
    line(widths.map((width) => '-'.repeat(width || 6))),
    ...rows.map(line),
  ].join('\n')
}
