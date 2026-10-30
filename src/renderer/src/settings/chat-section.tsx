import type { SettingsState } from '../../../shared/types'
import { gui } from '../lib/api'
import { List, ListItem } from '../lib/surface'
import { SegmentedControl, Switch } from '../lib/ui'
import { SettingsGroup } from './settings-group'

export function ChatSection({ settings }: { settings: SettingsState }) {
  const sidebar = settings.chatSidebar
  return (
    <SettingsGroup title="Layout">
      <List>
        <ListItem
          title={<label htmlFor="chat-sidebar">Show the chat as a sidebar</label>}
          trailing={
            // The row's title says what it is; the switch repeats it only for screen readers.
            <Switch
              checked={sidebar}
              onCheckedChange={(docked) => gui.setChatDocked(docked)}
              id="chat-sidebar"
              label="Show the chat as a sidebar"
              labelHidden
            />
          }
        />
        <ListItem
          title="Chat sidebar position"
          // Only the sidebar has a side; a floating chat goes wherever it's moved.
          quiet={!sidebar}
          detail={sidebar ? undefined : 'Turn on the sidebar to choose its side.'}
          trailing={
            <SegmentedControl
              label="Chat sidebar position"
              value={settings.chatSidebarSide}
              disabled={!sidebar}
              segments={[
                { value: 'left', label: 'Left' },
                { value: 'right', label: 'Right' },
              ]}
              onChange={(side) => gui.setChatSidebarSide(side)}
            />
          }
        />
      </List>
    </SettingsGroup>
  )
}
