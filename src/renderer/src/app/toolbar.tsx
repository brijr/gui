import { type FormEvent, useEffect, useRef, useState } from 'react'
import { TOOLBAR_HEIGHT } from '../../../shared/layout'
import { ariaShortcut, VIEWPORT_SHORTCUTS, withShortcut } from '../../../shared/shortcuts'
import {
  type BoardState,
  type ToolbarMenuItem,
  VIEWPORTS,
  type Viewport,
  type WindowState,
} from '../../../shared/types'
import { gui } from '../lib/api'
import { Input } from '../lib/field'
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  ChevronDown,
  Ellipsis,
  Folder,
  Group,
  Hand,
  type IconComponent,
  ImageDown,
  Laptop,
  MessageSquare,
  Minus,
  Monitor,
  MousePointer,
  MousePointer2,
  Plus,
  RotateCw,
  Shapes,
  Smartphone,
  Tablet,
} from '../lib/icons'
import { StatusDot } from '../lib/status'
import { Button, IconButton, PRESS, SegmentedControl } from '../lib/ui'
import { type BoardTool, setBoardTool, useBoardTool, useBoardView } from './board'
import { barPadding, sidebarRoom, useSidebarBar, useSidebarSliding } from './layout-morph'
import { RecordButton } from './record-button'
import { serverStatus } from './server-status'
import { type FitStep, useToolbarFit } from './toolbar-fit'

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

/** The "…" button, where the screenshot menu opens while Screenshot is in it */
const MORE_ID = 'toolbar-more'
/** The address field's room before anything else gives way: an address like localhost:5173/. */
const ADDRESS_MIN = 200
/** The frame's name on a canvas, and the room before the board's zoom, likewise */
const FRAME_NAME_MIN = 96
const BOARD_GAP_MIN = 8

/**
 * The order the project toolbar makes room in (toolbar-fit.ts): the tools' keys first, then
 * Back and Forward, the viewport, Screenshot and Reload go into the "…" menu, then the project's
 * name, then Select. Record and the chat button always stay.
 */
const PROJECT_STEPS: FitStep[] = [
  { tool: 'screenshot', to: 'compact' },
  { tool: 'select', to: 'compact' },
  { tool: 'chat', to: 'compact' },
  { tool: 'history', to: 'hidden' },
  { tool: 'viewport', to: 'hidden' },
  { tool: 'screenshot', to: 'hidden' },
  { tool: 'reload', to: 'hidden' },
  { tool: 'project', to: 'compact' },
  { tool: 'select', to: 'hidden' },
]
/** On a canvas's board */
const BOARD_STEPS: FitStep[] = [
  { tool: 'select', to: 'compact' },
  { tool: 'chat', to: 'compact' },
  { tool: 'tool', to: 'hidden' },
  { tool: 'section', to: 'hidden' },
  { tool: 'zoom', to: 'hidden' },
  { tool: 'export', to: 'hidden' },
  { tool: 'canvas', to: 'compact' },
  { tool: 'select', to: 'hidden' },
]
/** With a frame open on the canvas */
const FRAME_STEPS: FitStep[] = [
  { tool: 'screenshot', to: 'compact' },
  { tool: 'select', to: 'compact' },
  { tool: 'chat', to: 'compact' },
  { tool: 'viewport', to: 'hidden' },
  { tool: 'screenshot', to: 'hidden' },
  { tool: 'reload', to: 'hidden' },
  { tool: 'select', to: 'hidden' },
]

/** The viewports as the "…" menu lists them, with their keys. */
const VIEWPORT_ITEMS: ToolbarMenuItem[] = VIEWPORT_SEGMENTS.map(({ value, label, shortcut }) => ({
  type: 'radio',
  id: `viewport:${value}`,
  label,
  shortcut,
}))

/** The toolbar's padding at rest, and whether the chat sidebar is sliding beside it. */
function useBar(state: WindowState, lights: boolean) {
  const header = useRef<HTMLElement>(null)
  const room = sidebarRoom(state, lights)
  useSidebarBar(header, room)
  return { header, padding: barPadding(room, lights), sliding: useSidebarSliding() }
}

