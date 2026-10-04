import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  MessageSquare,
  Monitor,
  MousePointer2,
  RotateCw,
  Smartphone,
  Tablet,
} from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { agentName, type Viewport, type WindowState } from '../../../shared/types'
import { grat } from '../lib/api'
import { cn } from '../lib/cn'
import { IconButton } from '../lib/ui'

const VIEWPORTS: { id: Viewport; label: string; icon: typeof Monitor }[] = [
  { id: 'desktop', label: 'Desktop', icon: Monitor },
  { id: 'tablet', label: 'Tablet', icon: Tablet },
  { id: 'mobile', label: 'Mobile', icon: Smartphone },
]

export function Toolbar({ state }: { state: WindowState }) {
  const { project, preview } = state

  return (
    <header className="drag flex h-11 shrink-0 items-center gap-1.5 border-b border-line bg-surface pr-2 pl-[84px]">
      <button
        type="button"
        onClick={() => grat.showProjectMenu()}
        className="no-drag flex h-7 max-w-48 items-center gap-1 rounded-md px-2 font-semibold hover:bg-hover"
      >
        <span className="truncate">{project?.name ?? 'Grat'}</span>
        <ChevronDown className="size-3.5 shrink-0 text-subtle" aria-hidden="true" />
      </button>

      {project && <DevServerPill state={state} />}

      <div className="mx-1 flex items-center">
        <IconButton label="Back" disabled={!preview.canGoBack} onClick={() => grat.back()}>
          <ArrowLeft className="size-4" />
        </IconButton>
        <IconButton label="Forward" disabled={!preview.canGoForward} onClick={() => grat.forward()}>
          <ArrowRight className="size-4" />
        </IconButton>
        <IconButton label="Reload preview" disabled={!preview.url} onClick={() => grat.reload()}>
          <RotateCw className={cn('size-3.5', preview.loading && 'animate-spin')} />
        </IconButton>
      </div>

      <AddressBar url={preview.url} disabled={!project} />

      <fieldset
        aria-label="Viewport"
        className="no-drag ml-1 flex items-center rounded-md border border-line p-0.5"
      >
        {VIEWPORTS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-pressed={preview.viewport === id}
            aria-label={label}
            title={label}
            onClick={() => grat.setViewport(id)}
            className={cn(
              'flex size-6 items-center justify-center rounded text-subtle hover:text-fg',
              preview.viewport === id && 'bg-hover text-fg',
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </button>
        ))}
      </fieldset>

      <button
        type="button"
        aria-pressed={preview.selecting}
        disabled={!preview.visible || !preview.selectable}
        onClick={() => grat.toggleSelect()}
        title="Select element (⇧⌘C)"
        className={cn(
          'no-drag flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium transition-colors',
          'disabled:pointer-events-none disabled:opacity-40',
          preview.selecting
            ? 'bg-accent text-accent-fg'
            : 'text-muted hover:bg-hover hover:text-fg',
        )}
      >
        <MousePointer2 className="size-3.5" aria-hidden="true" />
        Select
      </button>

      <button
        type="button"
        onClick={() => grat.showAgentMenu()}
        className="no-drag flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-muted hover:bg-hover hover:text-fg"
      >
        {agentName(state.agentId)}
        <ChevronDown className="size-3.5 text-subtle" aria-hidden="true" />
      </button>

      <IconButton
        label="Toggle chat (⌘J)"
        active={state.chatVisible && !!project}
        disabled={!project}
        onClick={() => grat.toggleChat()}
      >
        <MessageSquare className="size-4" />
      </IconButton>
    </header>
  )
}

function DevServerPill({ state }: { state: WindowState }) {
  const { status, url, exitCode } = state.devServer
  const crashed = status === 'exited' && exitCode !== 0
  const label =
    status === 'running' && url
      ? new URL(url).host
      : status === 'starting'
        ? 'Starting…'
        : crashed
          ? 'Stopped with an error'
          : 'Stopped'
  const title = [
    state.devServer.command ?? 'Your app',
    status === 'exited' && exitCode !== null ? `exited with code ${exitCode}` : null,
  ]
    .filter(Boolean)
    .join(' — ')
  return (
    <button
      type="button"
      onClick={() => grat.showDevServerMenu()}
      title={title}
      className="no-drag flex h-6 items-center gap-1.5 rounded-full border border-line bg-raised px-2 font-mono text-[11px] text-muted hover:border-line-strong hover:text-fg"
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 rounded-full',
          status === 'running' && 'bg-success',
          status === 'starting' && 'animate-pulse bg-warning',
          status === 'exited' && 'bg-danger',
          status === 'idle' && 'bg-subtle',
        )}
      />
      {label}
    </button>
  )
}

function AddressBar({ url, disabled }: { url: string | null; disabled: boolean }) {
  // While focused, the field shows the user's draft; otherwise it follows navigation.
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? url ?? ''

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (value.trim()) grat.navigate(value)
    setDraft(null)
    event.currentTarget.querySelector('input')?.blur()
  }

  return (
    <form onSubmit={submit} className="no-drag min-w-0 flex-1">
      <input
        id="preview-address"
        aria-label="App address"
        value={value}
        disabled={disabled}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => {
          setDraft(url ?? '')
          event.target.select()
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.currentTarget.blur()
        }}
        placeholder={disabled ? '' : 'http://localhost:3000'}
        className="h-7 w-full rounded-md border border-transparent bg-hover px-2.5 font-mono text-[11.5px] text-fg outline-none placeholder:text-subtle focus:border-accent focus:bg-raised disabled:opacity-40"
      />
    </form>
  )
}
