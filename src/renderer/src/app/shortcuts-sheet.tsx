import { useId } from 'react'
import {
  acceleratorKeys,
  allShortcuts,
  SHORTCUT_GROUPS,
  type Shortcut,
} from '../../../shared/shortcuts'
import { gui } from '../lib/api'
import { Dialog } from '../lib/dialog'
import { GroupLabel } from '../lib/surface'
import { Keys } from '../lib/ui'

/**
 * Help → Keyboard Shortcuts (⌘/): every shortcut in the registry, by group, as keycaps. A
 * modal sheet over the window, open while it's mounted: main hides the preview and the chat
 * while it's open, since they're views on top of this page. Esc, ⌘/ again, the close button
 * or a click outside it closes it, through main's state.
 */
export function ShortcutsSheet() {
  const shortcuts = allShortcuts()
  return (
    <Dialog
      open
      onClose={() => gui.setShortcutsOpen(false)}
      title="Keyboard shortcuts"
      // Only read: the sheet itself has the keyboard, so the arrow keys scroll it, rather than
      // its close button showing a focus ring from the start.
      focusSelf
      className="flex flex-col gap-5 px-4 pt-3 pb-5"
    >
      {SHORTCUT_GROUPS.map((group) => (
        <ShortcutGroup
          key={group.id}
          name={group.name}
          shortcuts={shortcuts.filter((shortcut) => shortcut.group === group.id)}
        />
      ))}
    </Dialog>
  )
}

function ShortcutGroup({ name, shortcuts }: { name: string; shortcuts: Shortcut[] }) {
  const id = useId()
  if (shortcuts.length === 0) return null
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1">
      <GroupLabel id={id} as="h3">
        {name}
      </GroupLabel>
      <ul className="flex flex-col">
        {shortcuts.map((shortcut) => (
          <li key={shortcut.id} className="flex min-h-7 items-center gap-4 py-1">
            <span className="min-w-0 flex-1 text-pretty">{shortcut.description}</span>
            <span className="flex shrink-0 items-center gap-1.5">
              <Keys keys={acceleratorKeys(shortcut.accelerator)} />
              {shortcut.alternates?.map((keys) => (
                <span key={keys} className="flex items-center gap-1.5">
                  <span className="text-caption text-subtle">or</span>
                  <Keys keys={acceleratorKeys(keys)} />
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
