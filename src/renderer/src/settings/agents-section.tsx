import { Plus, TriangleAlert } from 'lucide-react'
import { useId, useState } from 'react'
import {
  type AgentHealth,
  CUSTOM_AGENT_PREFIX,
  type CustomAgentEntry,
  type SettingsState,
} from '../../../shared/types'
import { AgentCard } from '../agents/agent-card'
import { gui } from '../lib/api'
import { Disclosure } from '../lib/disclosure'
import { PathText } from '../lib/path-text'
import { Card, GroupLabel, List, ListItem } from '../lib/surface'
import { Button, Code } from '../lib/ui'
import { AgentRow } from './agent-row'
import { CustomAgentForm } from './custom-agent-form'
import { DefaultAgentSelect } from './default-agent-select'
import { useAction } from './use-action'

export function AgentsSection({ settings }: { settings: SettingsState }) {
  const builtIn = settings.agents.filter((agent) => !agent.id.startsWith(CUSTOM_AGENT_PREFIX))
  const found = builtIn.filter((agent) => agent.status !== 'not-installed')
  const missing = builtIn.filter((agent) => agent.status === 'not-installed')
  const foundId = useId()
  const missingId = useId()

  return (
    <>
      <AgentCard
        agentId={settings.defaultAgentId}
        health={settings.agents.find((agent) => agent.id === settings.defaultAgentId) ?? null}
        change={
          <DefaultAgentSelect agents={settings.agents} defaultAgentId={settings.defaultAgentId} />
        }
      />

      <section aria-labelledby={foundId} className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <GroupLabel as="h2" id={foundId}>
            Installed agents
          </GroupLabel>
          <Button variant="ghost" size="sm" onClick={() => gui.checkAgents()}>
            Check again
          </Button>
        </div>
        {found.length > 0 ? (
          <List>
            {found.map((agent) => (
              <AgentRow
                key={agent.id}
                name={agent.name}
                health={agent}
                actions={
                  // A failed Claude Code or Codex download can be retried from here.
                  agent.install && agent.status === 'error' ? (
                    <Button onClick={() => void gui.installAgent(agent.id)}>Try again</Button>
                  ) : undefined
                }
              />
            ))}
          </List>
        ) : (
          <p className="text-muted">None of Gui's agents are installed yet.</p>
        )}
      </section>

      {missing.length > 0 && (
        <section aria-labelledby={missingId} className="flex flex-col gap-2">
          <GroupLabel as="h2" id={missingId}>
            Not installed
          </GroupLabel>
          <List>
            {missing.map((agent) => (
              <NotInstalledRow key={agent.id} agent={agent} />
            ))}
          </List>
        </section>
      )}

      <CustomAgents settings={settings} />
    </>
  )
}

function NotInstalledRow({ agent }: { agent: AgentHealth }) {
  const command = agent.command ?? agent.id
  // Claude Code and Codex: Gui downloads them; other agents: their install page.
  const label = agent.install === 'update' ? "Install Gui's copy" : 'Install'
  return (
    <ListItem
      title={agent.name}
      detail={
        agent.install ? (
          agent.message
        ) : (
          <>
            Needs the <Code>{command}</Code> command on your PATH
          </>
        )
      }
      trailing={
        (agent.install || agent.installUrl) && (
          <Button onClick={() => void gui.installAgent(agent.id)}>{label}</Button>
        )
      }
    />
  )
}

type Editing = { kind: 'add' } | { kind: 'edit'; name: string } | null

