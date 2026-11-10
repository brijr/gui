import { type CSSProperties, memo, type RefObject, useEffect, useRef, useState } from 'react'
import type { BoardCamera, BoardSection } from '../../../shared/board'
import { boardPoint, boardViewFromBoard } from '../../../shared/coords'
import type { BoardFrame, BoardState } from '../../../shared/types'
import { cn } from '../lib/cn'
import { FIELD_LOOK } from '../lib/field'
import { onBoardCommand, sendIntent } from './intents'
import { HANDLE, LABEL_HEIGHT, overlayScene, SECTION_INSET, SECTION_LABEL_HEIGHT } from './scene'

/*
 * The DOM over the board's canvas: one layer in board pixels that the camera moves and
 * scales, holding each frame's tile (transparent: what a press lands on, what a screen reader
 * and the specs find), the names and their rename fields, and the resize handle's grip; then
 * the live region. The canvas under it draws the pixels: sections, frames, thumbnails, what's
 * selected, the handle and the marquee.
 */

/** What the names on the board do, by the frame's or section's id. */
export interface LabelActions {
  selectFrame: (id: string, add: boolean) => void
  renameFrame: (id: string) => void
  renamedFrame: (id: string, name: string | null) => void
  renamedSection: (id: string, name: string | null) => void
}

/**
 * Which name is being edited, a frame's or a section's, and what the names do, by id. A field
 * whose frame or section is gone (deleted, by the agent or ⌘Z) closes with it; one that closes
 * (Enter, Esc) gives the keyboard back to the board, rather than leaving it nowhere.
 */
export function useNaming(
  board: BoardState,
  select: (ids: string[]) => void,
  element: RefObject<HTMLElement | null>,
) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renamingSection, setRenamingSection] = useState<string | null>(null)
  useEffect(() => {
    if (renaming && !board.frames.some((frame) => frame.id === renaming)) setRenaming(null)
    if (renamingSection && !board.sections.some((section) => section.id === renamingSection))
      setRenamingSection(null)
  }, [board.frames, board.sections, renaming, renamingSection])
  // A menu's Rename opens the field.
  useEffect(
    () =>
      onBoardCommand((command) => {
        if (command.type === 'renameFrame') setRenaming(command.id)
        else if (command.type === 'renameSection') setRenamingSection(command.id)
      }),
    [],
  )
  const naming = renaming ?? renamingSection
  const wasNaming = useRef(naming)
  useEffect(() => {
    const was = wasNaming.current
    wasNaming.current = naming
    if (was && !naming && document.activeElement === document.body) {
      element.current?.focus({ preventScroll: true })
    }
  }, [naming, element])

  // The same functions every render, so a name redraws only when something it shows changes
  // (not at every step of a drag).
  const actions = useRef<LabelActions | null>(null)
  actions.current = {
    selectFrame: (id, add) => {
      // ⇧ on a selected frame's name deselects it, as on the frame.
      if (!add) select([id])
      else if (board.selection.includes(id)) select(board.selection.filter((other) => other !== id))
      else select([...board.selection, id])
    },
    renameFrame: (id) => setRenaming(id),
    renamedFrame: (id, name) => {
      setRenaming(null)
      const frame = board.frames.find((f) => f.id === id)
      if (name && frame && name !== frame.name) sendIntent({ type: 'renameFrame', id, name })
    },
    renamedSection: (id, name) => {
      setRenamingSection(null)
      const section = board.sections.find((s) => s.id === id)
      if (name && section && name !== section.name) sendIntent({ type: 'renameSection', id, name })
    },
  }
  const [labels] = useState<LabelActions>(() => ({
    selectFrame: (id, add) => actions.current?.selectFrame(id, add),
    renameFrame: (id) => actions.current?.renameFrame(id),
    renamedFrame: (id, name) => actions.current?.renamedFrame(id, name),
    renamedSection: (id, name) => actions.current?.renamedSection(id, name),
  }))
  return { renaming, renamingSection, setRenaming, setRenamingSection, labels }
}

