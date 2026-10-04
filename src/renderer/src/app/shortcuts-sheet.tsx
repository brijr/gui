import { X } from 'lucide-react'
import { type MouseEvent, useEffect, useId, useRef } from 'react'
import {
  acceleratorKeys,
  allShortcuts,
  SHORTCUT_GROUPS,
  type Shortcut,
} from '../../../shared/shortcuts'
import { gui } from '../lib/api'
import { GroupLabel } from '../lib/surface'
import { IconButton, Keys } from '../lib/ui'

/**
 * Help → Keyboard Shortcuts (⌘/): every shortcut in the registry, by group, as keycaps. A
 * modal sheet over the window: main hides the preview and the chat while it's open, since
 * they're views on top of this page. Esc, ⌘/ again, the close button or a click outside it
 * closes it.
 */
export function ShortcutsSheet() {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const shortcuts = allShortcuts()

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  const close = () => gui.setShortcutsOpen(false)
  // The backdrop is the dialog's own box, outside its content.
  const onClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) close()
  }

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes it (onCancel); this is a click on the backdrop
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Closed by main's state, like ⌘/ does.
        event.preventDefault()
        close()
      }}
      onClick={onClick}
      className="no-drag m-auto w-full max-w-lg flex-col overflow-hidden rounded-xl border border-line bg-raised p-0 text-fg shadow-popover backdrop:bg-scrim open:flex"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line pr-2 pl-4">
        <h2 id={titleId} className="min-w-0 flex-1 truncate font-semibold">
          Keyboard shortcuts
        </h2>
        <IconButton label="Close" title="Close (Esc)" icon={X} onClick={close} />
      </div>
      <div className="flex min-h-0 flex-col gap-5 overflow-y-auto overscroll-contain px-4 pt-3 pb-5">
        {SHORTCUT_GROUPS.map((group) => (
          <ShortcutGroup
            key={group.id}
            name={group.name}
            shortcuts={shortcuts.filter((shortcut) => shortcut.group === group.id)}
          />
        ))}
      </div>
    </dialog>
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
