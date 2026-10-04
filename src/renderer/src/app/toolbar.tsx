import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  ChevronDown,
  MessageSquare,
  Monitor,
  MousePointer2,
  RotateCw,
  Smartphone,
  Tablet,
} from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { TOOLBAR_HEIGHT, TRAFFIC_LIGHTS_INSET } from '../../../shared/layout'
import { agentName, type Viewport, type WindowState } from '../../../shared/types'
import { gui } from '../lib/api'
import { Input } from '../lib/field'
import { type Status, StatusDot } from '../lib/status'
import { Button, IconButton, SegmentedControl, Toggle } from '../lib/ui'

const VIEWPORTS = [
  { value: 'desktop', label: 'Desktop', icon: Monitor },
  { value: 'tablet', label: 'Tablet', icon: Tablet },
  { value: 'mobile', label: 'Mobile', icon: Smartphone },
] as const satisfies readonly { value: Viewport; label: string; icon: typeof Monitor }[]
const SCREENSHOT_DONE = { copied: 'Copied', saved: 'Saved', attached: 'Attached' } as const
/** How long the screenshot button shows what it did. */
const DONE_MS = 1500

export function Toolbar({ state }: { state: WindowState }) {
  const { project, preview } = state
  // With two or more tabs the traffic lights sit in the tab row above (tab-strip.tsx).
  const inset = state.tabs.length > 1 ? undefined : TRAFFIC_LIGHTS_INSET

  return (
    <header
      className="drag flex shrink-0 items-center gap-1.5 border-b border-line bg-surface pr-2 pl-2"
      style={{ height: TOOLBAR_HEIGHT, paddingLeft: inset }}
    >
      <button
        type="button"
        onClick={() => gui.showProjectMenu()}
        className="no-drag flex h-7 max-w-64 items-center gap-1 rounded-md px-2 font-semibold transition-colors hover:bg-hover"
      >
        <span className="truncate">{project?.name ?? 'Gui'}</span>
        {/* The monorepo app being previewed */}
        {project?.appDir && (
          <span className="truncate font-normal text-subtle">
            / {project.appDir.slice(project.appDir.lastIndexOf('/') + 1)}
          </span>
        )}
        <ChevronDown className="size-3 shrink-0 text-subtle" aria-hidden="true" />
      </button>

      {project && <DevServerPill state={state} />}

      <div className="mx-1 flex items-center">
        <IconButton
          label="Back"
          icon={ArrowLeft}
          disabled={!preview.canGoBack}
          onClick={() => gui.back()}
        />
        <IconButton
          label="Forward"
          icon={ArrowRight}
          disabled={!preview.canGoForward}
          onClick={() => gui.forward()}
        />
        <IconButton
          label="Reload preview"
          icon={RotateCw}
          spinning={preview.loading}
          disabled={!preview.url}
          onClick={() => gui.reload()}
        />
      </div>

      <AddressBar url={preview.url} disabled={!project} />

      <SegmentedControl
        label="Viewport"
        segments={VIEWPORTS}
        value={preview.viewport}
        onChange={(viewport) => gui.setViewport(viewport)}
        iconOnly
        className="ml-1"
      />

      {/* The menu only captures the local app, like element picking. */}
      <ScreenshotButton disabled={!preview.visible || !preview.selectable} />

      <Toggle
        pressed={preview.selecting}
        emphasis="strong"
        icon={MousePointer2}
        disabled={!preview.visible || !preview.selectable}
        onClick={() => gui.toggleSelect()}
        title="Select element (⇧⌘C)"
      >
        Select
      </Toggle>

      <Button variant="ghost" trailingIcon={ChevronDown} onClick={() => gui.showAgentMenu()}>
        {agentName(state.agentId)}
      </Button>

      <IconButton
        label="Toggle chat (⌘J)"
        icon={MessageSquare}
        pressed={state.chatVisible && !!project}
        disabled={!project}
        onClick={() => gui.toggleChat()}
      />
    </header>
  )
}

/** Opens the screenshot menu; briefly shows a check once something was done. */
function ScreenshotButton({ disabled }: { disabled: boolean }) {
  // A new object per result, so a second screenshot restarts the timer.
  const [done, setDone] = useState<{ label: string } | null>(null)

  useEffect(() => {
    if (!done) return
    const timer = setTimeout(() => setDone(null), DONE_MS)
    return () => clearTimeout(timer)
  }, [done])

  const take = async () => {
    const result = await gui.takeScreenshot()
    if (result) setDone({ label: SCREENSHOT_DONE[result] })
  }

  return (
    <>
      <IconButton
        label="Screenshot"
        title={done?.label ?? 'Screenshot'}
        icon={done ? Check : Camera}
        disabled={disabled}
        onClick={() => void take()}
      />
      <span aria-live="polite" className="sr-only">
        {done?.label}
      </span>
    </>
  )
}

function DevServerPill({ state }: { state: WindowState }) {
  const { url, exitCode } = state.devServer
  // Installing runs before the dev server, in the same terminal.
  const installing = state.setup?.dependencies === 'installing'
  const status = installing ? 'starting' : state.devServer.status
  const crashed = status === 'exited' && exitCode !== 0
  const label = installing
    ? 'Installing…'
    : status === 'running' && url
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
  const dot: Status =
    status === 'running'
      ? 'ready'
      : status === 'starting'
        ? 'busy'
        : status === 'exited'
          ? 'error'
          : 'idle'
  return (
    <button
      type="button"
      onClick={() => gui.showDevServerMenu()}
      title={title}
      className="no-drag flex h-6 items-center gap-1.5 rounded-full border border-line bg-raised px-2 font-mono text-caption text-muted transition-colors hover:border-line-strong hover:text-fg"
    >
      <StatusDot status={dot} />
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
    if (value.trim()) gui.navigate(value)
    setDraft(null)
    event.currentTarget.querySelector('input')?.blur()
  }

  return (
    <form onSubmit={submit} className="no-drag min-w-0 flex-1">
      <Input
        id="preview-address"
        aria-label="App address"
        mono
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
      />
    </form>
  )
}
