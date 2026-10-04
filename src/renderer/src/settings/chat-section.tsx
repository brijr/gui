import { useId } from 'react'
import type { SettingsState } from '../../../shared/types'
import { gui } from '../lib/api'
import { GroupLabel, List } from '../lib/surface'
import { Switch } from '../lib/ui'

export function ChatSection({ settings }: { settings: SettingsState }) {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <GroupLabel as="h2" id={headingId}>
        Chat panel
      </GroupLabel>
      <List>
        {/* A switch row: as tall as a ListItem with a button */}
        <li className="px-3 py-1.5">
          <Switch
            checked={settings.chatDocked}
            onCheckedChange={(docked) => gui.setChatDocked(docked)}
            label="Start the chat docked to the side"
            className="w-full justify-between text-fg"
          />
        </li>
      </List>
    </section>
  )
}
