import { useId } from 'react'
import { withShortcut } from '../../../shared/shortcuts'
import type { ChatMeta } from '../../../shared/types'
import { gui } from '../lib/api'
import { Shield, ShieldCheck } from '../lib/icons'
import { HIT_AREA, IconButton } from '../lib/ui'

const HELP =
  'Auto: the agent edits files and runs commands without asking, even outside this project. It still asks before it touches files outside this project or sensitive files.'

/**
 * Auto mode, on or off: whether Gui approves this project's permission requests itself. An
 * icon among the message box's tools, with what it does in its tooltip. On, the shield has a
 * check (requests approved) and the button holds the neutral pressed fill; off, it's a plain
 * shield at rest, and the agent asks. A safety setting, so on never looks like the rest of the row.
 */
export function AutoToggle({ meta }: { meta: ChatMeta }) {
  const on = meta.autoApprove
  const helpId = useId()
  if (meta.ownPermissions) return <OwnSetting agentName={meta.agentName} />
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

/**
 * In Auto's place for an agent Gui can't make ask first (ChatMeta.ownPermissions): its own
 * settings decide, so there's nothing to switch. Plain words where the shield would be, in
 * a ghost button's size and quiet color, so Ask never shows when it wouldn't hold.
 */
function OwnSetting({ agentName }: { agentName: string }) {
  return (
    // Gives way before the model name does (shrink-[4]).
    <span
      className="inline-flex h-7 min-w-0 shrink-[4] items-center gap-1.5 pr-2.5 pl-2 text-small text-subtle"
      title={`Uses ${agentName}'s own setting. Gui can't switch it to a mode that asks first, so ${agentName}'s settings decide what it asks about. When it does ask, you answer here.`}
    >
      <Shield className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{agentName}'s own setting</span>
    </span>
  )
}
