import { useEffect, useState } from 'react'
import type { SettingsState } from '../../../shared/types'
import { grat } from '../lib/api'

export function useSettings() {
  const [settings, setSettings] = useState<SettingsState | null>(null)
  useEffect(() => {
    let live = true
    const off = grat.onSettings(setSettings)
    void grat.getSettings().then((initial) => {
      if (live) setSettings((current) => current ?? initial)
    })
    return () => {
      live = false
      off()
    }
  }, [])
  return settings
}
