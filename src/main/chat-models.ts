import type { AgentId, AgentSetting, ModelSettings } from '../shared/types'
import { agentHealth } from './agent-status'
import { savedAgentSettings } from './prefs'

/** The agent's models before a session starts: its last check's list, with the user's choices. */
export function availableModels(agentId: AgentId): ModelSettings | null {
  const models = agentHealth.list().find((agent) => agent.id === agentId)?.models ?? null
  return models && withChoices(models, agentId, null)
}

/** Whether `value` is one of the choices `models` lists for its setting `settingId`. */
export function offersChoice(models: ModelSettings | null, settingId: string, value: string) {
  const setting = [models?.model, models?.effort].find((s) => s?.id === settingId)
  return setting?.options.some((option) => option.value === value) ?? false
}

/** `models` with the user's saved choices for `agentId` applied, where they still apply. */
export function withChoices(
  models: ModelSettings,
  agentId: AgentId,
  refused: Map<string, string> | null,
): ModelSettings {
  const saved = savedAgentSettings(agentId)
  const apply = (setting: AgentSetting) => ({
    ...setting,
    value: chosenValue(setting, saved, refused) ?? setting.value,
  })
  return { model: apply(models.model), effort: models.effort && apply(models.effort) }
}

/** The user's saved choice for `setting`, when it's still on offer and wasn't refused. */
export function chosenValue(
  setting: AgentSetting,
  saved: Record<string, string>,
  refused: Map<string, string> | null,
) {
  const value = Object.hasOwn(saved, setting.id) ? saved[setting.id] : undefined
  if (value === undefined || refused?.get(setting.id) === value) return null
  return setting.options.some((option) => option.value === value) ? value : null
}
