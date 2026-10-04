import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { type AgentId, DEFAULT_AGENT_ID, isAgentId } from '../shared/types'

export interface Prefs {
  agentId: AgentId
  chatDocked: boolean
}

const DEFAULTS: Prefs = { agentId: DEFAULT_AGENT_ID, chatDocked: false }
const file = () => join(app.getPath('userData'), 'prefs.json')
let cached: Prefs | null = null

export function getPrefs(): Prefs {
  if (cached) return cached
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Prefs>
    cached = {
      agentId: isAgentId(parsed.agentId) ? parsed.agentId : DEFAULT_AGENT_ID,
      chatDocked: parsed.chatDocked === true,
    }
  } catch {
    cached = { ...DEFAULTS }
  }
  return cached
}

export function setPrefs(patch: Partial<Prefs>) {
  cached = { ...getPrefs(), ...patch }
  writeFileSync(file(), JSON.stringify(cached, null, 2))
}