/**
 * The window's toolbar: the project menu, then, once a project is open, the preview's
 * navigation, its address (with the dev server's status), viewport, screenshot, Record, Select
 * and the chat. Groups sit a gap apart; controls are 28px. Short of room, tools go into the
 * "…" menu (PROJECT_STEPS) so the address keeps ADDRESS_MIN.
 */
export function Toolbar({ state }: { state: WindowState }) {
  const { project, preview } = state
  // With two or more tabs the traffic lights sit in the tab row above (tab-strip.tsx), and
  // with the chat sidebar in its header.
  const tabbed = state.tabs.length > 1
  const { header, padding, sliding } = useBar(state, !tabbed && !state.fullScreen)
  const { fit, overflowing } = useToolbarFit(header, project ? PROJECT_STEPS : [], {
    min: ADDRESS_MIN,
    padding,
    sliding,
  })
  // Picking and screenshots only work on the local app.
  const capturable = preview.visible && preview.selectable
  const shown = (tool: string) => fit(tool) !== 'hidden'
  const keys = (tool: string) => fit(tool) === 'full'

  if (state.board) return <BoardToolbar state={state} board={state.board} named={!tabbed} />

  const more: ToolbarMenuItem[] = []
  const section = (...items: ToolbarMenuItem[]) => {
    if (more.length) more.push({ type: 'separator' })
    more.push(...items)
  }
  if (!shown('history') || !shown('reload')) {
    section(
      ...(shown('history')
        ? []
        : [
            { id: 'back', label: 'Back', shortcut: 'back', enabled: preview.canGoBack } as const,
            {
              id: 'forward',
              label: 'Forward',
              shortcut: 'forward',
              enabled: preview.canGoForward,
            } as const,
          ]),
      ...(shown('reload')
        ? []
        : [
            {
              id: 'reload',
              label: 'Reload Preview',
              shortcut: 'reload',
              enabled: !!preview.url,
            } as const,
          ]),
    )
  }
  if (!shown('viewport')) {
    section(...VIEWPORT_ITEMS.map((item) => viewportItem(item, preview.viewport)))
  }
  if (!shown('screenshot') || !shown('select')) {
    section(
      ...(shown('screenshot')
        ? []
        : [
            {
              id: 'screenshot',
              label: 'Screenshot…',
              shortcut: 'screenshot',
              enabled: capturable,
            } as const,
          ]),
      ...(shown('select')
        ? []
        : [
            {
              type: 'checkbox',
              id: 'select',
              label: 'Select Element',
              shortcut: 'selectElement',
              checked: preview.selecting,
              enabled: capturable,
            } as const,
          ]),
    )
  }

  return (
    <header
      ref={header}
      className="drag flex shrink-0 items-center gap-2 border-b border-line bg-surface"
      style={{ height: TOOLBAR_HEIGHT }}
    >
      <ProjectMenuButton state={state} named={!tabbed && fit('project') !== 'compact'} />

      {project && (
        <>
          {(shown('history') || shown('reload')) && (
            <div className="flex shrink-0 items-center gap-0.5">
              {shown('history') && (
                <>
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
                </>
              )}
              {shown('reload') && (
                <IconButton
                  label="Reload preview"
                  shortcut="reload"
                  icon={RotateCw}
                  spinning={preview.loading}
                  disabled={!preview.url}
                  onClick={() => gui.reload()}
                />
              )}
            </div>
          )}

          <AddressBar state={state} />

          {shown('viewport') && (
            <SegmentedControl
              label="Viewport"
              segments={VIEWPORT_SEGMENTS}
              value={preview.viewport}
              onChange={(viewport) => gui.setViewport(viewport)}
              iconOnly
              className="shrink-0"
            />
          )}

          <div className="flex shrink-0 items-center gap-1">
            {/* Mounted while it's in the "…" menu too: ⇧⌘S opens its menu from here. */}
            <ScreenshotButton
              disabled={!capturable}
              keys={keys('screenshot')}
              hidden={!shown('screenshot')}
            />
            <RecordButton state={state} disabled={!capturable} />
            {shown('select') && (
              <IconButton
                label="Select element"
                shortcut="selectElement"
                keys={keys('select')}
                icon={MousePointer2}
                pressed={preview.selecting}
                emphasis="strong"
                disabled={!capturable}
                onClick={() => gui.toggleSelect()}
              />
            )}
          </div>

          {overflowing && (
            <MoreButton
              items={more}
              onChoose={(id, button) => {
                if (id === 'back') gui.back()
                else if (id === 'forward') gui.forward()
                else if (id === 'reload') gui.reload()
                else if (id === 'select') gui.toggleSelect()
                else if (id === 'screenshot') void screenshotUnder(button)
                else chooseViewport(id)
              }}
            />
          )}

          <ChatButton visible={state.chatVisible} keys={keys('chat')} />
        </>
      )}
    </header>
  )
}

