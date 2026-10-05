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
 * The command a message invokes: one the agent offers, named right at its start. Anything
 * else that starts with a slash (a path, a command the agent doesn't have) is an ordinary
 * message.
 */
export function invokedCommand(text: string, commands: AgentCommand[]): AgentCommand | null {
  const word = commandWord(text)
  return word === null ? null : (commands.find((command) => command.name === word) ?? null)
}

/**
 * Commands for the menu, given what's typed after the slash: names starting with it
 * first, then names containing it, then descriptions containing it (from two letters
 * on, as nearly every description has any one letter), each in the agent's order.
 */
export function filterCommands(commands: AgentCommand[], query: string): AgentCommand[] {
  const q = query.toLowerCase()
  if (!q) return commands
  const starts: AgentCommand[] = []
  const named: AgentCommand[] = []
  const described: AgentCommand[] = []
  for (const command of commands) {
    const name = command.name.toLowerCase()
    if (name.startsWith(q)) starts.push(command)
    else if (name.includes(q)) named.push(command)
    else if (q.length > 1 && command.description.toLowerCase().includes(q)) {
      described.push(command)
    }
  }
  return [...starts, ...named, ...described]
}
