import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { type AgentId, DEFAULT_AGENT_ID, isAgentId } from '../shared/types'

export interface ChatSize {
  width: number
  height: number
}

export interface Prefs {
  agentId: AgentId
  chatDocked: boolean
  /** The floating chat panel's size, without its shadow margin; windows clamp it to fit */
  chatSize: ChatSize
  /** The docked chat panel's width */
  chatDockWidth: number
  /** The app each monorepo previews: project root → app dir relative to it */
  apps: Record<string, string>
  /** Agents switched off in Settings; everything installed is on by default */
  disabledAgents: AgentId[]
}

const DEFAULTS: Prefs = {
  agentId: DEFAULT_AGENT_ID,
  chatDocked: false,
  chatSize: { width: 400, height: 640 },
  chatDockWidth: 400,
  apps: {},
  disabledAgents: [],
}
/** Anything outside this isn't a size a window could have set. */
const MAX_LENGTH = 10_000
const file = () => join(app.getPath('userData'), 'prefs.json')
let cached: Prefs | null = null

export const prefsEvents = new EventEmitter<{ change: [prefs: Prefs] }>()

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

function length(value: unknown, fallback: number) {
  return typeof value === 'number' && value > 0 && value <= MAX_LENGTH
    ? Math.round(value)
    : fallback
}

function chatSize(value: unknown): ChatSize {
  const size = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    width: length(size.width, DEFAULTS.chatSize.width),
    height: length(size.height, DEFAULTS.chatSize.height),
  }
}

export function getPrefs(): Prefs {
  if (cached) return cached
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Prefs>
    cached = {
      agentId: isAgentId(parsed.agentId) ? parsed.agentId : DEFAULT_AGENT_ID,
      chatDocked: parsed.chatDocked === true,
      chatSize: chatSize(parsed.chatSize),
      chatDockWidth: length(parsed.chatDockWidth, DEFAULTS.chatDockWidth),
      apps: stringRecord(parsed.apps),
      disabledAgents: Array.isArray(parsed.disabledAgents)
        ? parsed.disabledAgents.filter(isAgentId)
        : [],
    }
  } catch {
    cached = { ...DEFAULTS, chatSize: { ...DEFAULTS.chatSize }, apps: {} }
  }
  return cached
}

/** Called from IPC handlers, so a failed write is logged rather than thrown into the main process. */
export function setPrefs(patch: Partial<Prefs>) {
  cached = { ...getPrefs(), ...patch }
  try {
    writeFileSync(file(), JSON.stringify(cached, null, 2))
  } catch (error) {
    console.error('[grat] failed to save preferences', error)
  }
  prefsEvents.emit('change', cached)
}

export function isAgentEnabled(id: AgentId) {
  return !getPrefs().disabledAgents.includes(id)
}
