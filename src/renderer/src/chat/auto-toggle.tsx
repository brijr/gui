import { useId } from 'react'
import { withShortcut } from '../../../shared/shortcuts'
import type { ChatMeta } from '../../../shared/types'
import { gui } from '../lib/api'
import { Shield, ShieldCheck } from '../lib/icons'
import { HIT_AREA, IconButton } from '../lib/ui'

const HELP =
  "Auto: the agent edits files and runs commands without asking, and commands aren't confined to this project. It still asks when a request names a file outside this project, changes a sensitive file, or the agent flags it. Turn Auto off to review more requests."

/**
 * Auto mode, on or off: whether Gui approves this project's permission requests itself. An
 * icon among the message box's tools, with what it does in its tooltip. On, the shield has a
 * check (requests approved) and the button holds the neutral pressed fill; off, it's a plain
 * shield at rest, and the agent asks. A safety setting, so on never looks like the rest of the row.
 */
export function AutoToggle({ meta }: { meta: ChatMeta }) {
  const on = meta.autoApprove
  const helpId = useId()
  return (
    <>
      <IconButton
        className={HIT_AREA}
        pressed={on}
        icon={on ? ShieldCheck : Shield}
        label="Auto mode"
        aria-describedby={helpId}
        title={`${withShortcut(on ? 'Auto is on' : 'Auto is off', 'autoMode')}\n\n${HELP}`}
        shortcut="autoMode"
        // Only from the user's own click (or Agent → Auto Mode): agents never get to turn this on.
        onClick={() => gui.setAutoApprove(!on)}
      />
      <span id={helpId} hidden>
        {HELP}
      </span>
    </>
  )
}
