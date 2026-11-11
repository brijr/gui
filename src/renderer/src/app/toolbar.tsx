import { type FormEvent, useEffect, useRef, useState } from 'react'
import { TOOLBAR_HEIGHT } from '../../../shared/layout'
import {
  ariaShortcut,
  type ShortcutId,
  VIEWPORT_SHORTCUTS,
  withShortcut,
} from '../../../shared/shortcuts'
import {
  type BoardState,
  type CustomViewport,
  type DeviceViewport,
  frameViewport,
  isCustomViewport,
  isViewport,
  type PreviewState,
  type ToolbarMenuItem,
  VIEWPORTS,
  type Viewport,
  viewportSpec,
  type WindowState,
} from '../../../shared/types'
import { type BoardTool, setBoardTool, useBoardTool, useBoardView } from '../board/view'
import { gui } from '../lib/api'
import { cn } from '../lib/cn'
import { FIELD_LOOK, Input } from '../lib/field'
import {
  ArrowDownCircle,
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  ChevronDown,
  Crop,
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
  Ruler,
  Shapes,
  Smartphone,
  Tablet,
} from '../lib/icons'
import { StatusDot } from '../lib/status'
import { Button, HIT_AREA, IconButton, OPEN, PRESS, SegmentedControl } from '../lib/ui'
import { barPadding, sidebarRoom, useSidebarBar, useSidebarSliding } from './layout-morph'
import { RecordButton } from './record-button'
import { serverStatus } from './server-status'
import { type FitStep, useToolbarFit } from './toolbar-fit'

