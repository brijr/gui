import { Bot, FolderOpen, HardDrive, MessageSquare } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SettingsSection, SettingsState } from '../../../shared/types'
import { grat } from '../lib/api'
import { cn } from '../lib/cn'
import { AgentsSection } from './agents-section'
import { ChatSection } from './chat-section'
import { ProjectsSection } from './projects-section'
import { StorageSection } from './storage-section'
import { useSettings } from './use-settings'

interface SectionInfo {
  id: SettingsSection
  label: string
  icon: typeof Bot
}

const SECTIONS: readonly SectionInfo[] = [
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'projects', label: 'Projects', icon: FolderOpen },
  { id: 'storage', label: 'Storage', icon: HardDrive },
]

export function SettingsApp() {
  const settings = useSettings()
  const [section, setSection] = useState<SettingsSection>('agents')
  useEffect(() => grat.onSettingsSection(setSection), [])
  const title = SECTIONS.find((item) => item.id === section)?.label

  return (
    <div className="flex h-dvh">
      <nav
        aria-label="Settings"
        className="flex w-45 shrink-0 flex-col border-r border-line bg-surface"
      >
        <div className="drag h-11 shrink-0" />
        <ul className="flex flex-col gap-0.5 px-2">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <li key={id}>
              {id === 'storage' && (
                <p className="px-2 pt-3 pb-1 font-medium text-[11px] text-subtle uppercase tracking-wide">
                  Advanced
                </p>
              )}
              <button
                type="button"
                aria-current={section === id ? 'page' : undefined}
                onClick={() => setSection(id)}
                className={cn(
                  'no-drag flex h-8 w-full items-center gap-2 rounded-md px-2 text-left',
                  'font-medium transition-colors',
                  section === id
                    ? 'bg-accent-soft text-accent'
                    : 'text-muted hover:bg-hover hover:text-fg',
                )}
              >
                <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                {label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <main className="flex min-w-0 flex-1 flex-col bg-canvas">
        <header className="drag flex h-11 shrink-0 items-center border-b border-line px-6">
          <h1 className="font-semibold">{title}</h1>
        </header>
        {/* Keyed by section so each one opens scrolled to the top. */}
        <div key={section} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-xl flex-col gap-6 px-6 py-5">
            {settings && <SectionContent section={section} settings={settings} />}
          </div>
        </div>
      </main>
    </div>
  )
}

interface SectionContentProps {
  section: SettingsSection
  settings: SettingsState
}

function SectionContent({ section, settings }: SectionContentProps) {
  switch (section) {
    case 'agents':
      return <AgentsSection settings={settings} />
    case 'chat':
      return <ChatSection settings={settings} />
    case 'projects':
      return <ProjectsSection settings={settings} />
    case 'storage':
      return <StorageSection settings={settings} />
  }
}
