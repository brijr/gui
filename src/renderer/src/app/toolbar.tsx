import { type FormEvent, useEffect, useRef, useState } from 'react'
import { TOOLBAR_HEIGHT, TRAFFIC_LIGHTS_INSET } from '../../../shared/layout'
import { ariaShortcut, VIEWPORT_SHORTCUTS, withShortcut } from '../../../shared/shortcuts'
import { type BoardState, VIEWPORTS, type Viewport, type WindowState } from '../../../shared/types'
import { gui } from '../lib/api'
import { Input } from '../lib/field'
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  ChevronDown,
  Folder,
  Group,
  Hand,
  type IconComponent,
  Laptop,
  MessageSquare,
  Minus,
  Monitor,
  MousePointer,
  MousePointer2,
  Plus,
  RotateCw,
  Shapes,
  Share,
  Smartphone,
  Tablet,
} from '../lib/icons'
import { StatusDot } from '../lib/status'
import { Button, IconButton, PRESS, SegmentedControl } from '../lib/ui'
import { type BoardTool, setBoardTool, useBoardTool, useBoardView } from './board'
import { RecordButton } from './record-button'
import { serverStatus } from './server-status'

const VIEWPORT_ICONS: Record<Viewport, IconComponent> = {
  desktop: Monitor,
  laptop: Laptop,
  tablet: Tablet,
  mobile: Smartphone,
}
/** Named like the View menu's items, with their shortcut; the tooltip adds the size. */
const VIEWPORT_SEGMENTS = VIEWPORTS.map(({ id, name, size }) => {
  const detail = size ? `${size.width} × ${size.height}` : 'fills the window'
  return {
    value: id,
    label: name,
    title: `${name} · ${detail}`,
    icon: VIEWPORT_ICONS[id],
    shortcut: VIEWPORT_SHORTCUTS[id],
  }
})
const BOARD_TOOLS = [
  { value: 'move', label: 'Move', title: 'Move (V)', icon: MousePointer },
  { value: 'hand', label: 'Hand', title: 'Hand (H, or hold Space)', icon: Hand },
] satisfies { value: BoardTool; label: string; title: string; icon: IconComponent }[]
const SCREENSHOT_DONE = { copied: 'Copied', saved: 'Saved', attached: 'Attached' } as const
/** Between a button and the menu it opens under it. */
const MENU_GAP = 4
/** Frames to wait for the address field to show, after ⇧⌘L brings the toolbar back. */
const FOCUS_FRAMES = 10
/** How long the screenshot button shows what it did. */
const DONE_MS = 1500

/**
 * The window's toolbar: the project menu, then, once a project is open, the preview's
 * navigation, its address (with the dev server's status), viewport, screenshot, Select and
 * the chat. Groups sit a gap apart; controls are 28px.
 */