const VIEWPORT_ICONS: Record<DeviceViewport, IconComponent> = {
  desktop: Monitor,
  laptop: Laptop,
  tablet: Tablet,
  mobile: Smartphone,
}
/** Named like the View menu's items, with their shortcut; the tooltip adds the size. */
const VIEWPORT_CHOICES = VIEWPORTS.map(({ id, name, size }) => {
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
/**
 * The address field's room before anything else gives way: an address like localhost:5173/,
 * with the status dot before it and Back, Forward and Reload after it.
 */
const ADDRESS_MIN = 240
/** The frame's name on a canvas, and the room before the board's zoom, likewise */
const FRAME_NAME_MIN = 96
const BOARD_GAP_MIN = 8

/**
 * The order the project toolbar makes room in (toolbar-fit.ts): the viewport, Rulers and
 * Screenshot go into the "…" menu, then the project button drops the branch, then the
 * project's name, then Select. Back, Forward and Reload are the address field's own; Record and the chat
 * button always stay. Shortcuts are in the tooltips, never shown as keys here.
 */
const PROJECT_STEPS: FitStep[] = [
  { tool: 'viewport', to: 'hidden' },
  { tool: 'rulers', to: 'hidden' },
  { tool: 'screenshot', to: 'hidden' },
  { tool: 'branch', to: 'compact' },
  { tool: 'project', to: 'compact' },
  { tool: 'select', to: 'hidden' },
]
/** On a canvas's board */
const BOARD_STEPS: FitStep[] = [
  { tool: 'tool', to: 'hidden' },
  { tool: 'section', to: 'hidden' },
  { tool: 'zoom', to: 'hidden' },
  { tool: 'export', to: 'hidden' },
  { tool: 'canvas', to: 'compact' },
  { tool: 'select', to: 'hidden' },
]
/** With a frame open on the canvas */
const FRAME_STEPS: FitStep[] = [
  { tool: 'viewport', to: 'hidden' },
  { tool: 'screenshot', to: 'hidden' },
  { tool: 'reload', to: 'hidden' },
  { tool: 'select', to: 'hidden' },
]

/** The viewports as the "…" menu lists them, with their keys. */
const VIEWPORT_ITEMS: ToolbarMenuItem[] = VIEWPORT_CHOICES.map(({ value, label, shortcut }) => ({
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
 * The window's toolbar: the project menu (naming the project and its branch), then, once a
 * project is open, the address (with the dev server's status, and the preview's history and
 * Reload at its end), viewport, Rulers, Select, screenshot, Record and the chat. Groups sit a gap
 * apart; controls are 28px, in the quietest text color until pointed at. Short of room, tools
 * go into the "…" menu (PROJECT_STEPS) so the address keeps ADDRESS_MIN.
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
  const uncapturable = captureBlocked(preview, false)
  const capturable = uncapturable === null
  const shown = (tool: string) => fit(tool) !== 'hidden'

  if (state.board) return <BoardToolbar state={state} board={state.board} named={!tabbed} />

  const more: ToolbarMenuItem[] = []
  const section = (...items: ToolbarMenuItem[]) => {
    if (more.length) more.push({ type: 'separator' })
    more.push(...items)
  }
  // A size of its own in a project is the agent's, checking a width for a moment.
  const checking = isCustomViewport(preview.viewport) ? preview.viewport : null
  if (!shown('viewport')) section(...viewportItems(preview.viewport, checking))
  const tools: ToolbarMenuItem[] = []
  if (!shown('rulers'))
    tools.push({
      type: 'checkbox',
      id: 'rulers',
      label: 'Rulers',
      shortcut: 'rulers',
      checked: preview.rulers,
    })
  if (!shown('screenshot'))
    tools.push({
      id: 'screenshot',
      label: 'Screenshot…',
      shortcut: 'screenshot',
      enabled: capturable,
    })
  if (!shown('select'))
    tools.push({
      type: 'checkbox',
      id: 'select',
      label: 'Design Mode',
      shortcut: 'selectElement',
      checked: preview.selecting,
      enabled: capturable,
    })
  if (tools.length) section(...tools)

  return (
    <header
      ref={header}
      className="drag flex shrink-0 items-center gap-2 border-b-hairline border-line bg-surface"
      style={{ height: TOOLBAR_HEIGHT }}
    >
      <ProjectMenuButton
        state={state}
        named={!tabbed && fit('project') !== 'compact'}
        branched={fit('branch') !== 'compact'}
      />

      {project ? (
        <>
          <AddressBar state={state} />
          <UpdateButton version={state.updateReady} />

          {shown('viewport') && (
            <ViewportButton
              viewport={preview.viewport}
              own={checking}
              ownTitle="The agent’s check"
            />
          )}

          <div className="flex shrink-0 items-center gap-1">
            {shown('rulers') && <RulersButton on={preview.rulers} />}
            {shown('select') && (
              <SelectButton unavailable={uncapturable} selecting={preview.selecting} />
            )}
            {/* Mounted while it's in the "…" menu too: ⇧⌘S opens its menu from here. */}
            <ScreenshotButton unavailable={uncapturable} hidden={!shown('screenshot')} />
            <RecordButton state={state} unavailable={uncapturable} />
          </div>

          {overflowing && (
            <MoreButton
              items={more}
              onChoose={(id, button) => {
                if (id === 'select') gui.toggleSelect()
                else if (id === 'rulers') gui.toggleRulers()
                else if (id === 'screenshot') void screenshotUnder(button)
                else chooseViewport(id)
              }}
            />
          )}

          <ChatButton visible={state.chatVisible} />
        </>
      ) : (
        state.updateReady && (
          <div className="ml-auto flex">
            <UpdateButton version={state.updateReady} />
          </div>
        )
      )}
    </header>
  )
}

/**
 * A new version of Gui is downloaded: one quiet button restarts into it, as the app menu's
 * Restart to Update does. Right after the address bar, so only the bar gives up room for it
 * and no other control moves when it appears.
 */
function UpdateButton({ version }: { version: string | null }) {
  if (!version) return null
  return (
    <IconButton
      label={`Restart to update to ${version}`}
      icon={ArrowDownCircle}
      onClick={() => gui.restartToUpdate()}
      className={cn(HIT_AREA, 'text-accent-text')}
    />
  )
}

/** "Show chat" or "Hide chat", by whether it's showing (⌘B). */
function ChatButton({ visible }: { visible: boolean }) {
  return (
    <IconButton
      label={visible ? 'Hide chat' : 'Show chat'}
      shortcut="toggleChat"
      icon={MessageSquare}
      pressed={visible}
      onClick={() => gui.toggleChat()}
      className={HIT_AREA}
    />
  )
}

/** A viewport's item in the "…" menu, checked when it's the one showing. */
function viewportItem(item: ToolbarMenuItem, viewport: Viewport): ToolbarMenuItem {
  return item.type === 'separator' ? item : { ...item, checked: item.id === `viewport:${viewport}` }
}

/** The size menu: an open canvas frame's own size (`own`) first when it has one, then the devices. */
function viewportItems(viewport: Viewport, own: CustomViewport | null) {
  const items: ToolbarMenuItem[] = own
    ? [
        { type: 'radio', id: `viewport:${own}`, label: viewportSpec(own).name },
        { type: 'separator' },
        ...VIEWPORT_ITEMS,
      ]
    : VIEWPORT_ITEMS
  return items.map((item) => viewportItem(item, viewport))
}

function chooseViewport(id: string) {
  const viewport = id.replace(/^viewport:/, '')
  if (isViewport(viewport) || isCustomViewport(viewport)) gui.setViewport(viewport)
}

/**
 * The preview's size: the viewport showing, as its icon, which opens a menu of the others
 * (⌘1–⌘4 pick one straight away). A native menu, as it opens over the preview. `own` is a
 * size of its own: an open canvas frame's, or a width the agent is checking (`ownTitle` says which).
 */
function ViewportButton({
  viewport,
  own = null,
  ownTitle = 'The frame’s size',
}: {
  viewport: Viewport
  own?: CustomViewport | null
  ownTitle?: string
}) {
  const button = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const current =
    own && viewport === own
      ? {
          label: viewportSpec(own).name,
          title: `${ownTitle} · ${viewportSpec(own).name}`,
          icon: Crop,
        }
      : (VIEWPORT_CHOICES.find((choice) => choice.value === viewport) ?? VIEWPORT_CHOICES[0])
  return (
    <Button
      ref={button}
      variant="ghost"
      icon={current?.icon}
      trailingIcon={ChevronDown}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`Viewport: ${current?.label}`}
      title={current?.title}
      // An icon tool like its neighbours: their quiet color, and on while its menu is open.
      className={cn(HIT_AREA, OPEN, 'shrink-0 gap-1 px-1.5 text-subtle')}
      onClick={async () => {
        const box = button.current?.getBoundingClientRect()
        if (!box) return
        setOpen(true)
        const items = viewportItems(viewport, own)
        const id = await gui.showToolbarMenu(items, { x: box.left, y: box.bottom + MENU_GAP })
        setOpen(false)
        if (id) chooseViewport(id)
      }}
    />
  )
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
      className={cn(HIT_AREA, OPEN)}
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
  const uncapturable = captureBlocked(preview, true)
  const capturable = uncapturable === null
  const open = board.frames.find((frame) => frame.id === board.open)
  // The open frame's own size, a choice of its own when it's no device's (tab.ts fitFrame).
  const opened = open ? frameViewport(open) : null
  const own = isCustomViewport(opened) ? opened : null
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
    if (!shown('viewport')) section(...viewportItems(preview.viewport, own))
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
              label: 'Design Mode',
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
                label: 'Design Mode',
                // ⌘D duplicates on the board; it's Design Mode's once a frame is open.
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

  const chat = <ChatButton visible={state.chatVisible} />
  const nameShown = named && fit('canvas') !== 'compact'

  return (
    <header
      ref={header}
      className="drag flex shrink-0 items-center gap-2 border-b-hairline border-line bg-surface"
      style={{ height: TOOLBAR_HEIGHT }}
    >
      {renaming ? (
        <input
          // biome-ignore lint/a11y/noAutofocus: renaming starts by typing the new name.
          autoFocus
          aria-label="Canvas name"
          spellCheck={false}
          defaultValue={board.name}
          className={`${FIELD_LOOK} no-drag h-7 min-w-20 max-w-64 field-sizing-content shrink-0 px-2 text-small`}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
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
          className={cn(HIT_AREA, 'max-w-64')}
          onClick={() => gui.showBoardMenu()}
        >
          {nameShown && (
            <span title={board.name} className="min-w-0 truncate text-fg">
              {board.name}
            </span>
          )}
        </Button>
      )}

      {open ? (
        <>
          <Button
            variant="ghost"
            icon={ArrowLeft}
            className={cn(HIT_AREA, 'shrink-0')}
            onClick={() => gui.boardOpenFrame(null)}
          >
            Canvas
          </Button>
          {/* Its size is the caption's, over the frame in the preview. */}
          <p
            data-fit-flex=""
            className="flex min-w-0 flex-1 items-center text-small font-medium text-fg"
          >
            <span className="truncate" title={open.name}>
              {open.name}
            </span>
          </p>
          {shown('reload') && (
            <IconButton
              label="Reload frame"
              shortcut="reload"
              icon={RotateCw}
              loading={preview.loading}
              disabled={!preview.url}
              onClick={() => gui.reload()}
              className={HIT_AREA}
            />
          )}
          {shown('viewport') && <ViewportButton viewport={preview.viewport} own={own} />}
          {(shown('screenshot') || shown('select')) && (
            <div className="flex shrink-0 items-center gap-1">
              {shown('select') && (
                <SelectButton unavailable={uncapturable} selecting={preview.selecting} />
              )}
              <ScreenshotButton unavailable={uncapturable} hidden={!shown('screenshot')} />
            </div>
          )}
          {!shown('screenshot') && !shown('select') && (
            // ⇧⌘S still opens the screenshot menu, under the "…".
            <ScreenshotButton unavailable={uncapturable} hidden />
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
            className={cn(HIT_AREA, 'shrink-0')}
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
              title="Add a section around the selected frames"
              shortcut="canvasSection"
              icon={Group}
              disabled={!selection}
              onClick={() => gui.boardAddSection(board.selection)}
              className={HIT_AREA}
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
                  shortcut="canvasExport"
                  icon={ImageDown}
                  disabled={!selection}
                  onClick={() => gui.boardExport(board.selection)}
                  className={HIT_AREA}
                />
              )}
              {shown('select') && (
                <IconButton
                  label="Design mode"
                  icon={MousePointer2}
                  disabled={!canPick}
                  onClick={() => gui.toggleSelect()}
                  className={HIT_AREA}
                />
              )}
            </div>
          )}
          {shown('zoom') && (
            // Its place is kept until the board has a camera, so nothing beside it moves then.
            <div
              aria-hidden={!boardView.camera || undefined}
              className={cn('flex shrink-0 items-center gap-1', !boardView.camera && 'invisible')}
            >
              <IconButton
                label="Zoom out"
                shortcut="zoomOut"
                icon={Minus}
                onClick={() => boardView.zoomBy(0.8)}
                className={HIT_AREA}
              />
              <ZoomPercent
                zoom={boardView.camera?.zoom ?? 1}
                action="zoom to fit"
                title="Zoom to fit"
                onClick={() => boardView.fit()}
              />
              <IconButton
                label="Zoom in"
                shortcut="zoomIn"
                icon={Plus}
                onClick={() => boardView.zoomBy(1.25)}
                className={HIT_AREA}
              />
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
 * unless the tab row does already, then its branch, quieter and read only (Git is the agent's
 * and the terminal's), so a switch doesn't go unnoticed: "gui · main". Short of room, the
 * branch goes, then the name; long ones end in "…", and the tooltip has them whole.
 */
function ProjectMenuButton({
  state,
  named,
  branched,
}: {
  state: WindowState
  named: boolean
  /** Room for the branch's name */
  branched: boolean
}) {
  const { project } = state
  // The monorepo app being previewed
  const app = project?.appDir?.slice(project.appDir.lastIndexOf('/') + 1)
  const name = project ? `${project.name}${app ? ` / ${app}` : ''}` : 'Gui'
  const branch = project && state.branch ? (state.branch.branch ?? 'No branch') : null
  const shown = { name: named, branch: branch !== null && branched }
  // The project and branch whole, for when the line is cut short or left out.
  const full = [name, branch].filter(Boolean).join(' · ')
  return (
    <Button
      variant="ghost"
      icon={Folder}
      trailingIcon={ChevronDown}
      aria-haspopup="menu"
      aria-label={shown.name || shown.branch ? undefined : 'Project menu'}
      title={project ? full : 'Project menu'}
      className={cn(HIT_AREA, 'max-w-120')}
      onClick={() => gui.showProjectMenu()}
    >
      {(shown.name || shown.branch) && (
        // One line that ends in "…" once, where it runs out: the branch gives way before the
        // name, so the project always reads first.
        <span className="min-w-0 truncate font-normal text-subtle">
          {shown.name && (
            <>
              <span className="font-medium text-fg">{project?.name ?? 'Gui'}</span>
              {app && ` / ${app}`}
            </>
          )}
          {shown.branch && (
            <>
              {shown.name && (
                <span aria-hidden="true" className="mx-1.5">
                  ·
                </span>
              )}
              <span className="sr-only">{shown.name ? ', branch ' : 'Branch '}</span>
              <span className="font-mono">{branch}</span>
            </>
          )}
        </span>
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
/**
 * Why the capture tools (Screenshot, Record, Select) can't be used just now, or null when they
 * can. They stay in the tab order then, aria-disabled, with this as their tooltip, so the
 * keyboard reaches them and hears why rather than skipping a dimmed button.
 */
function captureBlocked(preview: PreviewState, board: boolean): string | null {
  if (preview.website) return 'Only your own app can be captured'
  if (!preview.visible)
    return board ? 'Open a frame to capture it' : 'Start the dev server to capture'
  if (!preview.selectable) return 'Only your own app can be captured'
  return null
}

/** The rulers and guides over the preview, on or off (⇧R, View → Rulers). */
function RulersButton({ on }: { on: boolean }) {
  return (
    <IconButton
      label="Rulers"
      shortcut="rulers"
      icon={Ruler}
      pressed={on}
      className={HIT_AREA}
      onClick={() => gui.toggleRulers()}
    />
  )
}

function SelectButton({
  unavailable,
  selecting,
}: {
  unavailable: string | null
  selecting: boolean
}) {
  return (
    <IconButton
      label="Design mode"
      shortcut="selectElement"
      icon={MousePointer2}
      pressed={selecting}
      className={HIT_AREA}
      title={unavailable ?? undefined}
      aria-disabled={unavailable !== null || undefined}
      onClick={() => unavailable === null && gui.toggleSelect()}
    />
  )
}

function ScreenshotButton({
  unavailable,
  hidden = false,
}: {
  unavailable: string | null
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
        // The tooltip says what it did, for a moment.
        title={done?.label ?? unavailable ?? undefined}
        icon={done ? Check : Camera}
        className={HIT_AREA}
        aria-disabled={unavailable !== null || undefined}
        onClick={() => unavailable === null && void take()}
      />
      <span aria-live="polite" className="sr-only">
        {done?.label}
      </span>
    </>
  )
}

const ADDRESS_ID = 'preview-address'

/**
 * A control inside the address field, at its end: 20px tall, 4px in from the field's edge,
 * quiet until pointed at. Back, Forward, Reload, the page's zoom, Back to your app.
 */
const IN_FIELD = cn(
  HIT_AREA,
  'no-drag flex h-5 shrink-0 items-center rounded-sm text-subtle transition-[color,background-color,opacity] hover:bg-hover hover:text-fg disabled:opacity-40',
  PRESS,
)

/**
 * In the address field while the agent has a website open in the preview: closes it (and
 * clears its signed-out session), and the user's app shows again.
 */
function BackToApp() {
  return (
    <button
      type="button"
      onClick={() => gui.backToApp()}
      className={cn(IN_FIELD, 'px-1.5 text-caption font-medium text-fg')}
    >
      Back to your app
    </button>
  )
}

/**
 * A zoom level as a ghost button that sets it back: the canvas's (to fit, between its zoom
 * buttons), and Desktop's page zoom while it isn't 100% (`inField`: in the address field,
 * like a browser's). A device frame's label shows its own.
 */
function ZoomPercent({
  zoom,
  action,
  title,
  inField = false,
  shortcut,
  onClick,
}: {
  zoom: number
  /** What a click does, after the level in its name: "zoom to fit" */
  action: string
  title: string
  inField?: boolean
  shortcut?: ShortcutId
  onClick: () => void
}) {
  const percent = Math.round(zoom * 100)
  return (
    <button
      type="button"
      aria-label={`Zoom ${percent}%, ${action}`}
      title={shortcut ? withShortcut(title, shortcut) : title}
      aria-keyshortcuts={shortcut && ariaShortcut(shortcut)}
      onClick={onClick}
      className={
        inField
          ? cn(IN_FIELD, 'px-1.5 text-caption font-medium tabular-nums')
          : cn(
              HIT_AREA,
              'no-drag flex h-7 min-w-12 shrink-0 items-center justify-center rounded-md px-1.5 text-caption font-medium text-subtle tabular-nums transition-[color,background-color,opacity] hover:bg-hover hover:text-fg',
              PRESS,
            )
      }
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
 * the server is doing rather than a made-up address. A light fill in the toolbar, the field's
 * own look while editing.
 *
 * Its end holds the page's controls, as Safari's does Reload: Back and Forward only while
 * there's somewhere to go, then Reload once there's a page. They come and go at the field's
 * end, in room the address doesn't use, so neither the field's edges nor the address move.
 */
function AddressBar({ state }: { state: WindowState }) {
  const { preview, devServer, project, setup } = state
  // A website the agent opened has no history of the app's; Back to your app leaves it.
  const back = preview.website === null && preview.canGoBack
  const forward = preview.website === null && preview.canGoForward
  const reloadable = !!preview.url || preview.website !== null
  // While focused, the field shows the user's draft; otherwise it follows navigation.
  const [draft, setDraft] = useState<string | null>(null)
  // The address of what's on screen, or being loaded, or failed to load: the website the agent
  // opened over the app, while it's there.
  const url =
    preview.website ?? (preview.visible || preview.loading || preview.error ? preview.url : null)
  const value = draft ?? url ?? ''
  const { status, label } = serverStatus(state)
  // Like the canvas: without a dev script (or an app picked), the address is the way in.
  const noCommand = !project?.devCommand && !setup?.apps
  const placeholder = devServer.status === 'idle' && noCommand ? 'Enter your app’s address' : label
  // The label already says whether it stopped with an error; the exit code is in the logs.
  const tooltip = [label, devServer.command].filter(Boolean).join(' — ')

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
        mono={value !== ''}
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
        filled
        trailing={
          <span className="flex shrink-0 items-center gap-1 pr-1 pl-1.5">
            {preview.website ? (
              <BackToApp />
            ) : (
              preview.viewport === 'desktop' &&
              preview.zoom !== 1 && (
                <ZoomPercent
                  inField
                  zoom={preview.zoom}
                  action="reset to 100%"
                  title="Reset zoom"
                  shortcut="actualSize"
                  onClick={() => gui.zoomPreview(0)}
                />
              )
            )}
            {back && (
              <IconButton
                size="xs"
                className={HIT_AREA}
                label="Back"
                shortcut="back"
                icon={ArrowLeft}
                onClick={() => gui.back()}
              />
            )}
            {forward && (
              <IconButton
                size="xs"
                className={HIT_AREA}
                label="Forward"
                shortcut="forward"
                icon={ArrowRight}
                onClick={() => gui.forward()}
              />
            )}
            {reloadable && (
              <IconButton
                size="xs"
                className={HIT_AREA}
                label="Reload preview"
                shortcut="reload"
                icon={RotateCw}
                loading={preview.loading && preview.website === null}
                onClick={() => gui.reload()}
              />
            )}
          </span>
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
            className={`group no-drag flex h-full shrink-0 items-center pr-1.5 pl-1 outline-none ${PRESS}`}
          >
            <span className="flex size-5 items-center justify-center rounded-full transition-[background-color,opacity] group-hover:bg-hover group-focus-visible:outline-2 group-focus-visible:outline-offset-0 group-focus-visible:outline-muted">
              <StatusDot status={status} />
            </span>
          </button>
        }
      />
    </form>
  )
}
