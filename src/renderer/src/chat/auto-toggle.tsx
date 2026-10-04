import { Shield, ShieldOff } from 'lucide-react'
import { useId } from 'react'
import type { ChatMeta } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'

const HELP =
  "Auto: the agent edits files and runs commands without asking, and commands aren't confined to this project. It still asks when a request names a file outside this project, changes a sensitive file, or the agent flags it."

/** Ask or Auto: whether Gui approves this project's permission requests itself. */
export function AutoToggle({ meta }: { meta: ChatMeta }) {
  const on = meta.autoApprove
  const Icon = on ? ShieldOff : Shield
  const helpId = useId()
  return (
    <>
      <button
        type="button"
        aria-label="Auto mode"
        aria-pressed={on}
        aria-describedby={helpId}
        aria-keyshortcuts="Shift+Meta+A"
        title={`${HELP} (⇧⌘A)`}
        // Only from the user's own click (or Agent → Auto Mode): agents never get to turn this on.
        onClick={() => gui.setAutoApprove(!on)}
        className={cn(
          'no-drag flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] transition-colors',
          on ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:bg-hover hover:text-fg',
        )}
      >
        <Icon className="size-3.5" aria-hidden="true" />
        {on ? 'Auto' : 'Ask'}
      </button>
      <span id={helpId} hidden>
        {HELP}
      </span>
    </>
  )
}
