import { constants } from 'node:fs'
import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { app, type MenuItemConstructorOptions, shell } from 'electron'
import {
  AGENTS,
  type AgentHealth,
  type AgentId,
  type AgentInfo,
  CUSTOM_AGENT_PREFIX,
  type CustomAgentEntry,
} from '../shared/types'
import { getShellEnv } from './shell-env'

export type AgentLaunch =
  /** An ACP adapter package bundled with Gui, run on Electron's Node */
  | {
      kind: 'adapter'
      package: string
      env?: () => Record<string, string>
      /** A CLI the adapter drives, which must be on the user's PATH */
      requires?: string
    }
  /** An agent CLI the user installed, found on their login-shell PATH */
  | { kind: 'command'; command: string; args: string[]; env: Record<string, string> }

export interface AgentDefinition extends AgentInfo {
  launch: AgentLaunch
  /** How to sign in, shown when the agent reports the user isn't signed in */
  signIn: string | null
  /** Gui can run this agent's ACP sign-in flow itself (it opens the browser) */
  inAppSignIn: boolean
  /** Official install page, for agents the user installs themselves */
  installUrl?: string
  /** Sign-in Gui can start in Terminal: the command, and what to do once it runs */
  terminalSignIn?: { command: string; hint: string }
}

export interface AgentListing {
  agents: (AgentInfo & {
    command: string | null
    installed: boolean
    installUrl: string | null
    terminalSignIn: AgentDefinition['terminalSignIn'] | null
  })[]
  /** Why agents.json couldn't be read, if it couldn't */
  customError: string | null
}

const adapter = (
  pkg: string,
  options: { env?: () => Record<string, string>; requires?: string } = {},
): AgentLaunch => ({ kind: 'adapter', package: pkg, ...options })
const cli = (command: string, ...args: string[]): AgentLaunch => ({
  kind: 'command',
  command,
  args,
  env: {},
})

const LAUNCH: Record<string, Omit<AgentDefinition, keyof AgentInfo>> = {
  claude: {
    launch: adapter('@agentclientprotocol/claude-agent-acp'),
    signIn: 'Run `claude` in a terminal and use /login, then try again.',
    inAppSignIn: true,
  },
  codex: {
    // Its CLI path (CODEX_PATH) comes from agent-binaries.ts, like Claude Code's.
    launch: adapter('@agentclientprotocol/codex-acp'),
    signIn: 'Sign in with ChatGPT from the Gui start screen, or run `codex login`.',
    inAppSignIn: true,
  },
  grok: {
    launch: cli('grok', 'agent', 'stdio'),
    signIn: 'Sign in from Settings → Agents, or run `grok login` in a terminal.',
    inAppSignIn: false,
    installUrl: 'https://x.ai/build',
    terminalSignIn: { command: 'grok login', hint: 'Finish signing in in your browser.' },
  },
  kiro: {
    launch: cli('kiro-cli', 'acp'),
    signIn: 'Sign in from Settings → Agents, or run `kiro-cli login` in a terminal.',
    inAppSignIn: false,
    installUrl: 'https://kiro.dev/docs/cli/',
    terminalSignIn: {
      command: 'kiro-cli login',
      hint: 'Pick how you sign in, then follow the steps.',
    },
  },
  opencode: {
    launch: cli('opencode', 'acp'),
    signIn: 'Sign in from Settings → Agents, or run `opencode auth login` in a terminal.',
    inAppSignIn: false,
    installUrl: 'https://opencode.ai/docs/',
    terminalSignIn: {
      command: 'opencode auth login',
      hint: 'Pick a provider, then follow the steps.',
    },
  },
  pi: {
    // pi has no ACP mode of its own; the bundled adapter drives `pi --mode rpc`.
    launch: adapter('pi-acp', { requires: 'pi' }),
    signIn: 'Sign in from Settings → Agents, or run `pi` in a terminal and use /login.',
    inAppSignIn: false,
    installUrl: 'https://pi.dev',
    terminalSignIn: {
      command: 'pi',
      hint: 'Type /login and pick a provider. When you are signed in, quit pi and close this window.',
    },
  },
  muse: {
    // Muse Code speaks its own session protocol; the bundled adapter (built on Meta's
    // Muse Code SDK) drives the user's `muse`.
    launch: adapter('@bex-co/muse-code-acp', { requires: 'muse' }),
    signIn: 'Sign in from Settings → Agents, or run `muse login` in a terminal.',
    inAppSignIn: false,
    installUrl: 'https://dev.meta.ai/docs/muse-code/',
    terminalSignIn: { command: 'muse login', hint: 'Follow the steps to sign in.' },
  },
}

const BUILT_IN: readonly AgentDefinition[] = AGENTS.map((agent) => ({
  ...agent,
  ...LAUNCH[agent.id],
}))

