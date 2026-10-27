# Gui

A browser-first Mac app for designing real interfaces with your own AI agents. Gui runs your project's dev server, shows your app in Chromium, and lets you point at elements (or drag out an area) and ask for a change in a floating chat. The agent edits your actual code; hot reload updates the preview.

## Requirements

- macOS (Apple Silicon tested)
- [Bun](https://bun.sh) 1.4+
- At least one coding agent. **Claude Code** and **Codex** need nothing set up beforehand: Gui uses your installed CLI and its login when the version matches, and otherwise the start screen installs the exact version it needs and runs its sign-in in the browser. Gui also bundles the ACP adapter for **Pi** (the community [`pi-acp`](https://github.com/svkozak/pi-acp) adapter, which drives your installed `pi` 0.81+). It runs these CLIs from your PATH when they're installed, reusing their logins:

  | Agent | Runs | Sign in |
  | --- | --- | --- |
  | Grok Build | `grok agent stdio` | `grok login` |
  | Kiro | `kiro-cli acp` | `kiro-cli login` |
  | OpenCode | `opencode acp` | `opencode auth login` |
  | Pi | `pi --mode rpc` (via `pi-acp`) | `pi`, then `/login` |
  | Muse Code | `muse` (via `@bex-co/muse-code-acp`) | `muse login` |
  | Amp | `amp` (via the bundled community [`amp-acp`](https://github.com/tao12345666333/amp-acp) adapter) | `amp login` |
  | Devin | `devin acp` | `devin auth login` |
  | Cursor | `cursor-agent acp` | `cursor-agent login` |

  The start screen and **Settings → Agents** show your agent's state with one next step: **Install** downloads Claude Code or Codex (other agents: opens their install page), and **Sign in** runs its login in Terminal (Claude Code and Codex sign in from Gui directly); Gui re-checks when you come back. Every installed agent is on by default; switch off the ones you don't use in **Settings → Agents** (⌘,). Any other [ACP](https://agentclientprotocol.com) agent can be added there too. Custom agents live in `agents.json` in Gui's app data folder, in the shape of Zed's `agent_servers` (a pasted `{ "agent_servers": { … } }` block works too); `command` is a name on your PATH or an absolute or `~/` path:

  ```json
  { "Amp": { "command": "amp-acp", "args": [], "env": {} } }
  ```
- git (Xcode Command Line Tools) — used for per-turn checkpoints
- Xcode 26+ to package the app (its `actool` compiles the light and dark app icon, `build/icon.icon`). `install-app` uses `/Applications/Xcode.app` automatically if Command Line Tools are selected; set `DEVELOPER_DIR` for a custom Xcode location.

## Run

```bash
bun install
bun run dev
```

Open a project folder (⌘O). Gui detects the package manager and `dev` script, asks before running it the first time (showing the script), starts it, and loads the URL it prints. A fresh clone just works: Gui installs missing dependencies (in the same confirmation), asks which app to preview in a monorepo, and offers to create `.env.local` from `.env.example`. Opening an app's folder inside a monorepo (say `shape/website`) opens the monorepo with that app chosen. Each project opens in a tab of the window (⌘T for a new one; ⌘N still opens a new window), with its own preview, chat, dev server and agent; tabs in the background keep running, and the tab strip shows when one's agent is working, waiting for your answer, or has failed. Opening a project that's already open shows its tab. To open a project on launch: `GUI_OPEN=/path/to/project bun run dev`.

From a terminal, `gui` opens the current folder in the installed Gui and starts its dev server (`gui path/to/app` opens another folder). A folder that's already open shows its tab. `bun run install-app` installs the command at `/usr/local/bin/gui`, or choose **Gui → Install 'gui' Command…** when that folder needs an administrator password.

Picking (⌘D) outlines whatever is under the pointer, with its component and size. Click an element to pick it, or drag out an area to pick a screenshot of it; hold ⇧ to pick several (⇧-click a picked one to drop it), and Esc when you're done. The wheel scrolls the page while you pick. Everything picked goes to the agent with your next message, in order, each with its screenshot; an area also names the element around it and its source. In the composer, point at a pick to see it in the page, or remove it with its **×**. In the chat, the agent's name in the header switches agents (or starts a new chat). Each turn folds the agent's steps into one line ("6 steps · 12s") and, when it changed files, ends with the result: the picked element before and after, the files changed, and **Undo**. Paste or drop reference images ("make it look like this"); the agent sees them. Messages sent while the agent works wait in a queue above the composer and run in order (Stop pauses it; you can remove one or send the next now). The model button opens a searchable list of the agent's models, with its effort levels when it has them. **Auto** (on by default, per project) answers the agent's permission requests for you; switch a project to **Ask** with the chip or ⇧⌘A. A permission card waiting for you is answered with ⌘↩ (Allow) or ⌘⌫ (Don't allow), never with an "always". Desktop fills the canvas; Laptop (1440 × 900), Tablet (820 × 1180) and Mobile (390 × 844) show your app in a device frame at exactly that size, so you see what fits above the fold on each. On a smaller window the frame is drawn smaller (the label above it says how much) while the page still lays out at the device's size; the agent is told which viewport you're looking at. ⌘+ and ⌘− zoom: a device frame between 25% and the largest that fits (⌘0 fits it again), Desktop like a browser's page zoom (⌘0 is 100%, and the address bar shows the level otherwise); the page keeps its CSS size, and picking and the agent's screenshots work at any zoom. Focus mode (⌘\) hides everything but the preview until ⌘\ or Esc brings it all back. The camera button in the toolbar copies or saves a full-resolution screenshot of the preview (the visible area or the full page), or attaches it to the chat. The Record button beside it records only the preview, without audio, at up to 30 fps for up to 60 seconds. Stop attaches a playable clip to your next message. The agent receives timestamped overview frames and, when it supports Gui’s tools, can inspect exact captured frames or short animation ranges; agents without image support cannot see the clip. Recordings stay locally with chat history. The dot at the start of the address bar is the dev server's status: click it to restart or stop the server, show its logs, or open the app in your browser. If the server crashes, a bar under the preview offers its logs and a restart. The logs live in the drawer under the preview (⌘J), next to terminals: your own login shell at the project root, as in Terminal. The first ⌘J opens a terminal; after that ⌘J shows whichever tab you left the drawer on. **+** adds another terminal, its **×** (or Delete on its tab) ends it and everything it started, and `exit` ends the shell but keeps the terminal, with **Restart** for a new one. ⌘K clears a terminal and ⌘⌫ deletes the line you're typing; copy, paste and the app's shortcuts (⌘D, ⌘↩ for a waiting card) work as usual while one has the keyboard (⌘W still closes the project's tab). Each project's terminals are its own: they keep running in a tab in the background and come back with their output when you switch to it. Drag the floating chat by its header and let go: it settles into the nearest corner of the canvas, or flick it toward another corner and it lands there. Drag any edge or corner of the chat panel to resize it (docked: its left edge); Gui remembers the size. Opened on main, a project stays as it is there: your first message starts a new branch named after it, unless you choose **Stay on main** in the bar over the chat. Once the agent has changed files, that bar's one button takes the work forward: **Create pull request** commits every change, pushes it, and opens the pull request (with `gh` when it's signed in, otherwise GitHub's or GitLab's new-PR page); after that it reads **Update pull request**, or **Commit** for a project that isn't online. Env files and keys are never committed. To choose files or write your own commit message, open **Source Control** from the toolbar's branch button. Selected files include their current contents, including unstaged edits; excluded files keep their existing staged state. Git hooks and commit signing use the project's own settings.

**New canvas** on the start screen (⌥⌘N) opens a freeform board at once, with no folder, install or dev server: ask the agent for a page, or a few versions of one, and each lands as a frame you can move, resize, compare and name, like artboards in Figma. Each frame is a single-file HTML page. Scroll pans, ⌘-scroll or a pinch zooms, and dragging pans with the Hand tool (H, or hold Space; V goes back to Move), and the board's corner handle resizes a frame; drag across empty board (or ⇧-click) to select several, which the agent's next message is about. ⌥⌘D duplicates the selection, ⇧⌘E (or the toolbar's share button) exports it as PNGs at 2×, Delete deletes it, arrow keys nudge it, ⌘0 fits the board, and ⌘Z takes back your own board changes before the agent's turns. **+ Frame** adds a Desktop, Tablet or Mobile frame. **Sections** group frames under a name (⌥⌘G or right-click → Add Section, around what's selected): a section sizes itself to its frames, dragging its name moves them all, a frame dropped on it joins it and one dragged out leaves it, and Delete with the section picked removes only the section. The agent groups related frames into sections too. **Export** saves PNGs at 2×: a frame, the selection (⇧⌘E), a section, or the whole canvas (the canvas menu's Export All Frames…), with a folder per section when the frames span several. Double-click a frame (or press Return) to open it live in the preview; ⌘D opens the selected frame and starts picking in it. Live, picking (⌘D), viewports, screenshots and the agent's preview tools work as in a project; **Canvas** or Esc goes back. The agent can also screenshot any website ("make it feel like linear.app") to use as a reference, at a desktop or mobile width or as the whole page, and save it to the canvas's `assets/` to put it in a frame; it loads the site in a hidden window with its own cookies, apart from your previews, so it isn't signed in anywhere. Right-click a frame to rename, duplicate, delete, copy it as a PNG, export it as a PNG, copy or save its HTML, or **Turn into Project…**, which makes a Vite project of it where you choose and opens it in a new tab. Canvases are listed on the start screen and kept in Gui's data folder, with their chats, Undo, and the board's layout, across restarts.

Every shortcut is in the app's menus, and **Help → Keyboard Shortcuts** (⌘/) lists them all; toolbar and chat buttons name theirs in their tooltips. They're defined once, in `src/shared/shortcuts.ts`.

| Action | Shortcut |
| --- | --- |
| **App** | |
| Open Settings | ⌘, |
| Open a new window | ⌘N |
| Open a project folder | ⌘O |
| Open a new canvas to design on freely | ⌥⌘N |
| Close the window and its tabs | ⇧⌘W |
| Undo typing, or outside a text field the agent's last change | ⌘Z |
| Redo typing, or the agent's change you undid | ⇧⌘Z |
| Show the keyboard shortcuts | ⌘/ |
| Inspect Gui's own window | ⌥⌘J |
| **Preview** | |
| Edit the preview's address | ⇧⌘L |
| Reload the preview | ⌘R |
| Reload the preview, ignoring the cache | ⇧⌘R |
| Go back | ⌘[ |
| Go forward | ⌘] |
| Desktop: fill the window | ⌘1 |
| Laptop: 1440 × 900 | ⌘2 |
| Tablet: 820 × 1180 | ⌘3 |
| Mobile: 390 × 844 | ⌘4 |
| Zoom in: the page, or a device frame up to the size that fits | ⌘+ or ⌘= |
| Zoom out | ⌘− |
| Page at 100%, or a device frame back to fit | ⌘0 |
| Pick an element or area to change (⇧ for several, Esc when done) | ⌘D or ⇧⌘C |
| Copy, save or attach a screenshot | ⇧⌘S |
| Show only the preview (Esc exits) | ⌘\ |
| Inspect your app's page | ⌥⌘I |
| **Chat & agent** | |
| Show the chat and its message box; from there, hide it | ⌘L |
| Dock the chat beside the preview, or float it | ⇧⌘D |
| Choose the agent's model and effort | ⇧⌘M |
| Start a new chat | ⇧⌘K |
| Stop the agent | ⌘. |
| Auto or Ask for the agent's permission requests | ⇧⌘A |
| Allow what the agent's waiting to do | ⌘↩ |
| Don't allow what the agent's waiting to do | ⌘⌫ |
| **Terminal** | |
| Show or hide the terminal and the dev server's logs | ⌘J |
| Clear the terminal (in a terminal) | ⌘K |
| Delete the line you're typing (in a terminal) | ⌘⌫ |
| **Tabs** | |
| Open a new tab | ⌘T |
| Close the tab, stopping its agent and app | ⌘W |
| Show the previous tab | ⌃⇧⇥ or ⇧⌘[ |
| Show the next tab | ⌃⇥ or ⇧⌘] |

## GitHub project connections

**Connect GitHub projects** on the start screen, or **Settings → Projects**, lets users authorize GitHub, choose repositories for the Gui GitHub App, create private projects, and clone a connected repository. The shipping sheet uses the connection to push and open pull requests. Local projects and cloning by URL remain available without a Gui account. The account service stores the GitHub profile and verified primary email, with an optional product-update preference.

This requires configuring and deploying the separate account service, registering a GitHub App, and building Gui with its service URL. See [account service setup](accounts/README.md). Builds without a configured service retain local project access and explain that GitHub connections are unavailable.

## How it works

```
BrowserWindow (window.ts)
├─ app chrome (React)         tab strip, toolbar, canvas states, drawer (logs, terminals)
└─ active tab (tab.ts)        one project; other tabs' views are out of the window, still running
   ├─ WebContentsView: preview   your app at localhost, sandboxed, no preload
   └─ WebContentsView: chat      floating, transparent, draggable panel (React)
```

The preview is a native view, so HTML can't overlay it — the chat panel is its own transparent view stacked on top, moved by the main process as you drag it. Each tab owns its views, dev server, agent and preview tools; switching tabs swaps which tab's views are in the window and whose state the chrome shows.

- **Dev server** (`src/main/dev-server.ts`) — runs the dev script in a PTY through your login shell, detects the printed URL, and only marks it ready once a listener in *its own process group* owns the port. If another project's server shadows `localhost` on the other address family, the preview pins to `127.0.0.1` or `[::1]`.
- **Terminals** (`src/main/terminals.ts`, `src/renderer/src/app/drawer.tsx`) — each is your login shell (`$SHELL -l`) in a PTY at the project root, with your login-shell environment, started when you open it. Keystrokes come only from the window's own chrome (never the chat panel, which renders what agents write) and only for the shown project's terminals; main keeps the last 512 KB of each one's output so the drawer can draw it again after you switch tabs. Output (the dev server's too) streams only to the drawer tab on screen, one message per frame or per 256 KB (`src/main/output.ts`): the drawer acknowledges what it has drawn, and a shell printing faster than that waits for it (node-pty stops reading; typing, ⌃C among it, still gets through), like any terminal that can't keep up, though never for long on a drawer that isn't drawing. Out of sight, shells and the dev server go on unheld, and the drawer catches up from what main kept when it shows them. Closing a terminal, its tab or window, or quitting hangs up on the shell and every process group on its terminal or started from it (job control gives each job its own), then kills whatever is left after half a second. Agents don't see terminal output.
- **Device frames** (`src/main/viewport.ts`) — Chromium's device emulation (`Emulation.setDeviceMetricsOverride` over the inspector's debugger session) lays the page out at the frame's CSS size and draws it scaled into a view that size times the scale, the way DevTools' device mode fits a device to its window. Tablet and Mobile are emulated as mobile devices (`<meta name=viewport>` applies, scrollbars overlay, touch media queries match) while the mouse stays a mouse, so picking and hover work as usual. Picking, the floating chat, crops and screenshots map page coordinates through the scale; screenshots are the page at its CSS size, in the display's pixels.
- **Motion** (`src/shared/motion.ts`) — anything you drag or throw moves on springs (Apple's damping-ratio and response parametrisation, solved exactly so any frame rate works), started from where it is and as fast as it's going, so every animation can be caught or redirected. Critically damped by default; a throw's spring overshoots a little, and the landing spot is projected from the release velocity the way a scroll view decelerates. The floating chat is a native view, so main steps its springs at the display's refresh rate (`src/main/panel-flight.ts`); its panel, pill and bubble morph into one another in the chat view, which tells main when to shrink the view. Chat state changes (a message sent or starting from the queue, a permission answered) are view transitions. The preview's own layout changes (another viewport, a zoom step, the drawer, docking the chat, focus mode) resize the live page rather than jump (`src/main/preview-morph.ts`, `src/renderer/src/app/layout-morph.ts`), the way dragging a window's edge would: main springs the view's bounds and its emulated viewport together on the display's frames, so your app lays itself out again at every size on the way, and the chrome draws the device frame and its label around it. A change mid-motion carries on from wherever it is, keeping its speed. The drawer and the toolbar slide on the same spring, and the docked chat slides in over the page. With Reduce motion on, nothing moves or scales: things jump into place, and short cross-fades stand in where something appears or goes.
- **Selection** (`src/main/picker.ts`, `inspector.ts`, `src/renderer/src/pick`) — while you pick, a transparent view of Gui's own lies over the preview and draws the outlines, labels and the area you drag, so nothing is injected into your DOM. Its pointer goes to main, which finds the element there with the Chrome DevTools Protocol (`DOM.getNodeForLocation`) and measures it (`DOM.getBoxModel`); the wheel is passed on to the page as precise scroll deltas, so it scrolls as smoothly as it would directly. HTML, attributes, computed styles, and the box come from protocol commands that page scripts can't spoof; only the React owner chain (and the component name on the hover label) is read from the page, and it's validated. An area is captured from the page and described by the smallest element around it. Everything picked is sent to the agent marked as untrusted.
- **Source mapping** (`src/main/source-resolver.ts`) — React 19 records where each JSX element was created (`_debugStack`); Gui resolves that frame through the dev server's source maps to `file:line`. Exact for Vite and Next.js (Turbopack); approximate for Next.js (webpack). Astro pages map through the `data-astro-source-file`/`-loc` attributes its dev server adds. Server-rendered pages wait for hydration before reading fibers.
- **Agents** (`src/main/agents.ts`, `agent.ts`, `agent-status.ts`, `chat.ts`) — spoken to over the [Agent Client Protocol](https://agentclientprotocol.com). Claude Code, Codex, Pi, Muse Code, and Amp run through bundled adapters (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`, `pi-acp`, `@bex-co/muse-code-acp`, `amp-acp`) on Electron's Node. Gui doesn't ship the Claude Code and Codex CLIs those adapters drive (`src/main/agent-binaries.ts`): it uses your own install when its version matches what the adapter was built for, and otherwise **Install** downloads that exact version from npm, checks it against the hash pinned in `bun.lock`, and keeps it in Gui's data folder (your own install is left alone); Grok Build, Kiro, OpenCode, Devin, and Cursor speak ACP themselves and are found on your login-shell PATH, as are the `pi`, `muse`, and `amp` CLIs their adapters drive. Pi doesn't get Gui's preview tools: its adapter doesn't pass MCP servers through. On launch Gui checks the bundled agents and the one you picked by starting (but not prompting) a session; **Check again** on the start screen checks every installed agent. The project's **Ask** or **Auto** also sets the agent's own permission mode (declared per agent in `agents.ts`), when a session starts or resumes and when you switch: Claude Code gets Manual or Auto (Accept edits when its model has no Auto), Codex Read-only or Auto review, and Muse Code On request (with Muse 1.2.1+'s `promptUnmatched` approval policy) or Auto-approve. Grok Build has no ACP modes and takes it as session `_meta` (Ask: `yoloMode` and `autoMode` off; Auto: `autoMode`), so switching resumes its session before the next message. Gui only sets modes the session offers, and leaves the mode alone in between, so a mode you or the agent pick another way stays until the next switch; the chat header shows the current one. Kiro, OpenCode, Pi, Amp, Devin, Cursor and custom agents keep the permission mode your own agent config picks. Amp's adapter keeps its configured permissions in both Ask and Auto; Amp runs tools without prompts by default unless its permissions are configured. The adapter doesn't support resuming after an app restart. Cursor runs through its `cursor-agent` alias so it can't collide with another CLI named `agent`. Cursor plan approvals appear in chat; its custom question forms are skipped with a request to ask in normal chat instead. Each agent's own config (CLAUDE.md, hooks, Codex/OpenCode/Pi settings, …) applies as usual. When the agent asks, Gui approves edits to ordinary source files in the project and, in **Ask** mode, asks you in the chat about everything else. In **Auto** mode (`src/main/auto-approve.ts`) it also approves commands, fetches, and reads, picking only one-time approvals; it still asks when a request names a file outside the project, edits a sensitive file (config, dotfiles, lockfiles, scripts, `package.json`, git hooks), changes the agent's mode or plan, or the agent itself flags it (Claude's own ask rules and safety checks). Commands aren't sandboxed: Auto trusts the agent's commands the way its own auto modes do.
- **Preview tools for the agent** (`src/main/mcp-server.ts`, `preview-tools.ts`, `preview-interactions.ts`) — each tab serves an MCP server on loopback (random port, bearer token) that Gui passes to every agent session that accepts HTTP MCP servers. Agents can `preview_screenshot` (an element, the full page, or at a viewport width like 390), `preview_inspect` (computed styles, box, and source file for a selector), `preview_snapshot` (page text and controls with unique CSS selectors), `preview_console`, `preview_navigate`, `preview_reload`, and `dev_server_logs`. `preview_click`, `preview_hover`, `preview_type`, `preview_press`, and `preview_scroll` send real Chromium input, including React input handlers and nested scrolling, in the same preview the user sees. They reject ambiguous, hidden, or covered targets; clicking and typing also reject disabled targets. Snapshots list the main document, without iframe or shadow-root contents. Agents are instructed to edit, view and exercise the result, then revise and recheck within the same turn before replying. Resumed sessions receive updated instructions once when the guidance changes.
- **Canvases** (`src/main/board.ts`, `board-session.ts`, `mcp-board-tools.ts`, `src/renderer/src/app/board.tsx`) — a canvas is a folder in Gui's data (`canvases/<id>/`): `canvas.json` (each frame's name, place and size, and where the board was looking), `frames/<id>.html`, and `assets/` for shared images. Being a real folder, its chat history, checkpoints and Ask/Auto work as a project's do; nothing runs but the agent. The tab keeps the manifest in step with the files whoever writes them: a page the agent writes directly joins the board, one deleted leaves it, and an undone turn puts both back. Frames are served to the preview from a per-canvas loopback server (random port, token path, confined to the canvas folder, never the manifest) and captured offscreen as thumbnails whenever their page changes; the board loads those through Gui's own `gui-thumb:` protocol, which previewed pages can't reach. In a canvas the agent gets a canvas preamble instead of the dev-server rules, a block each turn listing the frames with what's selected and open, and canvas tools: `canvas_list_frames`, `canvas_create_frame` (placed beside what it varies, never overlapping), `canvas_duplicate_frames`, `canvas_arrange_frames`, `canvas_rename_frame`, `canvas_delete_frames`, `canvas_screenshot`, and `canvas_open_frame`, which shows a frame live so the preview tools work on it.
- **Errors** (`src/main/problems.ts`) — console errors since the last navigation and dev-server build errors since the last successful rebuild show above the composer with a **Fix** button, and ride along with every prompt as untrusted context.
- **Recordings** (`src/main/recordings.ts`, `src/renderer/src/app/record-button.tsx`) — the toolbar starts a display-media stream of the preview’s own frame, never a screen or window. MediaRecorder saves WebM video; decoded frames are sampled at up to 30 fps as JPEGs with actual media timestamps. Encoding or disk backpressure may leave gaps, which the frame timing reports. Clips and frames live under the project’s recording directory in Gui’s app data. `recording_info` returns timing, `recording_frame` retrieves a zero-based captured frame, and `recording_frames` samples a time range (at most 12 images per response). Unsent clips are deleted when removed or the project closes; sent clips survive restarts, and Clear chat history also clears recordings for closed projects.
- **History** (`src/main/history.ts`) — each project's transcript, checkpoints, and agent session are saved, so after a restart the chat is still there, old turns can still be undone, and the agent resumes its session (ACP `session/load`) with its memory.
- **Settings** (`src/main/settings.ts`, `src/renderer/src/settings/`) — a separate window (⌘,) for switching agents on and off, signing in, adding custom agents, the default agent and chat docking, revoking trusted projects, clearing recent projects, and clearing chat history, checkpoints, and preview site data. Projects open in a tab keep their chat history and checkpoints when those are cleared.
- **Checkpoints** (`src/main/checkpoints.ts`) — before and after every turn the working tree is snapshotted into a shadow git repo under the app's data folder (your `.git` is never touched). **Undo** restores the files that turn (and any later ones) changed to how they were before it; files you edited yourself are left alone. **Redo** reverses the undo.

## Scripts

- `bun run dev` — app with hot reload
- `bun run build` — production bundle in `out/`
- `bun run dist` — packaged macOS app in `release/` (see below)
- `bun run install-app` — builds Gui and installs it as `/Applications/Gui.app` (quits and reopens a running Gui) and the `gui` terminal command. To update, `git pull && bun run install-app`
- `bun run release` — builds, signs, notarizes and publishes the version in `package.json` (see Packaging)
- `bun run test:e2e` — end-to-end tests against real dev servers (agent turns run only with `GUI_E2E_AGENT=<agent id>`, e.g. `claude`, `codex`, `grok`, `kiro`, `opencode`, `pi`, `muse`, `amp`, `devin`, or `cursor`, since they use real usage)
- `bun run typecheck` / `bun run lint` / `bun run format`
- `bun run check` — type checks, lint, architecture boundaries/cycles, fast desktop checks, and account-service tests
- `bun run test:fast` — lifecycle, IPC, worker/persistence, and chat transport/recovery checks without launching Electron or using paid agents

## Packaging

`CSC_IDENTITY_AUTO_DISCOVERY=false bun run dist` builds an unsigned arm64 `.app`, `.dmg`, and `.zip` (the agent CLIs aren't included; see Agents above). For a signed, notarized build, put a Developer ID Application certificate in your keychain (or set `CSC_LINK` + `CSC_KEY_PASSWORD`) and one set of notarization credentials (`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or an App Store Connect API key) before `bun run dist`. `electron-builder.yml` explains each fuse and entitlement. Unsigned builds get a new ad-hoc signature each time, so macOS asks for keychain access on first launch.

`bun run release` publishes a version: bump `version` in `package.json` (`0.1.0-alpha.2`, …), commit on main, and run it. It runs `bun run check`, builds, verifies the signature, notarization and Gatekeeper, notarizes the DMG, uploads the build to the `gui-releases` R2 bucket, and tags `v<version>`. The setup it needs is at the top of `scripts/release.sh`. Installed copies check `usegui.com/releases` at launch and every 4 hours, download a new version in the background, and offer to restart into it (**Gui → Check for Updates…** checks now). A prerelease version publishes to its own channel (`alpha-mac.yml`), and `usegui.com/download` serves the newest alpha DMG.

Installed copies also send crash reports (`src/main/crash-reports.ts`): uncaught errors in main, errors that stop one of Gui's windows drawing, and crashed renderer and helper processes, with home folders removed from paths. They go to `usegui.com/crash`, which keeps them in the `gui-www` D1 database; `bun run --cwd www crashes` lists the last 7 days. **Settings → Account → Send crash reports** turns them off, and development builds never send them.

## Security model

The preview runs your app plus whatever third-party scripts it loads, so it is treated as semi-trusted: it has no preload or IPC access, its session denies permission requests (camera, clipboard reads, devices, external protocols) by default, and element picking only works on local origins.

The terminals are your own shell, started only when you open one, at the project root; nothing the project defines runs in them on its own (your shell's startup files run as they do in Terminal, so tools hooked into them, like direnv, react to the folder as usual). Only the window's own UI can type into them.

Agents get Gui's preview tools over a loopback MCP server that needs a per-tab token and rejects other `Host` headers. The tools only act on the local dev server. Everything they return from the page or dev server (element data, console, logs) is fenced and marked as untrusted, the same as selected-element context. Claude's preview tools are pre-allowed by exact name; nothing is auto-approved by matching a tool's title. Chat history is stored owner-only (`0600`), without URL query strings.

Before shipping a signed build, note that the `runAsNode` fuse is on because the agent adapters run on Electron's bundled Node. Any process that can launch the signed app binary with `ELECTRON_RUN_AS_NODE=1` inherits the app's TCC grants. Running the adapters on a separately signed Node binary would allow the fuse to be turned off.

## Not yet

Drawing on a picked area, quick direct-manipulation tweaks, Vue/Svelte source mapping, exact Next.js webpack mapping, and parallel variations. Source-map fetching, parsing, and lookup run in a bounded background worker, so large maps do not block the main process while picking.