export function BoardOverlay({
  layer,
  camera,
  size,
  hand,
  frames,
  sections,
  selected,
  single,
  picked,
  renaming,
  renamingSection,
  active,
  tiles,
  labels,
  announcement,
}: {
  layer: RefObject<HTMLDivElement | null>
  /** React's camera, which the live one leads during a gesture (it writes the layer itself) */
  camera: BoardCamera
  size: { width: number; height: number }
  hand: boolean
  /** As drawn this moment, with what a gesture drew ahead of main */
  frames: BoardFrame[]
  sections: readonly BoardSection[]
  selected: ReadonlySet<string>
  /** The one frame selected, which has the resize handle */
  single: string | null
  /** The section picked by its name */
  picked: BoardSection | undefined
  renaming: string | null
  renamingSection: string | null
  /** The frame a screen reader is on, whose tile stays mounted wherever it is */
  active: string | null
  /** What the tiles' element ids start with (`tileId`) */
  tiles: string
  labels: LabelActions
  /** What's selected, said to a screen reader as it changes */
  announcement: string
}) {
  const { zoom } = camera
  const origin = boardViewFromBoard(boardPoint(0, 0), camera)
  const { shown, areas, named, sized } = overlayScene(frames, sections, camera, size, {
    frames: [renaming, active],
    section: renamingSection,
  })
  const grip = single && !hand ? shown.find((frame) => frame.id === single) : undefined
  return (
    <>
      {/*
        The board itself, in board pixels: one layer the camera moves and scales, so a pan or
        zoom changes it alone and none of the frames inside. Names and the handle in it are
        drawn at screen size (`pinned`).
      */}
      <div
        ref={layer}
        className="absolute top-0 left-0 origin-top-left"
        style={
          {
            transform: `translate(${origin.x}px, ${origin.y}px) scale(${zoom})`,
            '--board-zoom': zoom,
            '--board-unzoom': 1 / zoom,
          } as CSSProperties
        }
      >
        {/* The frames are options a screen reader moves through: the board's active descendant. */}
        {shown.length > 0 && (
          <div role="listbox" aria-label="Frames" aria-multiselectable="true">
            {shown.map((frame) => (
              <FrameTile
                key={frame.id}
                id={tileId(tiles, frame.id)}
                frame={frame}
                selected={selected.has(frame.id)}
              />
            ))}
          </div>
        )}

        {/* Names after every frame: no frame hides a section's name, or another frame's. */}
        {areas.map(({ section, area }) => (
          <SectionLabel
            key={section.id}
            name={section.name}
            id={section.id}
            x={area.x}
            y={area.y}
            width={area.width}
            picked={picked?.id === section.id}
            hand={hand}
            renaming={renamingSection === section.id}
            onDone={labels.renamedSection}
          />
        ))}
        {shown.map((frame) => {
          const hasRoom = named(frame)
          return (
            <FrameLabel
              key={frame.id}
              frame={frame}
              named={hasRoom}
              sized={hasRoom && sized(frame)}
              selected={selected.has(frame.id)}
              renaming={renaming === frame.id}
              hand={hand}
              onSelect={labels.selectFrame}
              onRename={labels.renameFrame}
              onDone={labels.renamedFrame}
            />
          )
        })}

        {/* The one frame selected has a handle at its corner, drawn by the canvas. */}
        {grip && (
          <div
            data-resize={grip.id}
            aria-hidden="true"
            // 10px drawn, 26px to grab: nothing else sits at the corner.
            className="cursor-nwse-resize before:absolute before:-inset-2"
            style={{
              ...pinned(
                { x: grip.x + grip.width, y: grip.y + grip.height },
                { x: -HANDLE / 2, y: -HANDLE / 2 },
              ),
              width: HANDLE,
              height: HANDLE,
            }}
          />
        )}
      </div>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </>
  )
}

