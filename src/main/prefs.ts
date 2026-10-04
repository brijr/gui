import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { type AgentId, DEFAULT_AGENT_ID, isAgentId } from '../shared/types'

export interface Prefs {
  agentId: AgentId
  chatDocked: boolean
  /** Agents switched off in Settings; everything installed is on by default */
  disabledAgents: AgentId[]
}

const DEFAULTS: Prefs = { agentId: DEFAULT_AGENT_ID, chatDocked: false, disabledAgents: [] }
const file = () => join(app.getPath('userData'), 'prefs.json')
let cached: Prefs | null = null

export const prefsEvents = new EventEmitter<{ change: [prefs: Prefs] }>()

export function getPrefs(): Prefs {
  if (cached) return cached
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Prefs>
    cached = {
      agentId: isAgentId(parsed.agentId) ? parsed.agentId : DEFAULT_AGENT_ID,
      chatDocked: parsed.chatDocked === true,
      disabledAgents: Array.isArray(parsed.disabledAgents)
        ? parsed.disabledAgents.filter(isAgentId)
        : [],
    }
  } catch {
    cached = { ...DEFAULTS }
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