const customFile = () => join(app.getPath('userData'), 'agents.json')

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')
const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === 'string')

/**
 * Agents the user added to agents.json, in the same shape as Zed's `agent_servers`
 * (pasting Zed's whole `{ "agent_servers": { … } }` block works too):
 * `{ "My Agent": { "command": "my-agent", "args": ["--acp"], "env": {} } }`.
 * Read fresh each time, so edits apply to the next session without a restart.
 */
async function loadCustomAgents(): Promise<{ agents: AgentDefinition[]; error: string | null }> {
  let text: string
  try {
    text = await readFile(customFile(), 'utf8')
  } catch {
    return { agents: [], error: null }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { agents: [], error: error instanceof Error ? error.message : String(error) }
  }
  if (isRecord(parsed) && isRecord(parsed.agent_servers)) parsed = parsed.agent_servers
  if (!isRecord(parsed)) return { agents: [], error: 'Expected an object of agents by name.' }

  const agents: AgentDefinition[] = []
  const invalid: string[] = []
  for (const [name, entry] of Object.entries(parsed)) {
    if (
      !name.trim() ||
      !isRecord(entry) ||
      typeof entry.command !== 'string' ||
      !entry.command.trim() ||
      (entry.args !== undefined && !isStringArray(entry.args)) ||
      (entry.env !== undefined && !isStringRecord(entry.env))
    ) {
      invalid.push(name.trim() || '(unnamed)')
      continue
    }
    agents.push({
      id: `${CUSTOM_AGENT_PREFIX}${name}`,
      name,
      launch: {
        kind: 'command',
        command: entry.command,
        args: (entry.args as string[] | undefined) ?? [],
        env: (entry.env as Record<string, string> | undefined) ?? {},
      },
      signIn: null,
      inAppSignIn: false,
    })
  }
  const error = invalid.length
    ? `${invalid.join(', ')}: each agent needs a "command" string; "args" and "env" must hold strings.`
    : null
  return { agents, error }
}

/** Custom agents as Settings edits them. */
export async function customAgentEntries(): Promise<{
  entries: CustomAgentEntry[]
  error: string | null
}> {
  const { agents, error } = await loadCustomAgents()
  const entries = agents.flatMap(({ name, launch }) =>
    launch.kind === 'command'
      ? [{ name, command: launch.command, args: launch.args, env: launch.env }]
      : [],
  )
  return { entries, error }
}

/** agents.json as parsed, and the object holding the agents (Zed's wrapper or the top level). */
async function readCustomFile() {
  let text: string
  try {
    text = await readFile(customFile(), 'utf8')
  } catch {
    const root: Record<string, unknown> = {}
    return { root, servers: root }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("agents.json isn't valid JSON. Fix it with Edit agents.json first.")
  }
  if (!isRecord(parsed)) {
    throw new Error('agents.json should hold an object of agents by name. Fix it first.')
  }
  return { root: parsed, servers: isRecord(parsed.agent_servers) ? parsed.agent_servers : parsed }
}

async function writeCustomFile(
  { root, servers }: Awaited<ReturnType<typeof readCustomFile>>,
  next: Record<string, unknown>,
) {
  const data = servers === root ? next : { ...root, agent_servers: next }
  await writeFile(customFile(), `${JSON.stringify(data, null, 2)}\n`)
}

/**
 * Adds a custom agent, or replaces (and possibly renames) `originalName`. Fields the
 * file has that Settings doesn't edit (like Zed's `type`) are kept.
 */
export async function saveCustomAgent(originalName: string | null, entry: CustomAgentEntry) {
  const name = entry.name.trim()
  const command = entry.command.trim()
  if (!name) throw new Error('Give the agent a name.')
  if (!command) throw new Error('Enter the command that starts the agent.')
  if (!isStringArray(entry.args) || !isStringRecord(entry.env)) {
    throw new Error('Arguments and environment values must be text.')
  }
  if (BUILT_IN.some((agent) => agent.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`${name} is a built-in agent. Pick another name.`)
  }
  const file = await readCustomFile()
  if (name !== originalName && name in file.servers) {
    throw new Error(`There's already an agent called ${name}.`)
  }
  const previous =
    originalName !== null && isRecord(file.servers[originalName]) ? file.servers[originalName] : {}
  const value = { ...previous, command, args: entry.args, env: entry.env }
  // Keep the agent's place in the file when it's edited or renamed.
  const next: Record<string, unknown> = {}
  let placed = false
  for (const [key, existing] of Object.entries(file.servers)) {
    if (key === originalName) {
      next[name] = value
      placed = true
    } else {
      next[key] = existing
    }
  }
  if (!placed) next[name] = value
  await writeCustomFile(file, next)
}

export async function deleteCustomAgent(name: string) {
  const file = await readCustomFile()
  if (!(name in file.servers)) return
  const next = Object.fromEntries(Object.entries(file.servers).filter(([key]) => key !== name))
  await writeCustomFile(file, next)
}

