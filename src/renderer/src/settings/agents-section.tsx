import { useEffect, useState } from 'react'
import {
  type AgentHealth,
  type AgentId,
  CUSTOM_AGENT_PREFIX,
  type CustomAgentEntry,
  type SettingsState,
} from '../../../shared/types'
import { AgentCard, InstallProgress } from '../agents/agent-card'
import { gui } from '../lib/api'
import { Disclosure, TechnicalDetails } from '../lib/disclosure'
import { InlineError } from '../lib/field'
import { ExternalLink, Plus, TriangleAlert } from '../lib/icons'
import { PathText } from '../lib/path-text'
import { Card, List, ListItem } from '../lib/surface'
import { Button, Code } from '../lib/ui'
import { AgentRow } from './agent-row'
import { AgentStatusLabel } from './agent-status'
import { CustomAgentForm } from './custom-agent-form'
import { DefaultAgentSelect } from './default-agent-select'
import { GroupAction, SettingsGroup } from './settings-group'
import { useAction } from './use-action'

/** While an agent installs from "Not installed", it stays there until it settles. */
const INSTALL_STEPS: readonly AgentHealth['status'][] = [
  'not-installed',
  'installing',
  'checking',
  'error',
]

export function AgentsSection({ settings }: { settings: SettingsState }) {
  const builtIn = settings.agents.filter((agent) => !agent.id.startsWith(CUSTOM_AGENT_PREFIX))
  // Agents installed from the "Not installed" list, kept in it while they install.
  const [installing, setInstalling] = useState<ReadonlySet<AgentId>>(new Set())
  const isMissing = (agent: AgentHealth) =>
    agent.status === 'not-installed' ||
    (installing.has(agent.id) && INSTALL_STEPS.includes(agent.status))
  const found = builtIn.filter((agent) => !isMissing(agent))
  const missing = builtIn.filter(isMissing)
  const checking = found.some((agent) => agent.enabled && agent.status === 'checking')

  // Once an install settles (ready, or signing in next), the agent moves to "Installed agents".
  const settled = builtIn
    .filter((agent) => installing.has(agent.id) && !INSTALL_STEPS.includes(agent.status))
    .map((agent) => agent.id)
    .join(' ')
  useEffect(() => {
    if (!settled) return
    const done = settled.split(' ')
    setInstalling((current) => new Set([...current].filter((id) => !done.includes(id))))
  }, [settled])

  const startedInstall = (id: AgentId) => setInstalling((current) => new Set(current).add(id))

  return (
    <>
      <AgentCard
        agentId={settings.defaultAgentId}
        health={settings.agents.find((agent) => agent.id === settings.defaultAgentId) ?? null}
        caption="New windows start with this agent."
        change={
          <DefaultAgentSelect agents={settings.agents} defaultAgentId={settings.defaultAgentId} />
        }
      />

      <SettingsGroup
        title="Installed agents"
        action={
          <GroupAction pending={checking} onClick={() => gui.checkAgents()}>
            Check again
          </GroupAction>
        }
      >
        {found.length > 0 ? (
          <List>
            {found.map((agent) => (
              <AgentRow key={agent.id} name={agent.name} health={agent} />
            ))}
          </List>
        ) : (
          <p className="text-pretty text-small text-muted">
            None of Gui’s agents are installed yet.
          </p>
        )}
      </SettingsGroup>

      {missing.length > 0 && (
        <SettingsGroup title="Not installed">
          <List>
            {missing.map((agent) => (
              <NotInstalledRow
                key={agent.id}
                agent={agent}
                onInstall={() => startedInstall(agent.id)}
              />
            ))}
          </List>
        </SettingsGroup>
      )}

      <CustomAgents settings={settings} />
    </>
  )
}

/**
 * An agent Gui can't find. Claude Code and Codex: Gui downloads them here, with progress, and
 * a failure stays on this row. Other agents: their install page opens in the browser.
 */
