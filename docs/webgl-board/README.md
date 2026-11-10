# The board in WebGL: measurements, decisions, plan

Moving the canvas board's drawing from DOM to WebGL. A prototype measured it and settled the
decisions below; all seven stages of the plan are done, so the board is drawn with WebGL in
`src/renderer/src/board/`, with a DOM overlay, and nothing else.
[inventory.md](inventory.md) lists everything the DOM board did and where each part went.
The prototype itself, its probe and its raw results are on the branch
`brijr/webgl-board-prototype` (commit `e9f7d31`).

## In short

The prototype draws a real canvas in WebGL with every interaction working, in 14 kB of our own
code and no library. It removes the DOM board's two measured costs: memory that grows when
zoomed in and is never given back (362 MB held after one zoom at 60 frames, where it began at
137), and strain when zooming boards past 60 frames. It adds one of its own: the canvas's
buffers, which make it about 90 MB heavier than the DOM board while fitted and at rest.

The recommendation is to go ahead with our own renderer, in the seven stages below, and to
look at that fixed cost in a visible window on the owner's display before stage 3 lands.

## The renderer

Until stage 7 it was behind a development switch (`GUI_BOARD_WEBGL=1`, unpackaged builds),
so the two boards could be compared like for like; the measurements below are from then.
(The prototype also had `GUI_DEV_MAX_FRAMES`, to open canvases of 500 and 2,000 frames for
the measurements; it was not carried over.)

It kept the board's DOM and moved only its pixels: the board mounts a canvas under its DOM
(`surface.tsx` and `gl/` in `src/renderer/src/board/`), and the tiles stay, transparent.
Names, rename fields, the empty state and every pointer and keyboard handler are the same
code as before.

| File | What it is |
| --- | --- |
| `scene.ts` | Board state + camera + view size → quads in paint order, and the texture width each frame wants. No WebGL, no DOM; `tests/board-scene.test.ts` reads it. |
| `gl/renderer.ts` | WebGL2: one instanced unit square, shaped in the fragment shader (rounded rectangle, fill, stroke, thumbnail, soft shadow), and the dot grid. |
| `gl/textures.ts` | One texture a frame at the width it is drawn; loading, budget, eviction, lost context. |
| `gl/theme.ts` | The board's inks read from the page's own CSS variables. |
| `surface.tsx` | The canvas element and when it draws: on demand, once a frame at most. Marks each tile with the thumbnail width it holds (`data-thumb`); says when WebGL2 can't start (`BoardUnavailable`). |

