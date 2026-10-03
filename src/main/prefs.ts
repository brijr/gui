import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { AgentId } from '../shared/types'

export interface Prefs {
  agentId: AgentId
  chatDocked: boolean
}

const DEFAULTS: Prefs = { agentId: 'claude', chatDocked: false }
const file = () => join(app.getPath('userData'), 'prefs.json')
let cached: Prefs | null = null

export function getPrefs(): Prefs {
  if (cached) return cached
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Prefs>
    cached = {
      agentId: parsed.agentId === 'codex' ? 'codex' : 'claude',
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
