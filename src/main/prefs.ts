import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { AgentId } from '../shared/types'

export interface Prefs {
  agentId: AgentId
  chatDocked: boolean
  /** The app each monorepo previews: project root → app dir relative to it */
  apps: Record<string, string>
}

const DEFAULTS: Prefs = { agentId: 'claude', chatDocked: false, apps: {} }
const file = () => join(app.getPath('userData'), 'prefs.json')
let cached: Prefs | null = null

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

export function getPrefs(): Prefs {
  if (cached) return cached
  try {
    const parsed = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Prefs>
    cached = {
      agentId: parsed.agentId === 'codex' ? 'codex' : 'claude',
      chatDocked: parsed.chatDocked === true,
      apps: stringRecord(parsed.apps),
    }
  } catch {
    cached = { ...DEFAULTS, apps: {} }
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
}
