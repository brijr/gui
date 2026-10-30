import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Turn, Version } from '../shared/types'
import { failure, text, untrusted } from './mcp-results'

/**
 * Tool names for Gui itself: the chat's saved versions and its earlier turns. Nothing here
 * changes the project.
 */
export const APP_TOOL_NAMES = ['versions_list', 'chat_turns'] as const

export interface AppTools {
  /** This chat's versions, newest first, in a few lines each */
  versions: (limit: number) => Promise<string>
  /** This chat's turns before the running one, oldest first, in a few lines each */
  turns: (limit: number) => string
}

export function registerAppTools(server: McpServer, app: AppTools) {
  server.registerTool(
    'versions_list',
    {
      title: 'List versions',
      description:
        "This chat's versions of the project's files, newest first: the automatic version at each finished turn's end, versions the user named, and states Gui saved just before a restore. Each entry gives its ID, kind, time, whether the files match it now, and the files it changed. Use it to find an earlier state or tell the user which version to restore in Gui's Versions sheet, where how the files are now is saved first. This only lists versions; it does not restore anything, and the running turn's version appears when it finishes.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Most recent versions (default 30)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      try {
        const versions = await app.versions(limit ?? 30)
        return versions
          ? untrusted('versions_list', versions)
          : text('No versions yet in this chat.')
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'chat_turns',
    {
      title: "Read this chat's earlier turns",
      description:
        "This chat's earlier requests, oldest first: what the user asked, how each turn ended, whether they undid it, and the files it changed with lines added and removed. Covers turns from other agents and earlier sessions too. Use it to summarize the work, e.g. for a pull request description.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Most recent turns (default 30)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const turns = app.turns(limit ?? 30)
      return turns ? untrusted('chat_turns', turns) : text('No earlier turns in this chat.')
    },
  )
}

/** Changed files listed under one version before the rest are summarized. */
const VERSION_FILE_LIMIT = 20

/** versions_list: the newest `limit` versions, in the order Gui gives them (newest first). */
export function describeVersions(versions: Version[], limit: number, turnRunning = false): string {
  const shown = versions.slice(0, limit)
  if (shown.length === 0) return ''
  const lines = [
    `Versions (${versions.length}, newest first${shown.length < versions.length ? `; showing ${shown.length}` : ''}):`,
  ]
  if (turnRunning) lines.push("The current turn's version will appear when it finishes.")
  for (const version of shown) {
    const name = version.name.replace(/\s+/g, ' ').trim()
    lines.push(
      `- id: ${version.id}; kind: ${version.kind}; current: ${version.current ? 'yes' : 'no'}${
        version.reverted ? '; undone: yes' : ''
      }; created: ${new Date(version.createdAt).toISOString()}; name: ${name}`,
    )
    if (version.changes === null) {
      lines.push('  changes: not recorded')
    } else if (version.changes.length === 0) {
      lines.push('  changes: none recorded')
    } else {
      const additions = version.changes.reduce((sum, change) => sum + change.additions, 0)
      const deletions = version.changes.reduce((sum, change) => sum + change.deletions, 0)
      lines.push(
        `  changes: ${version.changes.length} ${version.changes.length === 1 ? 'file' : 'files'} (+${additions} -${deletions})`,
      )
      for (const change of version.changes.slice(0, VERSION_FILE_LIMIT)) {
        lines.push(
          `   - ${change.status} ${change.path} (+${change.additions} -${change.deletions})`,
        )
      }
      if (version.changes.length > VERSION_FILE_LIMIT) {
        lines.push(`   - …and ${version.changes.length - VERSION_FILE_LIMIT} more`)
      }
    }
  }
  return lines.join('\n')
}

const STATUS = { done: 'done', cancelled: 'stopped', error: 'failed', running: 'running' } as const

/** chat_turns: the last `limit` finished turns, oldest first; empty when there are none. */
export function describeTurns(turns: Turn[], limit: number): string {
  const finished = turns.filter((turn) => turn.status !== 'running').slice(-limit)
  return finished
    .map((turn) => {
      const prompt = turn.prompt.replace(/\s+/g, ' ').trim()
      const head = `${turn.index + 1}. [${STATUS[turn.status]}${turn.reverted ? ', undone' : ''}] ${prompt.length > 300 ? `${prompt.slice(0, 300)}…` : prompt}`
      const changes = (turn.changes ?? []).map(
        (change) =>
          `   - ${change.status} ${change.path} (+${change.additions} -${change.deletions})`,
      )
      if (!changes.length && turn.changesUnknown) changes.push('   - (changes not recorded)')
      return [head, ...changes].join('\n')
    })
    .join('\n')
}