/** The agent's full definition; throws a message fit for the user when it can't be found. */
export async function resolveAgent(id: AgentId): Promise<AgentDefinition> {
  const builtIn = BUILT_IN.find((agent) => agent.id === id)
  if (builtIn) return builtIn
  if (!id.startsWith(CUSTOM_AGENT_PREFIX)) throw new Error(`Unknown agent: ${id}`)
  const { agents, error } = await loadCustomAgents()
  const custom = agents.find((agent) => agent.id === id)
  if (custom) return custom
  const name = id.slice(CUSTOM_AGENT_PREFIX.length)
  throw new Error(
    error
      ? `Couldn't read agents.json: ${error}`
      : `${name} is no longer in agents.json. Pick another agent or add it back.`,
  )
}

/** Every known agent, and whether its CLI can be found right now. */
export async function listAgents(): Promise<AgentListing> {
  const [custom, env] = await Promise.all([loadCustomAgents(), getShellEnv()])
  const agents = await Promise.all(
    [...BUILT_IN, ...custom.agents].map(
      async ({ id, name, launch, installUrl, terminalSignIn }) => {
        const command = launch.kind === 'command' ? launch.command : (launch.requires ?? null)
        const installed = command === null || (await findExecutable(command, env.PATH)) !== null
        return {
          id,
          name,
          command,
          installed,
          installUrl: installUrl ?? null,
          terminalSignIn: terminalSignIn ?? null,
        }
      },
    ),
  )
  return { agents, customError: custom.error }
}

async function isExecutableFile(path: string) {
  try {
    if (!(await stat(path)).isFile()) return false
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolves a bare command on PATH, or checks an absolute (or `~/`) path. */
export async function findExecutable(command: string, path: string | undefined) {
  const expanded = command.startsWith('~/') ? join(homedir(), command.slice(2)) : command
  if (expanded.includes('/')) {
    return isAbsolute(expanded) && (await isExecutableFile(expanded)) ? expanded : null
  }
  for (const dir of (path ?? '').split(delimiter)) {
    // A relative PATH entry would resolve against Gui's cwd, not the project's.
    if (!isAbsolute(dir)) continue
    const candidate = join(dir, expanded)
    if (await isExecutableFile(candidate)) return candidate
  }
  return null
}

/** Opens agents.json in the user's editor, creating an empty one first. */
export async function openCustomAgents() {
  const file = customFile()
  await writeFile(file, '{}\n', { flag: 'wx' }).catch(() => undefined)
  const error = await shell.openPath(file)
  if (error) shell.showItemInFolder(file)
}

/**
 * Agent picker items shared by the toolbar menu and the app menu. Agents whose CLI
 * isn't installed are listed (disabled) under their own submenu.
 */
export function agentMenuItems(
  agents: AgentHealth[],
  customError: string | null,
  current: AgentId | null,
  select: (id: AgentId) => void,
  openSettings: () => void,
): MenuItemConstructorOptions[] {
  const choice = (agent: AgentHealth): MenuItemConstructorOptions => ({
    label: agent.name,
    sublabel:
      agent.status === 'not-installed'
        ? 'Not installed'
        : agent.status === 'signed-out'
          ? 'Not signed in'
          : agent.status === 'error'
            ? 'Unavailable'
            : undefined,
    type: current === null ? 'normal' : 'radio',
    checked: agent.id === current,
    click: () => select(agent.id),
  })
  // Agents switched off in Settings are hidden. The current agent stays listed even if
  // it was switched off or uninstalled, so the selection is visible.
  const listed = (agent: AgentHealth) =>
    (agent.enabled && agent.status !== 'not-installed') || agent.id === current
  const isCustom = (agent: AgentHealth) => agent.id.startsWith(CUSTOM_AGENT_PREFIX)
  const builtIn = agents.filter((agent) => listed(agent) && !isCustom(agent))
  const custom = agents.filter((agent) => listed(agent) && isCustom(agent))
  const missing = agents.filter((agent) => !listed(agent) && agent.status === 'not-installed')

  const items: MenuItemConstructorOptions[] = builtIn.map(choice)
  if (custom.length || customError) {
    items.push({ type: 'separator' }, ...custom.map(choice))
    if (customError) {
      items.push({ label: 'agents.json has errors', sublabel: customError, enabled: false })
    }
  }
  items.push({ type: 'separator' })
  if (missing.length) {
    items.push({
      label: 'Not Installed',
      submenu: missing.map((agent) => ({
        label: agent.name,
        sublabel: agent.command ? `${agent.command} isn't on your PATH` : undefined,
        enabled: false,
      })),
    })
  }
  items.push({ label: 'Agent Settings…', click: openSettings })
  return items
}
