import { constants } from 'node:fs'
import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { app, type MenuItemConstructorOptions, shell } from 'electron'
import {
  AGENTS,
  type AgentHealth,
  type AgentId,
  type AgentInfo,
  CUSTOM_AGENT_PREFIX,
} from '../shared/types'
import { getShellEnv } from './shell-env'

const require = createRequire(import.meta.url)

export type AgentLaunch =
  /** An ACP adapter package bundled with Grat, run on Electron's Node */
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
  /** Grat can run this agent's ACP sign-in flow itself (it opens the browser) */
  inAppSignIn: boolean
}

export interface AgentListing {
  agents: (AgentInfo & { command: string | null; installed: boolean })[]
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

/**
 * codex-acp otherwise launches `process.execPath codex.js`, which in a packaged app
 * is Grat itself, so point it at Codex's native binary.
 */
function codexBinary() {
  const fromCodex = createRequire(require.resolve('@openai/codex/package.json'))
  const pkg = dirname(
    fromCodex.resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`),
  )
  const triple = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
  return join(pkg, 'vendor', triple, 'bin', 'codex').replace('app.asar', 'app.asar.unpacked')
}

const LAUNCH: Record<string, Omit<AgentDefinition, keyof AgentInfo>> = {
  claude: {
    launch: adapter('@agentclientprotocol/claude-agent-acp'),
    signIn: 'Run `claude` in a terminal and use /login, then try again.',
    inAppSignIn: true,
  },
  codex: {
    launch: adapter('@agentclientprotocol/codex-acp', {
      env: () => ({ CODEX_PATH: codexBinary() }),
    }),
    signIn: 'Sign in with ChatGPT from the Grat start screen, or run `codex login`.',
    inAppSignIn: true,
  },
  grok: {
    launch: cli('grok', 'agent', 'stdio'),
    signIn: 'Run `grok login` in a terminal, then try again.',
    inAppSignIn: false,
  },
  kiro: {
    launch: cli('kiro-cli', 'acp'),
    signIn: 'Run `kiro-cli login` in a terminal, then try again.',
    inAppSignIn: false,
  },
  opencode: {
    launch: cli('opencode', 'acp'),
    signIn: 'Run `opencode auth login` in a terminal, then try again.',
    inAppSignIn: false,
  },
  pi: {
    // pi has no ACP mode of its own; the bundled adapter drives `pi --mode rpc`.
    launch: adapter('pi-acp', { requires: 'pi' }),
    signIn: 'Run `pi` in a terminal and use /login (or set a provider API key), then try again.',
    inAppSignIn: false,
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
    [...BUILT_IN, ...custom.agents].map(async ({ id, name, launch }) => {
      const command = launch.kind === 'command' ? launch.command : (launch.requires ?? null)
      const installed = command === null || (await findExecutable(command, env.PATH)) !== null
      return { id, name, command, installed }
    }),
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
    // A relative PATH entry would resolve against Grat's cwd, not the project's.
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
  // The current agent stays listed even if it was uninstalled, so the selection is visible.
  const listed = (agent: AgentHealth) => agent.status !== 'not-installed' || agent.id === current
  const isCustom = (agent: AgentHealth) => agent.id.startsWith(CUSTOM_AGENT_PREFIX)
  const builtIn = agents.filter((agent) => listed(agent) && !isCustom(agent))
  const custom = agents.filter((agent) => listed(agent) && isCustom(agent))
  const missing = agents.filter((agent) => !listed(agent))

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
  items.push({ label: 'Custom Agents…', click: () => void openCustomAgents() })
  return items
}
