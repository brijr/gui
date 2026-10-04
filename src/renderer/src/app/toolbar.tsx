import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  ChevronDown,
  Folder,
  MessageSquare,
  Monitor,
  MousePointer2,
  RotateCw,
  Smartphone,
  Tablet,
} from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { TOOLBAR_HEIGHT, TRAFFIC_LIGHTS_INSET } from '../../../shared/layout'
import type { Viewport, WindowState } from '../../../shared/types'
import { gui } from '../lib/api'
import { Input } from '../lib/field'
import { StatusDot } from '../lib/status'
import { Button, IconButton, SegmentedControl, Toggle } from '../lib/ui'
import { serverStatus } from './server-status'

const VIEWPORTS = [
  { value: 'desktop', label: 'Desktop', icon: Monitor },
  { value: 'tablet', label: 'Tablet', icon: Tablet },
  { value: 'mobile', label: 'Mobile', icon: Smartphone },
] as const satisfies readonly { value: Viewport; label: string; icon: typeof Monitor }[]
const SCREENSHOT_DONE = { copied: 'Copied', saved: 'Saved', attached: 'Attached' } as const
/** How long the screenshot button shows what it did. */
const DONE_MS = 1500

/**
 * The window's toolbar: the project menu, then, once a project is open, the preview's
 * navigation, its address (with the dev server's status), viewport, screenshot, Select and
 * the chat. Groups sit a gap apart; controls are 28px.
 */
export function Toolbar({ state }: { state: WindowState }) {
  const { project, preview } = state
  // With two or more tabs the traffic lights sit in the tab row above (tab-strip.tsx).
  const tabbed = state.tabs.length > 1
  // Picking and screenshots only work on the local app.
  const capturable = preview.visible && preview.selectable

  return (
    <header
      className="drag flex shrink-0 items-center gap-2 border-b border-line bg-surface pr-2 pl-2"
      style={{ height: TOOLBAR_HEIGHT, paddingLeft: tabbed ? undefined : TRAFFIC_LIGHTS_INSET }}
    >
      <ProjectMenuButton state={state} named={!tabbed} />

      {project && (
        <>
          <div className="flex items-center gap-0.5">
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

          <AddressBar state={state} />

          <SegmentedControl
            label="Viewport"
            segments={VIEWPORTS}
            value={preview.viewport}
            onChange={(viewport) => gui.setViewport(viewport)}
            iconOnly
          />

          <div className="flex items-center gap-1">
            <ScreenshotButton disabled={!capturable} />
            <Toggle
              pressed={preview.selecting}
              emphasis="strong"
              icon={MousePointer2}
              disabled={!capturable}
              onClick={() => gui.toggleSelect()}
              title="Select element (⇧⌘C)"
            >
              Select
            </Toggle>
          </div>

          <IconButton
            label="Toggle chat (⌘J)"
            icon={MessageSquare}
            pressed={state.chatVisible}
            onClick={() => gui.toggleChat()}
          />
        </>
      )}
    </header>
  )
}

/**
 * Opens the project menu (open, recent projects, switch app, reveal). It names the project,
 * unless the tab row does already; then it's the folder alone.
 */
function ProjectMenuButton({ state, named }: { state: WindowState; named: boolean }) {
  const { project } = state
  // The monorepo app being previewed
  const app = project?.appDir?.slice(project.appDir.lastIndexOf('/') + 1)
  return (
    <Button
      variant="ghost"
      icon={Folder}
      trailingIcon={ChevronDown}
      aria-haspopup="menu"
      aria-label={named ? undefined : 'Project menu'}
      title={named ? undefined : 'Project menu'}
      className="max-w-64"
      onClick={() => gui.showProjectMenu()}
    >
      {named && (
        <>
          <span className="min-w-0 truncate text-fg">{project?.name ?? 'Gui'}</span>
          {app && <span className="min-w-0 truncate font-normal text-subtle">/ {app}</span>}
        </>
      )}
    </Button>
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

/**
 * The preview's address, led by the dev server's status: a dot that opens the dev-server menu
 * (restart, stop, logs, open in browser). Until there's a page to show the field says what
 * the server is doing rather than a made-up address.
 */
function AddressBar({ state }: { state: WindowState }) {
  const { preview, devServer, project, setup } = state
  // While focused, the field shows the user's draft; otherwise it follows navigation.
  const [draft, setDraft] = useState<string | null>(null)
  // The address of what's on screen, or being loaded, or failed to load.
  const url = preview.visible || preview.loading || preview.error ? preview.url : null
  const value = draft ?? url ?? ''
  const { status, label } = serverStatus(state)
  // Like the canvas: without a dev script (or an app picked), the address is the way in.
  const noCommand = !project?.devCommand && !setup?.apps
  const placeholder = devServer.status === 'idle' && noCommand ? "Enter your app's address" : label
  const exit =
    devServer.status === 'exited' && devServer.exitCode !== null
      ? `exited with code ${devServer.exitCode}`
      : null
  const tooltip = [label, devServer.command, exit].filter(Boolean).join(' — ')

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
        // Addresses in monospace; the status in its place in the UI's font.
        mono={value !== '' || draft !== null}
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => {
          setDraft(url ?? '')
          event.target.select()
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') event.currentTarget.blur()
        }}
        leading={
          <button
            type="button"
            aria-label={`Dev server: ${label}`}
            aria-haspopup="menu"
            title={tooltip}
            onClick={() => gui.showDevServerMenu()}
            className="flex h-full shrink-0 items-center rounded-l-md pr-2 pl-2.5 transition-colors hover:bg-hover focus-visible:-outline-offset-2"
          >
            <StatusDot status={status} />
          </button>
        }
      />
    </form>
  )
}
