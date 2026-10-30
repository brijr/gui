import type { SettingsState } from '../../../shared/types'
import { gui } from '../lib/api'
import { List, ListItem } from '../lib/surface'
import { SegmentedControl } from '../lib/ui'
import { SettingsGroup } from './settings-group'

export function ChatSection({ settings }: { settings: SettingsState }) {
  return (
    <SettingsGroup title="Layout">
      <List>
        <ListItem
          title="Chat position"
          trailing={
            <SegmentedControl
              label="Chat position"
              value={settings.chatSidebar ? settings.chatSidebarSide : 'floating'}
              segments={[
                { value: 'floating', label: 'Floating' },
                { value: 'left', label: 'Left' },
                { value: 'right', label: 'Right' },
              ]}
              onChange={(position) => {
                if (position === 'floating') gui.setChatDocked(false)
                else {
                  gui.setChatSidebarSide(position)
                  gui.setChatDocked(true)
                }
              }}
            />
          }
        />
      </List>
    </SettingsGroup>
  )
}