/**
 * Where something drawn at screen size sits in the board layer: its top-left at board point
 * `at`, then moved by `shift` screen pixels. Undoes the layer's zoom as the camera draws it
 * (--board-unzoom), so neither a pan nor a pinch leaves it behind.
 */
function pinned(
  at: { x: number; y: number },
  shift: { x: number; y: number } = { x: 0, y: 0 },
): CSSProperties {
  return {
    position: 'absolute',
    left: at.x,
    top: at.y,
    transformOrigin: '0 0',
    transform: `scale(var(--board-unzoom)) translate(${shift.x}px, ${shift.y}px)`,
  }
}

/** `pixels` on the board, as screen pixels at the zoom the camera draws. */
const onScreen = (pixels: number) => `calc(${pixels}px * var(--board-zoom))`

/** Redrawn only when something it shows changes: main sends new objects for the same frame. */
function sameFrame(a: BoardFrame, b: BoardFrame) {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height &&
    a.version === b.version &&
    a.captured === b.captured
  )
}

/**
 * A frame's element id on the board: `prefix` (one board's own) and the frame's id, with
 * anything but letters, digits and hyphens spelled out, so the id is one token.
 */
export function tileId(prefix: string, frame: string) {
  const safe = frame.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.codePointAt(0)?.toString(16)}_`)
  return `${prefix}-frame-${safe}`
}

/**
 * Where a frame is on the board, with no pixels of its own (the canvas draws it): what a
 * press lands on, and to a screen reader an option named for the frame, selected or not.
 * Before its first capture it says so.
 */
const FrameTile = memo(
  function FrameTile({
    id,
    frame,
    selected,
  }: {
    id: string
    frame: BoardFrame
    selected: boolean
  }) {
    return (
      // biome-ignore lint/a11y/useFocusableInteractive: the board keeps focus and points at the option it's on (aria-activedescendant).
      <div
        id={id}
        data-frame={frame.id}
        role="option"
        aria-label={frame.name}
        aria-selected={selected}
        className="absolute overflow-hidden"
        style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
      >
        {!frame.captured && (
          <div
            className="p-3 text-caption whitespace-nowrap text-subtle"
            style={pinned({ x: 0, y: 0 })}
          >
            Rendering…
          </div>
        )}
      </div>
    )
  },
  (a, b) => sameFrame(a.frame, b.frame) && a.id === b.id && a.selected === b.selected,
)

/** A frame's name above it, and its size; double-click renames it in place. */
const FrameLabel = memo(
  function FrameLabel({
    frame,
    named,
    sized,
    selected,
    renaming,
    onSelect,
    onRename,
    onDone,
    hand,
  }: {
    frame: BoardFrame
    /** There's room for its name above it (zoomed out, there may not be) */
    named: boolean
    /** And for its size after the name */
    sized: boolean
    selected: boolean
    renaming: boolean
    onSelect: (id: string, add: boolean) => void
    onRename: (id: string) => void
    onDone: (id: string, name: string | null) => void
    /** The Hand is on: a press here pans the board like anywhere else */
    hand: boolean
  }) {
    const style = {
      ...pinned({ x: frame.x, y: frame.y }, { x: 0, y: -LABEL_HEIGHT }),
      height: LABEL_HEIGHT,
      // No wider than the frame: zoomed out, neighbours' names would run into each other.
      maxWidth: `max(${onScreen(frame.width)}, 24px)`,
    }
    const finished = useRef(false)
    const finish = (value: string | null) => {
      if (finished.current) return
      finished.current = true
      onDone(frame.id, value)
    }
    if (renaming)
      return (
        <input
          // biome-ignore lint/a11y/noAutofocus: renaming starts by typing the new name.
          autoFocus
          aria-label="Frame name"
          spellCheck={false}
          defaultValue={frame.name}
          className={`${FIELD_LOOK} px-1 text-caption`}
          style={{ ...style, width: `max(${onScreen(frame.width)}, 160px)` }}
          onFocus={(event) => {
            finished.current = false
            event.currentTarget.select()
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation()
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') finish(event.currentTarget.value.trim() || null)
            if (event.key === 'Escape') finish(null)
          }}
          onBlur={(event) => finish(event.currentTarget.value.trim() || null)}
        />
      )
    if (!named) return null
    return (
      <p
        data-frame-label={frame.id}
        className={cn(
          'flex items-center gap-1.5 truncate text-caption whitespace-nowrap',
          selected ? 'text-accent-text' : 'text-muted',
        )}
        style={style}
        // Its own clicks: a press selects the frame (no drag from here), a double-click renames.
        onPointerDown={(event) => {
          if (event.button !== 0 || hand) return
          event.stopPropagation()
          onSelect(frame.id, event.shiftKey)
        }}
        onDoubleClick={hand ? undefined : () => onRename(frame.id)}
      >
        <span className="truncate font-medium" title={frame.name}>
          {frame.name}
        </span>
        {/* Narrow on screen, the name matters more than the size. */}
        {sized && (
          <span className="shrink-0 text-subtle tabular-nums">
            {frame.width} × {frame.height}
          </span>
        )}
      </p>
    )
  },
  ({ frame: a, ...before }, { frame: b, ...after }) =>
    sameFrame(a, b) &&
    before.named === after.named &&
    before.sized === after.sized &&
    before.selected === after.selected &&
    before.renaming === after.renaming &&
    before.hand === after.hand &&
    before.onSelect === after.onSelect &&
    before.onRename === after.onRename &&
    before.onDone === after.onDone,
)

/**
 * A section's name in its top-left corner: press it to pick the section and drag its frames,
 * double-click to rename, right-click for its menu (the board handles all three).
 */
const SectionLabel = memo(function SectionLabel({
  id,
  name,
  x,
  y,
  width,
  picked,
  hand,
  renaming,
  onDone,
}: {
  id: string
  name: string
  /** The section's top-left corner and width, in board pixels */
  x: number
  y: number
  width: number
  picked: boolean
  hand: boolean
  renaming: boolean
  onDone: (id: string, name: string | null) => void
}) {
  /** As wide as the section leaves room for on screen, and never too narrow to read */
  const maxWidth = `max(calc(${onScreen(width)} - ${SECTION_INSET * 2}px), 120px)`
  const style = {
    ...pinned({ x, y }, { x: SECTION_INSET, y: SECTION_INSET }),
    height: SECTION_LABEL_HEIGHT,
    maxWidth,
  }
  const finished = useRef(false)
  const finish = (value: string | null) => {
    if (finished.current) return
    finished.current = true
    onDone(id, value)
  }
  if (renaming)
    return (
      <input
        // biome-ignore lint/a11y/noAutofocus: renaming starts by typing the new name.
        autoFocus
        aria-label="Section name"
        spellCheck={false}
        defaultValue={name}
        className={`${FIELD_LOOK} px-2 text-small font-medium`}
        style={{ ...style, width: `min(${maxWidth}, 240px)` }}
        onFocus={(event) => {
          finished.current = false
          event.currentTarget.select()
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') finish(event.currentTarget.value.trim() || null)
          if (event.key === 'Escape') finish(null)
        }}
        onBlur={(event) => finish(event.currentTarget.value.trim() || null)}
      />
    )
  return (
    <p
      data-section={id}
      className={cn(
        'flex items-center truncate rounded-md px-2 text-small font-medium whitespace-nowrap',
        picked ? 'bg-accent-soft text-accent-text' : 'bg-raised text-fg shadow-raised',
        !hand && 'cursor-default',
      )}
      style={style}
    >
      <span className="truncate" title={name}>
        {name}
      </span>
    </p>
  )
})
