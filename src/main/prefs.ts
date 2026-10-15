import { EventEmitter } from 'node:events'
import { readFileSync, renameSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { app } from 'electron'
import { type AgentId, DEFAULT_AGENT_ID, isAgentId, type PanelCorner } from '../shared/types'
import { asidePath, writeFileAtomicSync } from './atomic-file'

export interface ChatSize {
  width: number
  height: number
}

export interface Prefs {
  agentId: AgentId
  /** The chat is the window's sidebar rather than a floating panel. */
  chatSidebar: boolean
  chatSidebarSide: 'left' | 'right'
  /** The floating chat panel's size, without its shadow margin; windows clamp it to fit */
  chatSize: ChatSize
  /** The sidebar's width */
  chatSidebarWidth: number
  /** The canvas corner the floating chat panel was last dropped in; new tabs start there */
  chatCorner: PanelCorner
  /** The app each monorepo previews: project root → app dir relative to it */
  apps: Record<string, string>
  /** Agents switched off in Settings; everything installed is on by default */
  disabledAgents: AgentId[]
  /** The model and effort the user chose per agent: agent → the agent's config id → value */
  agentSettings: Record<AgentId, Record<string, string>>
  /** Project roots the user switched Auto mode off for; every other project is in Auto (see ChatMeta.autoApprove) */
  askRoots: string[]
  /** Project roots where the user chose to work on the default branch rather than a Gui branch */
  defaultBranchRoots: string[]
  /** Installed copies send a report when Gui itself fails (crash-reports.ts) */
  crashReports: boolean
}

const DEFAULTS: Prefs = {
  agentId: DEFAULT_AGENT_ID,
  chatSidebar: false,
  chatSidebarSide: 'left',
  chatSize: { width: 360, height: 520 },
  chatSidebarWidth: 380,
  chatCorner: { x: 'left', y: 'bottom' },
  apps: {},
  disabledAgents: [],
  agentSettings: {},
  askRoots: [],
  defaultBranchRoots: [],
  crashReports: true,
}
/** Anything outside this isn't a size a window could have set. */
const MAX_LENGTH = 10_000
const file = () => join(app.getPath('userData'), 'prefs.json')
let cached: Prefs | null = null

export const prefsEvents = new EventEmitter<{ change: [prefs: Prefs] }>()
// Every open chat listens.
prefsEvents.setMaxListeners(0)

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

function agentSettings(value: unknown): Prefs['agentSettings'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([id]) => isAgentId(id))
      .map(([id, settings]) => [id, stringRecord(settings)]),
  )
}

/** Absolute paths, each once. */
function roots(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const paths = value.filter((path): path is string => typeof path === 'string' && isAbsolute(path))
  return [...new Set(paths)]
}

function length(value: unknown, fallback: number) {
  return typeof value === 'number' && value > 0 && value <= MAX_LENGTH
    ? Math.round(value)
    : fallback
}

/**
 * The floating panel's size before it shrank to today's default. Every saved prefs file has
 * a size, whether or not the user ever resized the panel, so this one reads as the default.
 */
const OLD_DEFAULT_CHAT_SIZE = { width: 400, height: 640 }

function chatSize(value: unknown): ChatSize {
  const size = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  if (size.width === OLD_DEFAULT_CHAT_SIZE.width && size.height === OLD_DEFAULT_CHAT_SIZE.height) {
    return { ...DEFAULTS.chatSize }
  }
  return {
    width: length(size.width, DEFAULTS.chatSize.width),
    height: length(size.height, DEFAULTS.chatSize.height),
  }
}

function chatCorner(value: unknown): PanelCorner {
  const corner = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    x: corner.x === 'left' || corner.x === 'right' ? corner.x : DEFAULTS.chatCorner.x,
    y: corner.y === 'top' || corner.y === 'bottom' ? corner.y : DEFAULTS.chatCorner.y,
  }
}

export function getPrefs(): Prefs {
  if (cached) return cached
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Prefs>
    cached = {
      agentId: isAgentId(parsed.agentId) ? parsed.agentId : DEFAULT_AGENT_ID,
      chatSidebar:
        typeof parsed.chatSidebar === 'boolean' ? parsed.chatSidebar : DEFAULTS.chatSidebar,
      chatSidebarSide: parsed.chatSidebarSide === 'right' ? 'right' : 'left',
      chatSize: chatSize(parsed.chatSize),
      chatSidebarWidth: length(parsed.chatSidebarWidth, DEFAULTS.chatSidebarWidth),
      chatCorner: chatCorner(parsed.chatCorner),
      apps: stringRecord(parsed.apps),
      disabledAgents: Array.isArray(parsed.disabledAgents)
        ? parsed.disabledAgents.filter(isAgentId)
        : [],
      agentSettings: agentSettings(parsed.agentSettings),
      askRoots: roots(parsed.askRoots),
      defaultBranchRoots: roots(parsed.defaultBranchRoots),
      crashReports:
        typeof parsed.crashReports === 'boolean' ? parsed.crashReports : DEFAULTS.crashReports,
    }
  } catch (error) {
    // A damaged file would otherwise be replaced by defaults on the next save, losing (among
    // the rest) which projects are in Ask mode. Keep it aside instead.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      const aside = asidePath(file())
      console.error(`[gui] unreadable preferences, moved to ${aside}`, error)
      try {
        renameSync(file(), aside)
      } catch {
        // Unreadable and immovable; the next save replaces it.
      }
    }
    cached = {
      ...DEFAULTS,
      chatSize: { ...DEFAULTS.chatSize },
      chatCorner: { ...DEFAULTS.chatCorner },
      apps: {},
      agentSettings: {},
    }
  }
  return cached
}

/** Called from IPC handlers, so a failed write is logged rather than thrown into the main process. */
export function setPrefs(patch: Partial<Prefs>) {
  cached = { ...getPrefs(), ...patch }
  try {
    writeFileAtomicSync(file(), JSON.stringify(cached, null, 2))
  } catch (error) {
    console.error('[gui] failed to save preferences', error)
  }
  prefsEvents.emit('change', cached)
}

export function isAgentEnabled(id: AgentId) {
  return !getPrefs().disabledAgents.includes(id)
}

/** The user's choices for an agent's settings, by the agent's config id. */
export function savedAgentSettings(id: AgentId): Record<string, string> {
  const all = getPrefs().agentSettings
  return Object.hasOwn(all, id) ? all[id] : {}
}

export function saveAgentSetting(id: AgentId, configId: string, value: string) {
  const all = getPrefs().agentSettings
  setPrefs({ agentSettings: { ...all, [id]: { ...savedAgentSettings(id), [configId]: value } } })
}
