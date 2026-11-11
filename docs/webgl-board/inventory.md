# The board today: an inventory

Everything `src/renderer/src/app/board.tsx` (1,586 lines on `0380bc9`) draws, handles, reads and
sends, and where each goes when the board's pixels move to WebGL. Line numbers are that commit's;
since stage 5 the board is split across `src/renderer/src/board/` (the README's Architecture).

**GL** drawn on the canvas. **DOM** stays an element over the canvas. **Mirror** an element
with no pixels of its own, kept for the pointer, a screen reader and the specs.

## What it draws

| What | Today | Goes to | Notes |
| --- | --- | --- | --- |
| Background, `--canvas` | `bg-canvas` on the board element | GL | The canvas is opaque; its clear colour is the board's. |
| Dot grid | CSS `radial-gradient` tiled at `24 × zoom`, hidden under 8px; position and size written per camera move (l.190) | GL | One full-view pass; same 1px dot at each cell's centre, same 8px cutoff. Today the cutoff follows React's throttled camera; in GL it is exact each frame. |
| Section area | `div`, `--fill` at 60%, 1 screen-px border (`--line`, `--accent` when picked), 12 screen-px radius, under frames (l.1017) | GL | Rounded-rect quad. |
| Frame tile | `div` in board pixels: `--raised`, `shadow-raised` (0 1px 2px, in board pixels so it grows with zoom), 1 screen-px `--line` outline inside the edge, `overflow: hidden` (l.1195) | GL + Mirror | Pixels in GL. The `div` stays, transparent, as `[data-frame]`: what a press lands on and what specs find. |
| Thumbnail | `<img>` as wide as the frame from its top; a frame taller than its capture is blank below; the new image loads over the old, never blank between (l.1236) | GL | One texture a frame. Same fit, same never-blank rule (the old texture draws until the new one is uploaded). |
| Small copy | `<id>.small` (360px) when `frame.width × zoom × dpr ≤ 360`, else the full one (≤1440px) (l.1041) | GL | Becomes one of nine widths from 90 to 1440. The 360 file is still what the five smallest load from. |
| Frame not captured yet | "Rendering…" in caption type at the tile's corner, at screen size, clipped by the tile (l.1213) | DOM | Text. Stays in the mirror tile. |
| Thumbnail that failed to load | The tile's `--raised` shows (the `<img>` `onError` keeps the tile) | GL | The frame's fill; not retried until its version changes. |
| Hover | Unselected frame's outline turns `--accent` under the pointer; off with the Hand (CSS `:hover`) | GL | From `pointerover` on the mirror tile. |
| Frame name | `<p>` above the frame at screen size, `--muted` (`--accent-text` when selected), truncated to the frame's width on screen (min 24px), `title` tooltip; hidden when it would cover the frame above or its section's name (`hasRoom`, l.939) | DOM | Unchanged. |
| Frame size | `1440 × 900` after the name, only at zoom ≥ 0.5 and ≥ 140px on screen | DOM | Unchanged. |
| Section name | Chip inside the section's top-left (10px inset), `--raised` + shadow, `--accent-soft` when picked, truncated, `title` | DOM | Unchanged. |
| Rename fields | `<input>` in place of a frame's or section's name | DOM | Unchanged. |
| Selection outline | 2 screen-px `--accent` outline outside each selected frame, above names (l.1085) | GL | Drawn under the names now (they are DOM over the canvas). It overlaps a name only by its 2px, at the name's bottom edge. |
| Resize handle | 10px rounded square, 2px `--accent` border, on the one selected frame's bottom-right corner; 26px to grab; `nwse-resize` cursor; hidden with the Hand | GL + Mirror | Square in GL; the `[data-resize]` element stays for the press and the cursor. |
| Marquee | 1px `--accent` border, `--accent-soft` fill, in screen pixels | GL | |
| Focus ring | 2px `--muted` outline inside the board when it has keyboard focus | DOM | On the board element, over the canvas. |
| Cursor | `grab` / `grabbing` with the Hand or Space; `nwse-resize` on the handle; default on a section's name | DOM | CSS on the board element and mirror. |
| Empty state | "Start your canvas" card with four starter prompts, a spinner line, an inline error | DOM | Unchanged. |
| Live region | `aria-live="polite"`: "X selected", "N frames selected", "<section> selected" | DOM | Unchanged. |
| Light and dark | CSS variables under `prefers-color-scheme` | GL reads them | `theme.ts` resolves the same variables to colours and reads them again when the scheme changes. |
| Display scale | The browser's | GL | The canvas's backing store is sized from `devicePixelContentBoxSize`; a change of display arrives through the same observer. |

Not on the board, and not affected: the open frame (a native view main owns), the device frame
around it (`DeviceFrame` in `canvas.tsx`), the toolbar's canvas controls, every native menu.

## Camera

| What | How | Goes to |
| --- | --- | --- |
| Live camera | A ref, written to one layer's `transform` and three CSS variables per move, without React (l.180) | The same ref; the canvas draws from it on the next animation frame |
| React's camera | Follows 100 ms behind during a gesture and 150 ms after it rests; drives culling and name rules (l.208) | Unchanged for the DOM over the canvas. The canvas culls exactly, every frame |
| Pan | Wheel: `camera += delta / zoom` | Unchanged |
| Zoom | ⌘-wheel `exp(-Δy × 0.002)`; pinch (⌃-wheel) `exp(-Δy × 0.01)` with Δy clamped to ±22; around the pointer; clamped 5%–200% | Unchanged |
| Zoom steps | ⌘= ⌘− (×1.25 around the centre), the toolbar's − / +, View menu → `BoardCommand zoom` | Unchanged |
| Fit | ⌘0, the toolbar, `BoardCommand fit`, first open without a saved camera; fits frames and sections in what the floating chat leaves clear (`boardChatCover`), 64px margin, at most 100% | Unchanged |
| Reveal | Tab onto a frame less than half in view centres it; frames the agent adds out of view glide into it on a spring, after any gesture ends | Unchanged |
| Glide | `Spring` on x and y, redirected mid-flight; jumps with Reduce motion or a hidden page | Unchanged: the only animation on the board, and it is the camera's |
| Culling | Frames within half a view beyond each edge are mounted (l.915) | Canvas: what intersects the view. DOM names and mirror: as today |
| Saving | `boardCamera` 400 ms after it rests, and as the board unmounts | Unchanged |

## Interactions

| Gesture | What happens | Hit test today |
| --- | --- | --- |
| Press empty board | `boardPressed` (the floating chat gets out of the way); a marquee starts; ⇧ adds to the selection; a click with no drag clears it | `closest('[data-frame], [data-frame-label], [data-section], [data-resize]')` is null |
| Press a frame | Selects it (⇧ adds, ⇧ on a selected one deselects on release); drag past 3px moves every selected frame, rounded to board pixels; a click on one of several selects it alone | `closest('[data-frame]')` |
| Second click within 400 ms | Opens the frame live (`boardOpenFrame`). Pointer capture means no `dblclick`: it is timed (l.800) | Same frame id |
| Press a frame's name | Selects without dragging; double-click renames | The label's own `onPointerDown` |
| Press a section's name | Picks the section (selects its frames), drags them all; second click renames | `closest('[data-section]')` |
| Press the handle | Resizes from the bottom-right, clamped 120–4000, size only sent | `closest('[data-resize]')` |
| Drag across sections | Frames join or leave sections as drawn (`regroupSections`), then as dropped (main) | Board rules |
| Hand tool, Space held, middle button | Drag pans | Tool state |
| Wheel during a drag | Ignored | |
| Right-click, ⌃-click | Native menu for the frame, its name, or the section (`showFrameMenu`, `showSectionMenu`); a section is picked first | `closest(...)` on `contextmenu` |
| Second finger or button | Ignored while a gesture is going | |
| Button released elsewhere | The gesture ends on the next move with no buttons | |

Keyboard, with the board focused (l.825): Delete/Backspace (frames, or the picked section
alone), ⌥⌘G section, ⌘D duplicate, ⇧⌘E export, ⌘A all, ⌘0 fit, ⌘= ⌘− zoom, H hand, V move,
Enter open, Esc deselect, F2 rename (`canvasRename`), ⇧F10 or the menu key (`canvasMenu`), Tab
and ⇧Tab through sections and frames (leaving the board past the last), arrows nudge 1px
(⇧ 10px) and land as one change on key-up or blur, Space for the Hand. Keys with ⌘, ⌃ or ⌥
the board doesn't use go on to the menu.

None of this moves: it reads ids from the mirror and geometry from board state.

There are no drop targets on the board, and no hand-off animation: opening a frame unmounts
the board and shows main's native view (`canvas.tsx` l.95); closing it mounts the board again
at the saved camera. Both were looked for and are not there.

## State read, intents sent

Reads `BoardState` (`id`, `name`, `frames` with `version` and `captured`, `sections`,
`selection`, `camera`, `thumbs`), `working` (a turn is running), the board tool, Reduce motion,
`devicePixelRatio`, and `boardChatCover()` for fitting.

Sends `boardSelect`, `boardArrange`, `boardOpenFrame`, `boardDelete`, `boardDuplicate`,
`boardExport`, `boardAddSection`, `boardDeleteSection`, `boardRenameFrame`,
`boardRenameSection`, `boardCamera`, `boardPressed`, `showFrameMenu`, `showSectionMenu`, and
`send` (a starter prompt). Listens to `onBoardCommand` (`renameFrame`, `renameSection`, `fit`,
`zoom`). Publishes `useBoardView` (zoom, `zoomBy`, `fit`) and `useBoardTool` to the toolbar.

Main is untouched by any of it.

## How the specs find it

Only four specs open a board. None finds a frame by role and name: they use the `data-frame`
attribute.

| Spec | What it touches on the board | With the mirror |
| --- | --- | --- |
| `canvas.spec.ts` "opens from the start screen…" | `getByText('Start your canvas')`; `[role="application"]` box; `[data-frame]` boxes (fit has landed when every one is inside and still); `[data-frame="desktop"]` `boundingBox()`, drag by mouse, `.click()`, `toBeVisible()`; two mouse clicks to open | Passes unchanged (run against the prototype) |
| `canvas.spec.ts` "zoomed out, the board shows small thumbnails…" | `[data-frame] img` `naturalWidth` (360 or 1440) and a blank-frame counter over `<img>`s; ⌘− ⌘= through `sendInputEvent` | Fails against the prototype, as it must: there are no `<img>`s. Its two reads change to the mirror tile saying which width is drawn (`data-thumb`) |
| `canvas.spec.ts` the other three, `canvas-flow.spec.ts`, `canvas-screenshot-url.spec.ts`, `screenshot.spec.ts` | Main's state, `window.gui.board*`, files on disk, the toolbar | Untouched (the three in `canvas.spec.ts` pass against the prototype; the others never touch the board's DOM and were not run) |
| Audit probes (`board.probe.ts`, `idle.probe.ts`) | `[role="application"]`, `[data-frame="frame-24"]`, `[data-frame] img` | The two that count `<img>` pixels read the canvas's own counts instead |
