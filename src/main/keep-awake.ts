import { powerSaveBlocker } from 'electron'
import { getPrefs, type Prefs, prefsEvents } from './prefs'
import { SleepPrevention } from './sleep-prevention'

export const keepAwake = new SleepPrevention(() => {
  const id = powerSaveBlocker.start('prevent-app-suspension')
  return () => powerSaveBlocker.stop(id)
})

const updateMode = ({ keepAwakeMode }: Prefs) => keepAwake.setMode(keepAwakeMode)

export function watchKeepAwake() {
  prefsEvents.on('change', updateMode)
  updateMode(getPrefs())
}

export function stopKeepAwake() {
  prefsEvents.off('change', updateMode)
  keepAwake.dispose()
}
