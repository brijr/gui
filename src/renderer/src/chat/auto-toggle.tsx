import { Shield, ShieldOff } from 'lucide-react'
import { useId } from 'react'
import type { ChatMeta } from '../../../shared/types'
import { gui } from '../lib/api'
import { Toggle } from '../lib/ui'

const HELP =
  "Auto: the agent edits files and runs commands without asking, and commands aren't confined to this project. It still asks when a request names a file outside this project, changes a sensitive file, or the agent flags it."

/** Ask or Auto: whether Gui approves this project's permission requests itself. */
export function AutoToggle({ meta }: { meta: ChatMeta }) {
  const on = meta.autoApprove
  const helpId = useId()
  return (
    <>
      <Toggle
        pressed={on}
        icon={on ? ShieldOff : Shield}
        aria-label="Auto mode"
        aria-describedby={helpId}
        title={HELP}
        shortcut="autoMode"
        // Only from the user's own click (or Agent → Auto Mode): agents never get to turn this on.
        onClick={() => gui.setAutoApprove(!on)}
        // Narrow, just the icon (Shield or ShieldOff) and the pressed fill say which.
        className="@max-xs:w-7 @max-xs:justify-center @max-xs:px-0"
      >
        <span className="@max-xs:sr-only">{on ? 'Auto' : 'Ask'}</span>
      </Toggle>
      <span id={helpId} hidden>
        {HELP}
      </span>
    </>
  )
}