function CustomAgents({ settings }: { settings: SettingsState }) {
  const { agents, customAgents, customAgentsError } = settings
  const headingId = useId()
  const [editing, setEditing] = useState<Editing>(null)
  // While agents.json can't be read, nothing in it can be changed from here.
  const locked = customAgentsError !== null
  const adding = !locked && editing?.kind === 'add'
  const empty = customAgents.length === 0 && !adding
  const addDisabled = locked || editing !== null

  const startAdding = () => setEditing({ kind: 'add' })
  const stopEditing = () => setEditing(null)

  const healthFor = (entry: CustomAgentEntry) => {
    const id = `${CUSTOM_AGENT_PREFIX}${entry.name}`
    return agents.find((agent) => agent.id === id) ?? null
  }

  const renderEntry = (entry: CustomAgentEntry) => {
    if (!locked && editing?.kind === 'edit' && editing.name === entry.name) {
      return (
        <li key={entry.name} className="p-3">
          <CustomAgentForm original={entry} onDone={stopEditing} />
        </li>
      )
    }
    return (
      <CustomAgentRow
        key={entry.name}
        entry={entry}
        health={healthFor(entry)}
        home={settings.home}
        locked={locked}
        onEdit={() => setEditing({ kind: 'edit', name: entry.name })}
      />
    )
  }

  // For people bringing their own ACP agent; open when there's something in it.
  const [open, setOpen] = useState(customAgents.length > 0 || locked)

  const heading = (
    <GroupLabel as="h2" id={headingId}>
      <Disclosure tone="label" open={open} onOpenChange={setOpen}>
        Custom agents
      </Disclosure>
    </GroupLabel>
  )

  if (!open) {
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-2">
        {heading}
      </section>
    )
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        {heading}
        <Button variant="ghost" size="sm" onClick={() => gui.openCustomAgentsFile()}>
          Edit agents.json
        </Button>
      </div>

      {customAgentsError && <AgentsFileError message={customAgentsError} />}
      {customAgents.length > 0 && <List>{customAgents.map(renderEntry)}</List>}
      {empty && <p className="text-muted">No custom agents yet.</p>}

      {adding ? (
        <Card className="p-3">
          <CustomAgentForm original={null} onDone={stopEditing} />
        </Card>
      ) : (
        <Button icon={Plus} className="self-start" disabled={addDisabled} onClick={startAdding}>
          Add agent
        </Button>
      )}

      <p className="text-pretty text-caption text-subtle">
        Any ACP agent can be added here. Gui finds agents on your login shell's PATH.
      </p>
    </section>
  )
}

function AgentsFileError({ message }: { message: string }) {
  return (
    <Card className="flex items-start gap-2.5 px-3 py-2.5">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-medium">agents.json can't be read</p>
        <p className="select-text text-pretty text-small text-muted">{message}</p>
        <p className="text-pretty text-small text-muted">
          Custom agents can't be changed here until it's fixed.
        </p>
      </div>
      <Button onClick={() => gui.openCustomAgentsFile()}>Open agents.json</Button>
    </Card>
  )
}

interface CustomAgentRowProps {
  entry: CustomAgentEntry
  health: AgentHealth | null
  home: string
  locked: boolean
  onEdit: () => void
}

function CustomAgentRow({ entry, health, home, locked, onEdit }: CustomAgentRowProps) {
  const [confirming, setConfirming] = useState(false)
  const remove = useAction()
  const commandLine = [entry.command, ...entry.args].join(' ')

  const askRemove = () => setConfirming(true)
  const cancelRemove = () => setConfirming(false)
  const confirmRemove = () => void remove.run(() => gui.deleteCustomAgent(entry.name))

  const detail = (
    <>
      <PathText path={commandLine} home={home} className="select-text text-caption text-subtle" />
      {confirming && <p className="text-small text-muted">Remove {entry.name} from agents.json?</p>}
    </>
  )

  const actions = confirming ? (
    <>
      <Button variant="ghost" disabled={remove.pending} onClick={cancelRemove}>
        Cancel
      </Button>
      <Button variant="danger" disabled={locked} loading={remove.pending} onClick={confirmRemove}>
        Remove
      </Button>
    </>
  ) : (
    <>
      <Button variant="ghost" disabled={locked} onClick={onEdit}>
        Edit
      </Button>
      <Button variant="ghost" disabled={locked} onClick={askRemove}>
        Remove
      </Button>
    </>
  )

  return (
    <AgentRow
      name={entry.name}
      health={health}
      detail={detail}
      actions={actions}
      error={remove.error}
    />
  )
}