Also: `BoardPoint`/`BoardRect` and `BoardViewPoint`/`BoardViewRect` in `src/shared/coords.ts`
and the camera's arithmetic in `src/renderer/src/board/camera.ts`; `gui-thumb:` readable by
`fetch` with CORS (`recordings.ts`, `board.ts`, the CSP's `connect-src`);
Specs: `e2e/canvas.spec.ts`, and `e2e/canvas-surface.spec.ts` for a lost context, the appearance, the display's scale, and no WebGL2.

## Measurements

One machine (Apple M5 Max, 5K display at 2×), the unpackaged production build, hidden, a
fresh user-data folder each launch, a 1440 × 920 window. DOM and WebGL are the same build with
the switch off and on. The boards are the audit's: desktop frames (1440 × 900) of generated
pages, ten across at 60, 25 across at 500, 50 across at 2,000.

The probe is `docs/webgl-board/board-webgl.probe.ts` on the prototype branch (copy it beside
the audit's probes to run it; it uses their harness, and the prototype's statistics hook,
which was not carried over), and the runs quoted here are in `results.json` beside it. Each
cell is one run unless a range is given.

| | 60 DOM | 60 WebGL | 500 DOM | 500 WebGL | 2,000 DOM | 2,000 WebGL |
| --- | --- | --- | --- | --- | --- | --- |
| **Panning**, 6.7 s of wheel, three runs: long tasks | 0 | 0 | 0 | 0 | 0 | 0 |
| frames over 33 ms | 0 | 0 | 0 | 0–1 | 0 | 0 |
| page CPU, ms | 312–346 | 301–354 | 559–728 | 630–669 | 1,149–1,320 | 1,061–1,366 |
| GPU process CPU, ms | 322–386 | 238–255 | 538–633 | 362–367 | 689–715 | 420–502 |
| **Zooming** in and out, 4.7 s of ⌘-wheel, two runs: long tasks | 0 | 0 | 0–1 (52 ms) | 0 | 0–1 (66 ms) | 0 |
| frames over 33 ms (longest gap) | 0 | 0 | 2–3 (100 ms) | 0 | 0–3 (84 ms) | 0 |
| page CPU, ms | 561–586 | 304–383 | 1,228–1,481 | 474–475 | 1,142–1,473 | 552–558 |
| Script time of one canvas draw, ms | | 0.06–0.14 | | 0.07–0.16 | | 0.09–0.27 |
| **Memory**, page / GPU process, MB: fitted | 50 / 86 | 52 / 176 | 75 / 148 | 93 / 266 | 121 / 108 | 80 / 228 |
| zoomed in (frames 243 CSS px wide) | 107 / 229 | 67 / 274 | 171 / 378 | 104 / 353 | 204 / 353 | 82 / 342 |
| 8 s after fitting again | 112 / 250 | 69 / 185 | 187 / 452 | 104 / 277 | 257 / 480 | 85 / 262 |
| the two together: fitted → in → after | 137 → 336 → 362 | 228 → 341 → 254 | 223 → 549 → 639 | 358 → 456 → 381 | 230 → 557 → 737 | 308 → 424 → 347 |
| Thumbnail pixels held: fitted, in, after, MB | 19, 267, 19 decoded | 9, 63, 19 in textures | 154, 593, 154 | 28, 85, 31 | 422, 544, 411 | 28, 94, 31 |
| **Load**: a page reload to every thumbnail in view drawn, ms (median of three) | 42 | 84 | 177 | 288 | 452 | 280 |
| First open, to every thumbnail captured (main's work), s | 3.4 | 3.9 | 30 | 27 | 110 | 112–144 |

Script added to the window: its chunk went from 138.1 kB to 156.0 kB (47.5 → 54.5 kB
gzipped). The renderer, scene, textures and theme alone are 14.2 kB (5.8 kB gzipped).

What the table says:

- **Moving was never the problem and still is not.** Neither board dropped below 60 frames a
  second while panning at any size. Zooming is where the DOM board shows strain past 60 frames
  (a long task and 84–100 ms gaps at 500 and 2,000, as it swaps hundreds of images); the
  canvas has none, at less than half the page CPU.
- **At 60 frames WebGL costs memory at rest and gives it back afterwards.** Fitted, it holds
  about 90 MB more than the DOM board, nearly all of it the canvas's own buffers (below).
  Zoomed in the two are level. Afterwards the DOM board keeps what it took (362 MB, and it was
  137) while the canvas returns to where it was (254; the 26 over 228 is a wider fit after ⌘0,
  so wider textures).
- **The page process is where it is clearly better**: 52 → 67 → 69 MB against 50 → 107 → 112.
- **Past 60 frames the canvas's memory stops growing with the board.** 500 and 2,000 frames
  hold the same textures, because the same 360 are in view; the DOM board at 2,000 has 1,330
  images mounted and 737 MB after one zoom.
- **Loading is slower on the canvas at 60 and 500**, by 40 and 110 ms: every thumbnail is a
  `fetch` and a decode on another thread, eight at a time, where `<img>` has Chromium's own
  pipeline. It is faster at 2,000 because it loads what is in view (360) and the DOM board
  mounts 1,330.

Things to know about the numbers:

- The memory runs collect garbage before reading (the audit's `held` reads first) and open the
  board alone (the audit had a project tab open too). Read the audit's way, the DOM board at
  60 came out at 58 → 116–119 → 109–112 MB for the page and 100–107 → 249–271 → 200–216 for
  the GPU process, against the audit's 61.5 → 104.7 → 107.3 and 117 → 257 → 227.
- Run to run, a reading moves by up to about 30 MB. One WebGL run at 500 read 523 MB in the
  GPU process after fitting again, 272 MB of it in the category the DOM board fills, with the
  textures at their usual 31 MB; two reruns read 286 both times. Not explained.
- GPU memory for 360 small textures is about three times their pixels (84 MB for 28 MB): each
  texture carries overhead of its own. An atlas for the smallest widths would remove it, and
  would also be the batching the renderer lacks; neither is needed at 60 frames.
- The motion runs at 500 and 2,000 for WebGL were made before the last change to which widths
  textures load at (finer steps). That changes what is loaded when the zoom rests, not how a
  frame is drawn.
- Hidden windows here drew at the display's 60 frames a second in every run, both boards.

## Decisions

### Renderer: our own, on WebGL2

The prototype's renderer, scene, texture cache and theme are 1,018 lines with their comments
and 14.2 kB minified (5.8 kB gzipped). They draw 60 frames in 0.06–0.14 ms of script a frame and
360 in 0.07–0.27 ms; the window's script grew from 138.1 kB to 156.0 kB (47.5 → 54.5 kB gzipped),
which includes the switch that the last stage deletes.

PixiJS 8.22, bundled the same way with only what a board needs (`WebGLRenderer`, `Container`,
`Sprite`, `Graphics`, `Texture`; no WebGPU, no autodetect), is 453 kB minified (130 kB
gzipped): about as much script as the whole window loads today (446 kB). With `Application`
it is 532 kB; with `Text`, 568 kB.

What it would bring, against what the board needs:

- **Text.** `Text` rasterises to a texture and blurs under zoom unless redrawn; `BitmapText`
  needs a font atlas and has no system-font fallback or ellipsis. The board keeps names in
  DOM (below), so it would use neither.
- **Events.** Pixi hit-tests its own display tree in its own coordinates. The board's presses
  already land on mirror elements placed by the camera, and AGENTS.md wants positions to go
  through `coords.ts` types, which Pixi's events would bypass.
- **Culling.** A rectangle test against the view: one line in `scene.ts`.
- **Texture garbage collection.** Pixi frees textures unused for a number of frames. The board
  needs something else: a width per frame chosen from how large it is drawn, replaced when
  that changes, under a byte budget. That is `textures.ts` either way.
- **Batching.** Real, and the one thing the prototype lacks: Pixi draws up to 16 textures a
  call, the prototype one. At 360 frames in view that is 360 calls in 0.2 ms of script. It would matter
  for thousands in view at once, which today's 5% zoom floor does not allow with frames of
  ordinary size.

Fewer dependencies and less code to own both point the same way here: a library would add
450 kB and one dependency, and remove perhaps 300 of the 1,018 lines (the shader and the draw
loop). No PixiJS renderer was built, so its speed is not measured; its size is.

### Textures

- **Decode off the main thread.** `fetch` the thumbnail, `createImageBitmap(blob, { resizeWidth })`:
  Chromium decodes and resizes on a worker thread. The bitmap is uploaded during the next draw
  (no upload starts once a frame's have taken 4 ms; the longest a frame's took was 8.3 ms, one
  1440-wide texture) and closed at once. No
  long task was recorded in any WebGL run. `gui-thumb:` had to become fetchable with CORS,
  because WebGL refuses pixels read without it.
- **Widths, not mip levels, are how memory is held down.** A frame gets one texture, at the
  smallest of nine widths from 90 to 1440 pixels (each about 1.4 times the last) that is 1.2
  times as wide as it is drawn in device pixels. So everything in view holds at most three
  times the canvas's own pixels, whatever the number of frames and whatever the zoom. The 1.2
  is for sharpness: drawn at very nearly its own width a texture is visibly softer than the
  DOM board's thumbnail, and with it the two match.
- **The 360px copy stays, alongside.** A mip chain exists only once the full image has been
  decoded and uploaded, which is the cost the small copy avoids: it is what the three smallest
  widths load from, a small read and a quick decode. Mip levels are generated only for
  textures wider than 360, and only used mid-pinch, when a texture is drawn at less than half
  its width before the zoom rests.
- **Replaced at rest.** A texture is swapped for another width 120 ms after the zoom stops
  changing; a frame with nothing to show loads at once. The old one draws until the new one
  is uploaded: never blank, which is today's rule. Before this, a two-second pinch reloaded
  every frame at each width it passed (2,139 loads in one probe run at 500 frames; 759
  after).
- **Budget and eviction.** `3 × canvas pixels × 4 bytes × 4/3 + 32 MB` (112 MB for a
  1440 × 870 board on a Retina display). Frames in view are never evicted; textures of frames
  out of view go least-recently-drawn first when over. Frames that leave the board give theirs
  up at once, and unmounting the board (opening a frame) frees everything.
- **Lost context.** The canvas takes `webglcontextlost` (and prevents the default, or it is
  never given back), forgets its textures, and on `webglcontextrestored` makes its programs
  again and redraws; textures load as frames are drawn, the same path as first open. Probed
  with `WEBGL_lose_context`: 60 frames drawn again in 60 ms, 360 in 220 ms. And with the
  app's GPU process killed under the board: the context was lost within 10 ms and every
  thumbnail was drawn again 1.05 s later, on Chromium's new GPU process.

### Text: DOM names, moved by the same camera

Names and sizes stay the elements they are, inside one layer that carries the camera's
transform, each scaled back to screen size by a CSS variable: one style write per camera move,
and Chromium rasterises them at the display's scale like any other text. They are sharp at
every zoom because they are never scaled: the same text the board draws today, pixel for pixel
in the screenshots.

Drawing text in WebGL would mean owning an atlas, truncation with an ellipsis, font fallback
for names in any script, and a theme-and-scale invalidation, to replace something that
costs, at 360 names in view, less than the React commit that already runs every 100 ms. The
rename field has to be DOM in any case. Reconsider only if names show in frame times; the
remedy then is fewer names (the existing has-room rule), not a text renderer.

### Accessibility and tests: the board's DOM is the mirror

The brief expected specs to find frames by role and name. They do not: they use
`[data-frame="<id>"]` for its box, a click and visibility, `[role="application"]`, and one
spec reads `<img>` widths. And a screen reader today gets the board as one `application` with
instructions, a polite live region ("Pricing selected"), and Tab stepping the selection;
frames have no role.

So the mirror already exists. Each frame's tile stays where it is, transparent, positioned by
the camera's layer: it is what a press lands on (the same `closest('[data-frame]')`), what
specs find, and what assistive tech can be pointed at. Run against the prototype,
`e2e/canvas.spec.ts` passes 4 of 5 unchanged; the fifth reads `<img>` and needs the tile to
say which width is drawn (`data-thumb`), two lines of the spec.

Stage 6 gave the mirror what it lacked: each tile is an `option` named for its frame, with
`aria-selected`, in a `listbox` ("Frames", multi-selectable) inside the board's
`application`; the board's `aria-activedescendant` follows the selection, so a screen reader
speaks the frame Tab moves to. The board keeps the focus, as before; the options aren't
focusable themselves.

### Coordinates

`coords.ts` gains the board's two spaces: `BoardPoint`/`BoardRect` (board pixels, where frames
are kept) and `BoardViewPoint`/`BoardViewRect` (the board element's CSS pixels), with the four
conversions through the camera. The scene emits `BoardViewRect`s. Device pixels are never a
rect in script: the canvas's backing size comes from `ResizeObserver`'s
`devicePixelContentBoxSize`, and the shader is given the view's CSS size and one
CSS-pixels-per-device-pixel number.

Hit testing has two halves. *What* is under the pointer is the mirror element the browser
finds; no arithmetic. *Where* (a drag's distance, the marquee against frames, zoom about the
pointer, fit) is arithmetic, and today it is untyped: `board.tsx` multiplies by `camera.zoom`
inline in a dozen places. Stage 1 moves that into `camera.ts` behind these types.

### Could `MAX_FRAMES` rise?

The canvas stops being the reason for it. What it draws and holds is bounded by the view:
500 and 2,000 frames both drew about 360 quads at the 5% zoom floor in 0.07–0.27 ms, with the
same 28 MB of textures.

Main is the limit, measured on synthetic boards (the prototype's `GUI_DEV_MAX_FRAMES`):

| | 60 | 500 | 2,000 |
| --- | --- | --- | --- |
| Capturing every thumbnail (one at a time, 55 ms each) | 3.4–3.9 s | 27–30 s | 110–144 s |
| `state` messages while that happens, each the whole board | 66 × 12 kB | 507 × 66 kB (32 MB) | 2,008 × 254 kB (487 MB) |
| Main process CPU for it | 1.8–2.2 s | 14–15 s | 55–64 s |
| Window page CPU for it (React, one commit a message) | 0.3–0.4 s | 3.5–4.4 s | 23–25 s |

Also: `board-ipc.ts` drops any list over 100 ids (⌘A then Delete does nothing past 100
frames); capture priority follows the selection, not what is in view; the name rule
(`hasRoom`) is frames shown × frames, every commit; the 5% zoom floor means a large board
cannot be seen whole.

Raising it is its own piece of work in main (send changes, not the board; capture what is in
view first; lift the list limits), after this move, and a product decision: nothing in the
prototype argues for a number.

## Architecture

The prototype's five files stay. What changed in stage 5 is `board.tsx`, which was one
component holding the camera, four gestures, the keyboard, culling, name rules and all the
JSX. As built:

```
src/renderer/src/board/
  camera.ts       pure   zoom about a point, pan, fit in the area the chat leaves clear, reveal;
                         in BoardPoint / BoardViewPoint, never bare numbers
  scene.ts        pure   what is shown: frames in view, which names fit and whether sizes do,
                         section areas, the quads and texture widths for the canvas
  gestures.ts     pure   press / move / release → the gesture under way and what it asks for
                         (select, arrange, open, rename, pan); today's onPointerDown/Move/finish
  keys.ts         pure   a key → what it asks for; today's onKeyDown
  intents.ts             the one place that calls window.gui for the board
  view.ts                useBoardView / useBoardTool, for the toolbar; Space held as the Hand
  use-camera.ts   React  the live camera and React's copy; the wheel, fit, zoom steps, reveals
                         and glides, saving it, and publishing it to the toolbar
  gl/renderer.ts         WebGL2 only: knows quads, not frames
  gl/textures.ts
  gl/theme.ts
  surface.tsx     React  the canvas and its draw loop; the message when WebGL2 can't start
  overlay.tsx     React  the DOM over the canvas: names, rename fields (useNaming), the mirror
                         tiles and handle (what is pressed, what specs and a screen reader
                         find), the live region
  empty.tsx       React  the empty state
  board.tsx       React  the shell: owns the camera (through use-camera.ts) and the gesture,
                         feeds events to gestures.ts and keys.ts and does what they ask, runs
                         the board's own effects (menu commands, focus, what's picked). Under
                         400 lines.
```

How React fits: React renders the overlay from state that changes at human speed (the board
from main, what is selected, the camera 100 ms behind a gesture, as today). The canvas never
waits for React: a camera move writes one transform on the overlay's layer and marks the
canvas dirty, and the next animation frame draws from the live camera. Nothing draws while
nothing changes.

The pure modules take and return plain data, so the rules that are easy to break (which
frame a drag moves, when a click is a double-click, where a name has room) get unit tests
they have never had.

## Stages

All seven are done (2026-11-10), one commit each. Each leaves main working and releasable. S is under 100 lines changed, M under 400, L more.

1. **Thumbnails readable as pixels** (S, main). `gui-thumb:` gets `supportFetchAPI` and
   `corsEnabled`, its responses `Access-Control-Allow-Origin`, the CSP `connect-src`;
   `THUMB_WIDTH` moves to `src/shared/board.ts`. *Proves it:* `canvas.spec.ts` "zoomed out,
   the board shows small thumbnails…" still passes; a new assertion that the window page can
   `fetch` a thumbnail and a previewed page cannot. Needs a person: it changes the CSP.
   **Done.**
2. **Board coordinates** (M). The board types in `coords.ts`; zoom-about-a-point, pan, fit,
   reveal and the marquee test move from `board.tsx` to `board/camera.ts` in those types.
   *Proves it:* `tests/coords.test.ts`, a new `tests/board-camera.test.ts`, `canvas.spec.ts`.
   **Done**: `src/renderer/src/board/camera.ts`.
3. **The canvas, behind the development switch** (L, but written: 1,200 lines and 140 of
   tests). `scene.ts`, `gl/`, `surface.tsx` as prototyped; tiles stop painting when it is on.
   Unpackaged builds only, so no user can reach it. *Proves it:* `tests/board-gl-scene.test.ts`;
   `canvas.spec.ts` run a second time with the switch (4 of 5 pass today). **Done**, in
   `src/renderer/src/board-gl/` rather than `board/gl/`, without the prototype's probe hooks
   (moved to `board/` and `board/gl/` in stage 5).
4. **Parity** (M). The tile says which width is drawn, and the thumbnails spec reads that;
   a message in place of the board if WebGL2 cannot start; specs for a lost context, a change
   of appearance and of display scale; texture megabytes after zooming in and fitting again as
   a spec. *Proves it:* all of `canvas.spec.ts` with the switch; a new `canvas-surface.spec.ts`;
   the prototype's probe. **Done**, except the texture-megabytes spec, which needs a
   statistics hook the app doesn't otherwise want; the probe still measures it. The scale spec
   changes the ratio of device to CSS pixels by page zoom: a test can't move the window to
   another display, and Chromium's emulated scale doesn't change what a canvas is drawn at.
5. **Split `board.tsx`** (L, a pure refactor; two reviews: gestures and keys, then the
   overlay). `gestures.ts`, `keys.ts`, `intents.ts`, `view.ts`, `overlay.tsx`, `empty.tsx`;
   `board.tsx` under 400 lines. *Proves it:* new unit tests for gestures and keys;
   `canvas.spec.ts` both ways, `canvas-flow.spec.ts`. **Done**: `board.tsx` went from 1,608
   lines in `app/` to 396 in `board/`, as laid out under Architecture, with two files the plan
   didn't name: `use-camera.ts`, the live camera and everything that moves it but a drag (the
   wheel, fit, zoom steps, reveals, glides, saving it, the toolbar's view), and the canvas's
   `BoardUnavailable` beside it in `surface.tsx`. `scene.ts` holds both halves of what is
   shown (the canvas's quads, and the DOM's culling and name rules, `overlayScene`); the rename
   fields' state is `useNaming` in `overlay.tsx`. `tests/board-gestures.test.ts` and
   `tests/board-keys.test.ts` are new; the wheel, the area the chat leaves clear, the
   keyboard menu's point, culling and name room joined the camera and scene tests.
6. **A named mirror** (S). Role and name on each tile, `aria-activedescendant` on the board,
   a click from assistive tech selects. *Proves it:* a spec that finds a frame with
   `getByRole` and reads the board's active descendant after Tab. **Done**, as described
   under Accessibility and tests. The active descendant is the frame last selected (`activeFrame`
   in `scene.ts`), and its tile stays mounted wherever it is, so the reference always
   resolves; while a section is picked by its name there is none, and the live region says
   which section (sections aren't options: making them groups of options would need
   `aria-owns`, as their frames aren't inside them in the DOM). A click with no pointer behind
   it (`detail` 0, as a screen reader's is) selects the frame it lands on. The spec is the last
   in `canvas.spec.ts`, so it runs both ways; it also reads Chromium's own accessibility tree,
   where the focused board's active descendant is the frame's option, named and selected.
   Still not listened to with VoiceOver.
7. **Switch and delete** (M, mostly deletions). WebGL is the board. The DOM painting
   (`Thumbnail`, the tile, section, selection and marquee styles, the CSS grid), the switch
   and `GUI_BOARD_WEBGL` go; `docs/architecture.md`'s Canvases entry is rewritten. One board,
   no setting. *Proves it:* the canvas specs with no switch; the audit's `board-60` and `held`
   probes and the prototype's, against the numbers above. **Done**: the tiles' `<img>`
   thumbnails, the section, selection, handle and marquee elements, the CSS dot grid, the
   switch (`src/main/dev-flags.ts`, `WindowState.devBoardWebgl`, the board's `gl` prop) are
   gone; the tiles and the handle's grip stay, transparent. Without WebGL2 the board says it
   can't be shown. The window's chunk went from 164.5 kB to 162.6 kB (57.8 → 57.2 kB gzipped), its CSS from 57.1
   to 56.7 kB. The specs pass; the probes were not run again (the audit's and the
   prototype's live on other branches), so the numbers above are still the switch's.

Stages 3 and 5 do not depend on each other. Raising `MAX_FRAMES` is not a stage of this move.

## Risks, and what would stop this

- **The canvas has a fixed cost, and at 60 frames it is the whole story.** Chromium keeps
  several buffers behind a WebGL canvas, each its size in device pixels (20 MB at 1440 × 870
  on a Retina display). With the board fitted, the GPU process holds 94 MB of `IOSurface`
  with the canvas against 28–33 MB without, and 90 MB more in all. It is
  paid whenever the board is open, grows with the window (a full-screen board on a 5K display
  has about three times the pixels), and no context setting changed it
  (`preserveDrawingBuffer`, `alpha`, `desynchronized` were each tried). Resizing the canvas
  by a row and back once it has been still for 1.5 s gives one buffer back (19 MB; in some
  runs a second), and the prototype does that. **Stop and reconsider** if, in a visible window on the owner's display,
  the GPU process at fit is more than about 100 MB over the DOM board's: at 60 frames the
  move then costs more at rest than it saves zoomed in.
- **No second way to draw.** Since stage 7 a machine where WebGL2 cannot start (a blocked
  driver, some remote desktops and virtual machines) shows a message, not a board. Stop if
  crash reports or users show that happening.
- **Sharpness arrives 120 ms after a zoom rests**, where the DOM board swaps copies about
  100 ms into the gesture. Zooming in, thumbnails are soft until then. A matter of feel, to be
  judged by hand; the delay is one constant.
- **Names are DOM, frames are canvas.** They are written in the same frame by construction,
  and line up in every screenshot at rest; whether they ever part by a frame while moving
  cannot be seen in a hidden window. Stop if they do and it cannot be fixed by drawing in the
  same task: that is the case for text in WebGL.
- **The selection outline is now under the names** it used to be over, by its 2px.
- **The thumbnail protocol answers CORS requests.** Only Gui's own pages are in the session
  that has the protocol, and the previewed page's session does not; a person should confirm
  that before stage 1 lands.
- **The buffer trim leans on how Chromium recycles buffers.** If an Electron upgrade changes
  that it stops helping and does no harm; the prototype's probe would show it.
- **Colour.** The canvas and the thumbnails are both sRGB and match the DOM board in
  screenshots. On a P3 display that was not checked by eye.

## What was not measured

- **Feel.** Every run was hidden. Hidden windows here drew at 60 frames a second in both
  boards, so frame gaps and long tasks are real, but nobody has pinched it. 120 Hz was not
  measured at all.
- **Memory in a visible window, and at other window sizes.** Every figure is one 1440 × 920
  window at 2× in a see-through window. The canvas's buffers are the number most likely to
  differ on screen.
- **PixiJS's speed.** Its size was measured; no renderer was built on it.
- **Thousands of frames in view at once.** With desktop-sized frames the 5% zoom floor shows
  at most 360. A board of 120-pixel frames could show about 12,000, one draw call each; the
  prototype would need batching for that, and it was not tried.
- **A screen reader.** The mirror's structure is described, not listened to.
- **Other GPUs.** One machine, Apple M5 Max.
- **Energy.**