/** "Show chat" or "Hide chat", by whether it's showing (⌘B). */
function ChatButton({ visible, keys }: { visible: boolean; keys: boolean }) {
  return (
    <IconButton
      label={visible ? 'Hide chat' : 'Show chat'}
      shortcut="toggleChat"
      keys={keys}
      icon={MessageSquare}
      pressed={visible}
      onClick={() => gui.toggleChat()}
    />
  )
}

/** A viewport's item in the "…" menu, checked when it's the one showing. */
function viewportItem(item: ToolbarMenuItem, viewport: Viewport): ToolbarMenuItem {
  return item.type === 'separator' ? item : { ...item, checked: item.id === `viewport:${viewport}` }
}

function chooseViewport(id: string) {
  const viewport = VIEWPORTS.find((each) => `viewport:${each.id}` === id)
  if (viewport) gui.setViewport(viewport.id)
}

/**
 * The toolbar's "…": the tools there's no room for, as a native menu under it (a popover in
 * the page would open under the preview). `onChoose` does what was chosen.
 */
function MoreButton({
  items,
  onChoose,
}: {
  items: ToolbarMenuItem[]
  onChoose: (id: string, button: HTMLElement | null) => void
}) {
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return (
    <IconButton
      ref={button}
      id={MORE_ID}
      label="More tools"
      icon={Ellipsis}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={async () => {
        const box = button.current?.getBoundingClientRect()
        if (!box) return
        setOpen(true)
        const id = await gui.showToolbarMenu(items, { x: box.left, y: box.bottom + MENU_GAP })
        setOpen(false)
        if (id) onChoose(id, button.current)
      }}
    />
  )
}

