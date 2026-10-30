import { useEffect, useState } from 'react'
import { TOOLBAR_HEIGHT } from '../../../shared/layout'
import type { SettingsSection, SettingsState } from '../../../shared/types'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { GitHubMark } from '../lib/github-mark'
import { Bot, CircleUser, FolderOpen, HardDrive, MessageSquare } from '../lib/icons'
import { PRESS } from '../lib/ui'
import { AccountSection } from './account-section'
import { AgentsSection } from './agents-section'
import { ChatSection } from './chat-section'
import { GitHubSection } from './github-section'
import { ProjectsSection } from './projects-section'
import { StorageSection } from './storage-section'

interface SectionInfo {
  id: SettingsSection
  label: string
  icon: typeof Bot
}

const SECTIONS: readonly SectionInfo[] = [
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'projects', label: 'Projects', icon: FolderOpen },
  { id: 'github', label: 'GitHub', icon: GitHubMark },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'account', label: 'Account', icon: CircleUser },
]

export function SettingsApp() {
  const [settings, setSettings] = useState<SettingsState | null>(null)
  const [selected, setSection] = useState<SettingsSection | null>(null)
  useEffect(() => {
    let live = true
    const offSection = gui.onSettingsSection(setSection)
    const offSettings = gui.onSettings((next) => setSettings((current) => (current ? next : null)))
    void gui.getSettings().then((initial) => {
      if (!live) return
      setSettings(initial)
      setSection((current) => current ?? initial.initialSection ?? 'agents')
    })
    return () => {
      live = false
      offSection()
      offSettings()
    }
  }, [])
  const section = settings ? selected : null
  const title = SECTIONS.find((item) => item.id === section)?.label

  return (
    <div className="flex h-dvh">
      <nav
        aria-label="Settings"
        className="flex w-45 shrink-0 flex-col border-r border-line bg-surface"
      >
        {/* Room for the traffic lights, which sit at the toolbar's height */}
        <div className="drag shrink-0" style={{ height: TOOLBAR_HEIGHT }} />
        <ul className="flex flex-col gap-0.5 px-2">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <li key={id}>
              <button
                type="button"
                aria-current={section === id ? 'page' : undefined}
                onClick={() => setSection(id)}
                className={cn(
                  'no-drag flex h-7 w-full items-center gap-2 rounded-md px-2 text-left',
                  'font-medium transition-[color,background-color,opacity]',
                  PRESS,
                  section === id
                    ? 'bg-accent-soft text-accent-text'
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
        {/* On the content's own color with no rule under it, lined up with the column below;
            the content fades out under it as it scrolls. */}
        <header className="drag flex shrink-0 items-center" style={{ height: TOOLBAR_HEIGHT }}>
          <div className="mx-auto w-full max-w-xl px-6">
            <h1 className="text-title font-semibold">{title}</h1>
          </div>
        </header>
        {/* Keyed by section so each one opens scrolled to the top. */}
        <div key={section} className="min-h-0 flex-1 overflow-y-auto scroll-stable scroll-fade">
          <div className="mx-auto flex max-w-xl flex-col gap-6 px-6 pt-2 pb-5">
            {settings && section && <SectionContent section={section} settings={settings} />}
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
    case 'github':
      return <GitHubSection />
    case 'storage':
      return <StorageSection settings={settings} />
    case 'account':
      return <AccountSection settings={settings} />
  }
}
