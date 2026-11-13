import { z } from 'zod'
import type { Turn } from '../shared/types'
import { type ToolServer, text, untrusted } from './mcp-results'

/** Gui's own tools, by name, with their titles: the chat's earlier turns. Nothing here changes the project. */
export const APP_TOOL_TITLES = {
  chat_turns: "Read this chat's earlier messages",
} as const

export interface AppTools {
  /** This chat's turns before the running one, oldest first, in a few lines each */
  turns: (limit: number) => string
}

export function registerAppTools(server: ToolServer, app: AppTools) {
  server.registerTool(
    'chat_turns',
    {
      title: APP_TOOL_TITLES.chat_turns,
      description:
        "This chat's earlier requests, oldest first: what the user asked, how each message ended, whether they undid it, and the files it changed with lines added and removed. Covers messages from other agents and earlier chats too. Use it to summarize the work, e.g. for a pull request description.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Most recent messages (default 30)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
      const turns = app.turns(limit ?? 30)
      return turns ? untrusted('chat_turns', turns) : text('No earlier messages in this chat.')
    },
  )
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