/**
 * A canvas's toolbar. On the board: the canvas's menu (and its name, renamed in place), a new
 * frame, and the board's zoom. With a frame open: the way back to the board, the frame's
 * name, and the preview's viewport, screenshot and Select, as for a project. Short of room,
 * tools go into the "…" menu (BOARD_STEPS, FRAME_STEPS).
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
  const { header, padding, sliding } = useBar(state, named && !state.fullScreen)
  const { fit, overflowing } = useToolbarFit(header, open ? FRAME_STEPS : BOARD_STEPS, {
    min: open ? FRAME_NAME_MIN : BOARD_GAP_MIN,
    padding,
    sliding,
    key: open ? 'frame' : 'board',
  })
  const shown = (tool: string) => fit(tool) !== 'hidden'
  const keys = (tool: string) => fit(tool) === 'full'
  useEffect(
    () =>
      gui.onBoardCommand((command) => {
        if (command.type === 'renameBoard') setRenaming(true)
      }),
    [],
  )

  const selection = board.selection.length
  const exportLabel = selection > 1 ? `Export ${selection} frames as PNG` : 'Export as PNG'
  // The frame ⌘D opens to pick in: the one selected, or the only one (tab.ts).
  const canPick = selection === 1 || (!selection && board.frames.length === 1)

  const more: ToolbarMenuItem[] = []
  const section = (...items: ToolbarMenuItem[]) => {
    if (!items.length) return
    if (more.length) more.push({ type: 'separator' })
    more.push(...items)
  }
  if (open) {
    if (!shown('reload'))
      section({ id: 'reload', label: 'Reload Frame', shortcut: 'reload', enabled: !!preview.url })
    if (!shown('viewport'))
      section(...VIEWPORT_ITEMS.map((item) => viewportItem(item, preview.viewport)))
    section(
      ...(shown('screenshot')
        ? []
        : [
            {
              id: 'screenshot',
              label: 'Screenshot…',
              shortcut: 'screenshot',
              enabled: capturable,
            } as const,
          ]),
      ...(shown('select')
        ? []
        : [
            {
              type: 'checkbox',
              id: 'select',
              label: 'Select Element',
              shortcut: 'selectElement',
              checked: preview.selecting,
              enabled: capturable,
            } as const,
          ]),
    )
  } else {
    if (!shown('section') || !shown('tool'))
      section(
        ...(shown('section')
          ? []
          : [{ id: 'section', label: 'Add Section', enabled: !!selection } as const]),
        ...(shown('tool')
          ? []
          : BOARD_TOOLS.map(
              (tool): ToolbarMenuItem => ({
                type: 'radio',
                id: `tool:${tool.value}`,
                label: tool.label,
                checked: boardTool === tool.value,
              }),
            )),
      )
    if (!shown('export') || !shown('select'))
      section(
        ...(shown('export')
          ? []
          : [
              {
                id: 'export',
                // As the frame's own menu says it (tab.ts).
                label: selection > 1 ? `Export ${selection} Frames as PNG…` : 'Export as PNG…',
                enabled: !!selection,
              } as const,
            ]),
        ...(shown('select')
          ? []
          : [
              {
                id: 'select',
                label: 'Select Element',
                shortcut: 'selectElement',
                enabled: canPick,
              } as const,
            ]),
      )
    if (!shown('zoom') && boardView.camera)
      section(
        { id: 'zoomOut', label: 'Zoom Out' },
        { id: 'zoomFit', label: 'Zoom to Fit' },
        { id: 'zoomIn', label: 'Zoom In' },
      )
  }

  const choose = (id: string, button: HTMLElement | null) => {
    if (id === 'reload') gui.reload()
    else if (id === 'screenshot') void screenshotUnder(button)
    else if (id === 'select') gui.toggleSelect()
    else if (id === 'section') gui.boardAddSection(board.selection)
    else if (id === 'export') gui.boardExport(board.selection)
    else if (id === 'zoomOut') boardView.zoomBy(0.8)
    else if (id === 'zoomIn') boardView.zoomBy(1.25)
    else if (id === 'zoomFit') boardView.fit()
    else if (id.startsWith('tool:')) {
      const tool = BOARD_TOOLS.find((each) => `tool:${each.value}` === id)
      if (tool) setBoardTool(tool.value)
    } else chooseViewport(id)
  }

  const chat = <ChatButton visible={state.chatVisible} keys={keys('chat')} />
  const nameShown = named && fit('canvas') !== 'compact'

  return (
    <header
      ref={header}
      className="drag flex shrink-0 items-center gap-2 border-b border-line bg-surface"
      style={{ height: TOOLBAR_HEIGHT }}
    >
      {renaming ? (
        <input
          // biome-ignore lint/a11y/noAutofocus: renaming starts by typing the new name.
          autoFocus
          aria-label="Canvas name"
          defaultValue={board.name}
          className="no-drag h-7 w-56 shrink-0 rounded-md border border-accent bg-raised px-2 text-small text-fg outline-none"
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
          aria-label={nameShown ? undefined : 'Canvas menu'}
          title="Canvas menu"
          className="max-w-64"
          onClick={() => gui.showBoardMenu()}
        >
          {nameShown && <span className="min-w-0 truncate text-fg">{board.name}</span>}
        </Button>
      )}

      {open ? (
        <>
          <Button
            variant="ghost"
            icon={ArrowLeft}
            className="shrink-0"
            onClick={() => gui.boardOpenFrame(null)}
          >
            Board
          </Button>
          <p data-fit-flex="" className="min-w-0 flex-1 truncate text-small font-medium text-fg">
            {open.name}
            <span className="ml-2 font-normal text-subtle tabular-nums">
              {open.width} × {open.height}
            </span>
          </p>
          {shown('reload') && (
            <IconButton
              label="Reload frame"
              shortcut="reload"
              icon={RotateCw}
              spinning={preview.loading}
              disabled={!preview.url}
              onClick={() => gui.reload()}
            />
          )}
          {shown('viewport') && (
            <SegmentedControl
              label="Viewport"
              segments={VIEWPORT_SEGMENTS}
              value={preview.viewport}
              onChange={(viewport) => gui.setViewport(viewport)}
              iconOnly
              className="shrink-0"
            />
          )}
          {(shown('screenshot') || shown('select')) && (
            <div className="flex shrink-0 items-center gap-1">
              <ScreenshotButton
                disabled={!capturable}
                keys={keys('screenshot')}
                hidden={!shown('screenshot')}
              />
              {shown('select') && (
                <IconButton
                  label="Select element"
                  shortcut="selectElement"
                  keys={keys('select')}
                  icon={MousePointer2}
                  pressed={preview.selecting}
                  emphasis="strong"
                  disabled={!capturable}
                  onClick={() => gui.toggleSelect()}
                />
              )}
            </div>
          )}
          {!shown('screenshot') && !shown('select') && (
            // ⇧⌘S still opens the screenshot menu, under the "…".
            <ScreenshotButton disabled={!capturable} keys={false} hidden />
          )}
          {overflowing && <MoreButton items={more} onChoose={choose} />}
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
            className="shrink-0"
            onClick={() => {
              const box = frameButton.current?.getBoundingClientRect()
              if (box) gui.showAddFrameMenu({ x: box.left, y: box.bottom + MENU_GAP })
            }}
          >
            Frame
          </Button>
          {shown('section') && (
            <IconButton
              label="Add section"
              title="Add a section around the selected frames (⌥⌘G)"
              icon={Group}
              disabled={!selection}
              onClick={() => gui.boardAddSection(board.selection)}
            />
          )}
          {shown('tool') && (
            <SegmentedControl
              label="Tool"
              segments={BOARD_TOOLS}
              value={boardTool}
              onChange={setBoardTool}
              iconOnly
              className="shrink-0"
            />
          )}
          <div data-fit-flex="" className="min-w-0 flex-1" />
          {(shown('export') || shown('select')) && (
            <div className="flex shrink-0 items-center gap-1">
              {shown('export') && (
                <IconButton
                  label={exportLabel}
                  icon={ImageDown}
                  disabled={!selection}
                  onClick={() => gui.boardExport(board.selection)}
                />
              )}
              {shown('select') && (
                <IconButton
                  label="Select element"
                  shortcut="selectElement"
                  keys={keys('select')}
                  icon={MousePointer2}
                  emphasis="strong"
                  disabled={!canPick}
                  onClick={() => gui.toggleSelect()}
                />
              )}
            </div>
          )}
          {shown('zoom') && boardView.camera && (
            <div className="flex shrink-0 items-center gap-0.5">
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
          {overflowing && <MoreButton items={more} onChoose={choose} />}
          {chat}
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
function ScreenshotButton({
  disabled,
  keys,
  hidden = false,
}: {
  disabled: boolean
  keys: boolean
  /** In the "…" menu: not drawn, but ⇧⌘S still opens its menu (under the "…", or the window) */
  hidden?: boolean
}) {
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
  // Hidden, its menu opens under the "…" that holds it.
  useEffect(
    () =>
      gui.onCommand(async (command) => {
        if (command !== 'screenshot') return
        const anchor = button.current ?? document.querySelector<HTMLElement>(`#${MORE_ID}`)
        const label = await screenshotUnder(anchor)
        if (label) setDone({ label })
      }),
    [],
  )

  if (hidden) return null
  return (
    <>
      <IconButton
        ref={button}
        label="Screenshot"
        shortcut="screenshot"
        keys={keys}
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
    <form onSubmit={submit} data-fit-flex="" className="no-drag min-w-0 flex-1">
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
          // A round target around the dot, its focus ring and hover drawn on the circle so
          // they stay clear of the address beside it.
          <button
            type="button"
            aria-label={`Dev server: ${label}`}
            aria-haspopup="menu"
            title={tooltip}
            onClick={() => gui.showDevServerMenu()}
            className={`group flex h-full shrink-0 items-center pr-1.5 pl-1 outline-none ${PRESS}`}
          >
            <span className="flex size-5 items-center justify-center rounded-full transition-[background-color,opacity] group-hover:bg-hover group-focus-visible:outline-2 group-focus-visible:outline-offset-0 group-focus-visible:outline-accent">
              <StatusDot status={status} />
            </span>
          </button>
        }
      />
    </form>
  )
}
