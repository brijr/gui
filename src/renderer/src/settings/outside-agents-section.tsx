import { useEffect, useState } from 'react'
import { outsideSetup } from '../../../shared/outside-setup'
import type { OutsideClient, SettingsState } from '../../../shared/types'
import { gui } from '../lib/api'
import { InlineError } from '../lib/field'
import { List, ListItem } from '../lib/surface'
import { Button, SegmentedControl, Switch } from '../lib/ui'
import { GroupAction, SettingsGroup } from './settings-group'
import { useAction } from './use-action'

const CLIENTS: { value: OutsideClient; label: string; where: string }[] = [
  { value: 'claude', label: 'Claude Code', where: 'Run this in Terminal.' },
  { value: 'codex', label: 'Codex', where: 'Add this to ~/.codex/config.toml.' },
  { value: 'cursor', label: 'Cursor', where: 'Add this to ~/.cursor/mcp.json.' },
]

/** Where the token goes in the setup shown; Copy puts the real one in. */
const HIDDEN_TOKEN = '••••••••'

/**
 * Settings → Agents: agents the user runs outside Gui may use its tools (main/outside-agents.ts),
 * with the setup to paste into each. The token stays in main; Copy puts it on the clipboard.
 */
export function OutsideAgentsSection({ settings }: { settings: SettingsState }) {
  const { on, port, error } = settings.outsideAgents
  const toggle = useAction()
  const renew = useAction()
  // Nothing on the page shows the token, so say it changed.
  const [renewed, setRenewed] = useState(false)
  return (
    <SettingsGroup
      heading="Other agents"
      action={
        on && (
          <GroupAction
            loading={renew.pending}
            onClick={() =>
              void renew.run(async () => {
                await gui.newOutsideToken()
                setRenewed(true)
              })
            }
          >
            New token
          </GroupAction>
        )
      }
    >
      <List>
        <ListItem
          heading={<label htmlFor="outside-agents">Let other agents use Gui</label>}
          detail="Claude Code, Codex, or Cursor running outside Gui can see and edit what’s open in Gui’s front window."
          trailing={
            <Switch
              checked={on}
              disabled={toggle.pending}
              onCheckedChange={(value) => void toggle.run(() => gui.setOutsideAgents(value))}
              id="outside-agents"
              label="Let other agents use Gui"
            />
          }
        />
      </List>
      {error && <InlineError>{error}</InlineError>}
      {toggle.error && <InlineError>{toggle.error}</InlineError>}
      {renew.error && <InlineError>{renew.error}</InlineError>}
      {on && renewed && (
        <p role="status" className="text-pretty text-small text-muted">
          New token made. Agents set up before need the setup copied again.
        </p>
      )}
      {on && <Setup port={port} />}
    </SettingsGroup>
  )
}

function Setup({ port }: { port: number }) {
  const [client, setClient] = useState<OutsideClient>('claude')
  const [copied, setCopied] = useState(false)
  const copy = useAction()
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const { where } = CLIENTS.find((item) => item.value === client) ?? CLIENTS[0]

  return (
    <div className="flex flex-col gap-2">
      <SegmentedControl
        className="self-start"
        label="Agent"
        value={client}
        segments={CLIENTS}
        onChange={(value) => {
          setClient(value)
          setCopied(false)
        }}
      />
      <p className="text-pretty text-small text-muted">
        {where} Copy includes your token; anyone with it can use Gui while it’s open.
      </p>
      <pre className="select-text overflow-x-auto whitespace-pre-wrap wrap-anywhere rounded-md bg-fill px-2 py-1.5 font-mono text-small text-fg">
        {outsideSetup(client, port, HIDDEN_TOKEN)}
      </pre>
      <Button
        className="self-start"
        loading={copy.pending}
        onClick={() =>
          void copy.run(async () => {
            await gui.copyOutsideSetup(client)
            setCopied(true)
          })
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
      {copy.error && <InlineError>{copy.error}</InlineError>}
    </div>
  )
}