function NotInstalledRow({ agent, onInstall }: { agent: AgentHealth; onInstall: () => void }) {
  const install = useAction()
  const [openedSite, setOpenedSite] = useState(false)
  const command = agent.command ?? agent.id
  const linkOut = !agent.install && agent.installUrl !== null
  const working = agent.status === 'installing' || agent.status === 'checking'

  const start = () => {
    if (linkOut) setOpenedSite(true)
    else onInstall()
    void install.run(() => gui.installAgent(agent.id))
  }

  const detail =
    agent.status === 'installing' ? (
      <InstallProgress name={agent.name} progress={agent.progress} />
    ) : agent.status === 'error' ? null : agent.install ? (
      agent.message
    ) : (
      <>
        Gui can’t find the <Code>{command}</Code> command on this Mac.
      </>
    )

  const button = linkOut ? (
    <Button trailingIcon={ExternalLink} onClick={start}>
      Install from website
    </Button>
  ) : agent.install && agent.status === 'error' ? (
    <Button loading={install.pending} onClick={start}>
      Try again
    </Button>
  ) : agent.install ? (
    <Button loading={install.pending || working} onClick={start}>
      {agent.install === 'update' ? `Install ${agent.name} for Gui` : `Install ${agent.name}`}
    </Button>
  ) : null

  return (
    <ListItem
      align="start"
      title={
        <>
          <span className="truncate" title={agent.name}>
            {agent.name}
          </span>
          {working && <AgentStatusLabel health={agent} />}
          {agent.status === 'error' && <AgentStatusLabel health={agent} />}
        </>
      }
      detail={detail}
      trailing={button}
    >
      {agent.status === 'error' && (
        <InlineError>{agent.message ?? `${agent.name} couldn’t be installed.`}</InlineError>
      )}
      {agent.status === 'error' && agent.detail && <TechnicalDetails text={agent.detail} />}
      {openedSite && agent.status === 'not-installed' && (
        <p className="text-pretty text-small text-muted">
          Finish installing on the website. Gui picks {agent.name} up on its own.
        </p>
      )}
      {install.error && <InlineError>{install.error}</InlineError>}
    </ListItem>
  )
}

type Editing = { kind: 'add' } | { kind: 'edit'; name: string } | null

function CustomAgents({ settings }: { settings: SettingsState }) {
  const { agents, customAgents, customAgentsError } = settings
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

  // For people bringing their own agent; open when there's something in it.
  const [open, setOpen] = useState(customAgents.length > 0 || locked)

  const disclosure = (
    <Disclosure tone="label" open={open} onOpenChange={setOpen}>
      Custom agents
    </Disclosure>
  )

  if (!open) return <SettingsGroup title={disclosure} />

  return (
    <SettingsGroup
      title={disclosure}
      action={
        <GroupAction onClick={() => gui.openCustomAgentsFile()}>Edit agents.json</GroupAction>
      }
    >
      {customAgentsError && <AgentsFileError message={customAgentsError} />}
      {customAgents.length > 0 && <List>{customAgents.map(renderEntry)}</List>}
      {empty && <p className="text-pretty text-small text-muted">No custom agents yet.</p>}

      {adding ? (
        <Card>
          <CustomAgentForm original={null} onDone={stopEditing} />
        </Card>
      ) : (
        <Button icon={Plus} className="self-start" disabled={addDisabled} onClick={startAdding}>
          Add agent
        </Button>
      )}

      <p className="text-pretty text-caption text-subtle">
        Supports agents using the Agent Client Protocol.
      </p>
    </SettingsGroup>
  )
}

function AgentsFileError({ message }: { message: string }) {
  return (
    <Card className="flex items-start gap-2">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-medium">agents.json can’t be read</p>
        <InlineError>{message}</InlineError>
        <p className="text-pretty text-small text-muted">
          Custom agents can’t be changed here until it’s fixed.
        </p>
      </div>
      <Button className="-my-0.5" onClick={() => gui.openCustomAgentsFile()}>
        Open agents.json
      </Button>
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