export function Toolbar({ state }: { state: WindowState }) {
  const { project, preview } = state
  // With two or more tabs the traffic lights sit in the tab row above (tab-strip.tsx), and
  // with the chat sidebar in its header.
  const tabbed = state.tabs.length > 1
  const lights =
    !tabbed && !state.fullScreen && (state.sidebarWidth === 0 || state.sidebarSide === 'right')
  // Picking and screenshots only work on the local app.
  const capturable = preview.visible && preview.selectable

  if (state.board)
    return (
      <header
        className="drag flex shrink-0 items-center gap-2 border-b border-line bg-surface pr-2 pl-2"
        style={{ height: TOOLBAR_HEIGHT, paddingLeft: lights ? TRAFFIC_LIGHTS_INSET : undefined }}
      >
        <BoardToolbar state={state} board={state.board} named={!tabbed} />
      </header>
    )

  return (
    <header
      className="drag flex shrink-0 items-center gap-2 border-b border-line bg-surface pr-2 pl-2"
      style={{ height: TOOLBAR_HEIGHT, paddingLeft: lights ? TRAFFIC_LIGHTS_INSET : undefined }}
    >
      <ProjectMenuButton state={state} named={!tabbed} />

      {project && (
        <>
          <div className="flex items-center gap-0.5">
            <IconButton
              label="Back"
              shortcut="back"
              icon={ArrowLeft}
              disabled={!preview.canGoBack}
              onClick={() => gui.back()}
            />
            <IconButton
              label="Forward"
              shortcut="forward"
              icon={ArrowRight}
              disabled={!preview.canGoForward}
              onClick={() => gui.forward()}
            />
            <IconButton
              label="Reload preview"
              shortcut="reload"
              icon={RotateCw}
              spinning={preview.loading}
              disabled={!preview.url}
              onClick={() => gui.reload()}
            />
          </div>

          <AddressBar state={state} />

          <SegmentedControl
            label="Viewport"
            segments={VIEWPORT_SEGMENTS}
            value={preview.viewport}
            onChange={(viewport) => gui.setViewport(viewport)}
            iconOnly
          />

          <div className="flex items-center gap-1">
            <ScreenshotButton disabled={!capturable} />
            <RecordButton state={state} disabled={!capturable} />
            <IconButton
              label="Select element"
              shortcut="selectElement"
              keys
              icon={MousePointer2}
              pressed={preview.selecting}
              emphasis="strong"
              disabled={!capturable}
              onClick={() => gui.toggleSelect()}
            />
          </div>

          <IconButton
            label="Toggle chat"
            shortcut="toggleChat"
            keys
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
 * A canvas's toolbar. On the board: the canvas's menu (and its name, renamed in place), a new
 * frame, and the board's zoom. With a frame open: the way back to the board, the frame's
 * name, and the preview's viewport, screenshot and Select, as for a project.
 */
function BoardToolbar({
  state,
  board,
  named,
}: {
  state: WindowState
  board: BoardState
  named: boolean
}) {
  const { preview } = state
  const capturable = preview.visible && preview.selectable
  const open = board.frames.find((frame) => frame.id === board.open)
  const frameButton = useRef<HTMLButtonElement>(null)
  const boardView = useBoardView()
  const boardTool = useBoardTool()
  const [renaming, setRenaming] = useState(false)
  useEffect(
    () =>
      gui.onBoardCommand((command) => {
        if (command.type === 'renameBoard') setRenaming(true)
      }),
    [],
  )

  const chat = (
    <IconButton
      label="Toggle chat"
      shortcut="toggleChat"
      keys
      icon={MessageSquare}
      pressed={state.chatVisible}
      onClick={() => gui.toggleChat()}
    />
  )

  return (
    <>
      {renaming ? (
        <input
          // biome-ignore lint/a11y/noAutofocus: renaming starts by typing the new name.
          autoFocus
          aria-label="Canvas name"
          defaultValue={board.name}
          className="no-drag h-7 w-56 rounded-md border border-accent bg-raised px-2 text-small text-fg outline-none"
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              event.currentTarget.value = board.name
              event.currentTarget.blur()
            }
          }}
          onBlur={(event) => {
            setRenaming(false)
            const name = event.currentTarget.value.trim()
            if (name && name !== board.name) gui.renameBoard(name)
          }}
        />
      ) : (
        <Button
          variant="ghost"
          icon={Shapes}
          trailingIcon={ChevronDown}
          aria-haspopup="menu"
          aria-label={named ? undefined : 'Canvas menu'}
          title="Canvas menu"
          className="max-w-64"
          onClick={() => gui.showBoardMenu()}
        >
          {named && <span className="min-w-0 truncate text-fg">{board.name}</span>}
        </Button>
      )}

      {open ? (
        <>
          <Button variant="ghost" icon={ArrowLeft} onClick={() => gui.boardOpenFrame(null)}>
            Board
          </Button>
          <p className="min-w-0 flex-1 truncate text-small font-medium text-fg">
            {open.name}
            <span className="ml-2 font-normal text-subtle tabular-nums">
              {open.width} × {open.height}
            </span>
          </p>
          <IconButton
            label="Reload frame"
            shortcut="reload"
            icon={RotateCw}
            spinning={preview.loading}
            disabled={!preview.url}
            onClick={() => gui.reload()}
          />
          <SegmentedControl
            label="Viewport"
            segments={VIEWPORT_SEGMENTS}
            value={preview.viewport}
            onChange={(viewport) => gui.setViewport(viewport)}
            iconOnly
          />
          <div className="flex items-center gap-1">
            <ScreenshotButton disabled={!capturable} />
            <IconButton
              label="Select element"
              shortcut="selectElement"
              keys
              icon={MousePointer2}
              pressed={preview.selecting}
              emphasis="strong"
              disabled={!capturable}
              onClick={() => gui.toggleSelect()}
            />
          </div>
          {chat}
        </>
      ) : (
        <>
          <Button
            ref={frameButton}
            variant="ghost"
            icon={Plus}
            trailingIcon={ChevronDown}
            aria-haspopup="menu"
            onClick={() => {
              const box = frameButton.current?.getBoundingClientRect()
              if (box) gui.showAddFrameMenu({ x: box.left, y: box.bottom + MENU_GAP })
            }}
          >
            Frame
          </Button>
          <IconButton
            label="Add section"
            title="Add a section around the selected frames (⌥⌘G)"
            icon={Group}
            disabled={!board.selection.length}
            onClick={() => gui.boardAddSection(board.selection)}
          />
          <SegmentedControl
            label="Tool"
            segments={BOARD_TOOLS}
            value={boardTool}
            onChange={setBoardTool}
            iconOnly
          />
          <div className="flex-1" />
          <div className="flex items-center gap-1">
            <IconButton
              label={
                board.selection.length > 1
                  ? `Export ${board.selection.length} frames as PNG`
                  : 'Export as PNG'
              }
              icon={Share}
              disabled={!board.selection.length}
              onClick={() => gui.boardExport(board.selection)}
            />
            <IconButton
              label="Select element"
              shortcut="selectElement"
              keys
              icon={MousePointer2}
              emphasis="strong"
              // The frame ⌘D opens to pick in: the one selected, or the only one (tab.ts).
              disabled={
                board.selection.length !== 1 &&
                !(!board.selection.length && board.frames.length === 1)
              }
              onClick={() => gui.toggleSelect()}
            />
          </div>
          {boardView.camera && (
            <div className="flex items-center gap-0.5">
              <IconButton label="Zoom out" icon={Minus} onClick={() => boardView.zoomBy(0.8)} />
              <button
                type="button"
                aria-label={`Zoom ${Math.round(boardView.camera.zoom * 100)}%, zoom to fit`}
                title="Zoom to fit"
                onClick={() => boardView.fit()}
                className={`no-drag flex h-7 min-w-12 items-center justify-center rounded-md px-1.5 text-caption font-medium text-muted tabular-nums transition-[color,background-color,opacity] hover:bg-hover hover:text-fg ${PRESS}`}
              >
                {Math.round(boardView.camera.zoom * 100)}%
              </button>
              <IconButton label="Zoom in" icon={Plus} onClick={() => boardView.zoomBy(1.25)} />
            </div>
          )}
          {chat}
        </>
      )}
    </>
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

/** Opens the screenshot menu under `button`; resolves with what was done, or null. */
async function screenshotUnder(button: HTMLElement | null) {
  const box = button?.getBoundingClientRect()
  const result = await gui.takeScreenshot(box && { x: box.left, y: box.bottom + MENU_GAP })
  return result && SCREENSHOT_DONE[result]
}

/**
 * Opens the screenshot menu under itself, from a click or ⇧⌘S; briefly shows a check once
 * something was done.
 */
function ScreenshotButton({ disabled }: { disabled: boolean }) {
  const button = useRef<HTMLButtonElement>(null)
  // A new object per result, so a second screenshot restarts the timer.
  const [done, setDone] = useState<{ label: string } | null>(null)

  useEffect(() => {
    if (!done) return
    const timer = setTimeout(() => setDone(null), DONE_MS)
    return () => clearTimeout(timer)
  }, [done])

  const take = async () => {
    const label = await screenshotUnder(button.current)
    if (label) setDone({ label })
  }

  // Main beeps when there's nothing to capture, so this asks even while the button is disabled.
  useEffect(
    () =>
      gui.onCommand(async (command) => {
        if (command !== 'screenshot') return
        const label = await screenshotUnder(button.current)
        if (label) setDone({ label })
      }),
    [],
  )

  return (
    <>
      <IconButton
        ref={button}
        label="Screenshot"
        shortcut="screenshot"
        keys
        // The tooltip says what it did, for a moment.
        title={done?.label}
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

const ADDRESS_ID = 'preview-address'

/**
 * Desktop's page zoom while it isn't 100%, at the end of the address field, like a browser's;
 * clicking it goes back to 100%. (A device frame's label shows its own.)
 */
function ZoomButton({ zoom }: { zoom: number }) {
  const percent = Math.round(zoom * 100)
  return (
    <button
      type="button"
      aria-label={`Zoom ${percent}%, reset to 100%`}
      title={withShortcut('Reset zoom', 'actualSize')}
      aria-keyshortcuts={ariaShortcut('actualSize')}
      onClick={() => gui.zoomPreview(0)}
      className={`flex h-full shrink-0 items-center rounded-r-md pr-2.5 pl-2 text-caption font-medium text-muted tabular-nums transition-[color,background-color,opacity] hover:bg-hover hover:text-fg focus-visible:-outline-offset-2 ${PRESS}`}
    >
      {percent}%
    </button>
  )
}

/**
 * Focuses the address field with its text selected (⇧⌘L, "Enter address"), once it's on
 * screen: the toolbar can be on its way back.
 */
export function focusAddressBar(frames = FOCUS_FRAMES) {
  const field = document.getElementById(ADDRESS_ID)
  if (field instanceof HTMLInputElement) {
    field.focus()
    field.select()
  } else if (frames > 0) {
    requestAnimationFrame(() => focusAddressBar(frames - 1))
  }
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
        id={ADDRESS_ID}
        aria-label="App address"
        title={withShortcut('App address', 'focusAddress')}
        aria-keyshortcuts={ariaShortcut('focusAddress')}
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
        trailing={
          preview.viewport === 'desktop' && preview.zoom !== 1 && <ZoomButton zoom={preview.zoom} />
        }
        leading={
          <button
            type="button"
            aria-label={`Dev server: ${label}`}
            aria-haspopup="menu"
            title={tooltip}
            onClick={() => gui.showDevServerMenu()}
            className={`flex h-full shrink-0 items-center rounded-l-md pr-2 pl-2.5 transition-[background-color,opacity] hover:bg-hover focus-visible:-outline-offset-2 ${PRESS}`}
          >
            <StatusDot status={status} />
          </button>
        }
      />
    </form>
  )
}
