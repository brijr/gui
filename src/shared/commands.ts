import type { AgentCommand } from './types'

/** More than any agent offers; keeps a malformed list from flooding the menu and history. */
const MAX_COMMANDS = 500

/**
 * The commands an ACP `available_commands_update` lists, as Gui keeps them: names without
 * a slash or spaces (what's typed after `/` is matched against them), first of each name
 * kept. Anything malformed is skipped rather than failing the whole list. Also checks
 * lists read back from chat history.
 */
export function parseCommands(available: unknown): AgentCommand[] {
  if (!Array.isArray(available)) return []
  const commands = new Map<string, AgentCommand>()
  for (const command of available as unknown[]) {
    if (commands.size >= MAX_COMMANDS) break
    if (!command || typeof command !== 'object') continue
    const { name, description, input, hint } = command as Record<string, unknown>
    if (typeof name !== 'string') continue
    const bare = name.replace(/^\//, '')
    if (!bare || /\s/.test(bare) || commands.has(bare)) continue
    // ACP puts the hint in `input`; Gui's own copy (history) keeps it flat.
    const inputHint =
      input && typeof input === 'object' ? (input as Record<string, unknown>).hint : hint
    commands.set(bare, {
      name: bare,
      description: typeof description === 'string' ? description.trim() : '',
      hint: typeof inputHint === 'string' ? inputHint.trim() || null : null,
    })
  }
  return [...commands.values()]
}

/** `/name rest` → `name`, when the message starts with a slash and a word. */
export function commandWord(text: string): string | null {
  return /^\/(\S+)/.exec(text.trimStart())?.[1] ?? null
}

/**
 * The command a message invokes: one of the agent's slash commands, named right at its
 * start. Anything else that starts with a slash (a path, a command the agent doesn't have)
 * is an ordinary message, and so is one naming a skill (`$name`, "Use the … skill").
 */
export function invokedCommand(text: string, commands: AgentCommand[]): AgentCommand | null {
  const word = commandWord(text)
  if (word === null) return null
  return (
    commands.find((command) => command.name === word && commandKind(command) === 'slash') ?? null
  )
}

/**
 * How a command is written into the message: `/name` at its start, a `$name` mention where
 * it's typed (Codex's skills), or the skill named in plain words (OpenCode's and fx's).
 */
export type CommandKind = 'slash' | 'mention' | 'words'

export function commandKind(command: AgentCommand): CommandKind {
  if (command.skill) return 'words'
  return command.name.startsWith('$') ? 'mention' : 'slash'
}

/** The command as the menu shows it: as it's typed. */
export function commandLabel(command: AgentCommand): string {
  return commandKind(command) === 'slash' ? `/${command.name}` : command.name
}

/**
 * Commands an agent runs on the session itself rather than as a request to the model.
 * They have no use for the picked element or images, and some refuse to run with them
 * (Muse's /rename and /status, Claude Code's /context), so they go alone. Every other
 * command (skills, prompts, /review) takes the message's context along.
 */
const SESSION_COMMANDS = new Set([
  'autocompact',
  'changelog',
  'clear',
  'compact',
  'context',
  'cost',
  'exit',
  'export',
  'extra-usage',
  'follow-up',
  'heapdump',
  'help',
  'login',
  'logout',
  'mcp',
  'model',
  'models',
  'name',
  'new',
  'quit',
  'rename',
  'resume',
  'session',
  'skills',
  'status',
  'steering',
  'usage',
])

/** Whether a command goes with the picked element, images and recordings. */
export const takesContext = (command: AgentCommand) =>
  !SESSION_COMMANDS.has(command.name.toLowerCase())

/** A `/` being typed: what follows it so far, and where `/query` sits in the message. */
export interface CommandQuery {
  query: string
  start: number
  end: number
}

/**
 * The `/query` the caret is at the end of, anywhere in the message: the slash starts the
 * message or follows whitespace, and the query runs to the caret with no space or slash
 * (so not a URL, a path, or the middle of a word). Null when there's none.
 */
export function commandQuery(text: string, caret = text.length): CommandQuery | null {
  const after = text.slice(caret)
  if (after && !/^\s/.test(after)) return null
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(text.slice(0, caret))
  if (!match) return null
  const query = match[1] ?? ''
  return { query, start: caret - query.length - 1, end: caret }
}

/**
 * The message with `command` chosen for the `/query` at `at`, and where the caret goes.
 * A slash command moves to the front, since agents only run one that opens the message,
 * and the rest of the message becomes its input. A `$name` mention or a skill named in
 * words goes where the query was.
 */
export function insertCommand(
  text: string,
  at: CommandQuery,
  command: AgentCommand,
): { text: string; caret: number } {
  const before = text.slice(0, at.start)
  const after = text.slice(at.end)
  const kind = commandKind(command)
  if (kind === 'slash') {
    const head = `/${command.name} `
    const left = before.trim()
    const right = after.trimStart()
    const gap = left && right ? ' ' : ''
    return {
      text: `${head}${left}${gap}${right}`,
      caret: head.length + left.length + gap.length,
    }
  }
  if (kind === 'mention') {
    const word = `${command.name}${/^\s/.test(after) ? '' : ' '}`
    return { text: `${before}${word}${after}`, caret: before.length + word.length }
  }
  const sentence = `Use the ${command.name} skill`
  const left = before.trimEnd().replace(/,$/, '')
  const right = after.trimStart()
  const lead = left.trim()
    ? `${left}${/[.!?:;]$/.test(left) ? '' : '.'} ${sentence}. `
    : `${sentence} `
  return { text: `${lead}${right}`, caret: lead.length }
}

/**
 * Commands for the menu, given what's typed after the slash: names starting with it
 * first, then names containing it, then descriptions containing it (from two letters
 * on, as nearly every description has any one letter), each in the agent's order.
 */
export function filterCommands(commands: AgentCommand[], query: string): AgentCommand[] {
  // Codex's `$name` skills match without their `$`, typed or not.
  const q = query.replace(/^\$/, '').toLowerCase()
  if (!q) return commands
  const starts: AgentCommand[] = []
  const named: AgentCommand[] = []
  const described: AgentCommand[] = []
  for (const command of commands) {
    const name = command.name.replace(/^\$/, '').toLowerCase()
    if (name.startsWith(q)) starts.push(command)
    else if (name.includes(q)) named.push(command)
    else if (q.length > 1 && command.description.toLowerCase().includes(q)) {
      described.push(command)
    }
  }
  return [...starts, ...named, ...described]
}
