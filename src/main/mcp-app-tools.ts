import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Proposal, ShipDraft, ShipInfo, Turn } from '../shared/types'
import { failure, text, untrusted } from './mcp-results'

/**
 * Tool names for Gui itself: where the project's changes stand, the chat's earlier turns,
 * and proposing a commit or pull request. Nothing here changes the project: a proposal
 * only fills in the Source Control sheet, and the user ships it.
 */
export const APP_TOOL_NAMES = [
  'source_control_status',
  'source_control_propose',
  'chat_turns',
] as const

export interface AppTools {
  /** Branch, changes and pull request in a few lines, or why Gui can't tell */
  sourceControlStatus: () => Promise<string>
  /** Keeps the draft to open in the Source Control sheet once the turn ends; what happens */
  proposeShip: (draft: ShipDraft) => string
  /** This chat's turns before the running one, oldest first, in a few lines each */
  turns: (limit: number) => string
}

export function registerAppTools(server: McpServer, app: AppTools) {
  server.registerTool(
    'source_control_status',
    {
      title: 'Check source control',
      description:
        "Where the user's changes stand in Git: the current and default branch, uncommitted files (secret-looking files are listed as skipped and never committed), commits not pushed yet, the remote, and this branch's pull request with its review state. Read it before proposing a commit or pull request.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return untrusted('source_control_status', await app.sourceControlStatus())
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.registerTool(
    'source_control_propose',
    {
      title: 'Propose a commit or pull request',
      description:
        'When the user asks to commit, save, ship, push or open a pull request, propose it with this instead of running git yourself. When your turn ends, Gui opens its Source Control sheet filled in with your title, description, branch and files; the user reviews it and commits or opens the pull request with one click. `share` pushes and opens a pull request (or updates the open one); `commit` saves a local commit only. Omit `branch` to let Gui choose (a new branch when on the default one) and `files` to include every changed file. Write the title as a short summary of the change and the description as a few bullets of what changed and why.',
      inputSchema: {
        mode: z
          .enum(['share', 'commit'])
          .describe('Push and open a pull request, or commit locally'),
        title: z.string().min(1).max(200).describe('Commit and pull request title'),
        body: z.string().max(5000).describe('Pull request description, or the commit body'),
        branch: z.string().min(1).max(200).optional().describe('Branch to commit on'),
        files: z
          .array(z.string().min(1).max(1000))
          .max(1000)
          .optional()
          .describe('Repository-relative paths of the changed files to include'),
      },
    },
    async ({ mode, title, body, branch, files }) => {
      try {
        return text(app.proposeShip({ mode, title, body, branch, files }))
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

/** source_control_status: what the Source Control sheet and the bar over it would show. */
export function describeSourceControl(info: ShipInfo, proposal: Proposal | null): string {
  const lines: string[] = []
  if (info.blocked) lines.push(`Can't commit right now: ${info.blocked}`)
  const onDefault = info.onDefaultBranch ? ' (the default branch)' : ''
  lines.push(`Branch: ${info.branch ?? '(detached)'}${onDefault}`)
  if (proposal?.defaultBranch) lines.push(`Default branch: ${proposal.defaultBranch}`)
  lines.push(
    info.remote
      ? `Remote: ${info.remote.repo} (${info.remote.host})`
      : 'Remote: none; commits stay local',
  )
  lines.push(
    info.files.length ? `Changed files (${info.files.length}):` : 'No uncommitted changes.',
  )
  for (const file of info.files.slice(0, 200)) lines.push(`- ${file.status} ${file.path}`)
  if (info.files.length > 200) lines.push(`- …and ${info.files.length - 200} more`)
  if (info.skipped.length) lines.push(`Skipped as possible secrets: ${info.skipped.join(', ')}`)
  if (proposal?.ahead) lines.push(`Commits not pushed yet: ${proposal.ahead}`)
  else if (info.pendingCommits) lines.push('There are commits not pushed yet.')
  if (proposal?.behind) lines.push(`Behind the default branch by ${proposal.behind} commits`)
  if (proposal?.merge)
    lines.push(`Merge in progress; conflicts in: ${proposal.merge.files.join(', ')}`)
  const pull = proposal?.pull
  if (pull) {
    const review =
      pull.review === 'approved'
        ? ', approved'
        : pull.review === 'changes'
          ? ', changes requested'
          : ''
    lines.push(`Pull request #${pull.number} (${pull.state}${review}): ${pull.title} ${pull.url}`)
    if (pull.comments.length) lines.push(`${pull.comments.length} review comments`)
  } else if (proposal) {
    lines.push('No pull request for this branch.')
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
