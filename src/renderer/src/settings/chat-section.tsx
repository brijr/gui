import type { SettingsState } from '../../../shared/types'
import { grat } from '../lib/api'
import { List, Switch } from './controls'

export function ChatSection({ settings }: { settings: SettingsState }) {
  return (
    <List>
      <li className="px-3 py-1.5">
        <Switch
          checked={settings.chatDocked}
          onCheckedChange={(docked) => grat.setChatDocked(docked)}
          label="Start the chat docked to the side"
          className="w-full justify-between text-fg"
        />
      </li>
    </List>
  )
}
