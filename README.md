# Gui

A browser-first Mac app for designing real interfaces with your own AI agents. Gui runs your project's dev server, shows your app in Chromium, and lets you point at an element and ask for a change in a floating chat. The agent edits your actual code; hot reload updates the preview.

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

  The start screen and **Settings → Agents** show your agent's state with one next step: **Install** downloads Claude Code or Codex (other agents: opens their install page), and **Sign in** runs its login in Terminal (Claude Code and Codex sign in from Gui directly); Gui re-checks when you come back. Every installed agent is on by default; switch off the ones you don't use in **Settings → Agents** (⌘,). Any other [ACP](https://agentclientprotocol.com) agent can be added there too. Custom agents live in `agents.json` in Gui's app data folder, in the shape of Zed's `agent_servers` (a pasted `{ "agent_servers": { … } }` block works too); `command` is a name on your PATH or an absolute or `~/` path:

  ```json
  { "Amp": { "command": "amp-acp", "args": [], "env": {} } }
  ```
- git (Xcode Command Line Tools) — used for per-turn checkpoints
- Xcode 26+ to package the app (its `actool` compiles the light and dark app icon, `build/icon.icon`)

## Run

```bash
bun install
bun run dev
```

Open a project folder (⌘O). Gui detects the package manager and `dev` script, asks before running it the first time (showing the script), starts it, and loads the URL it prints. A fresh clone just works: Gui installs missing dependencies (in the same confirmation), asks which app to preview in a monorepo, and offers to create `.env.local` from `.env.example`. Opening an app's folder inside a monorepo (say `shape/website`) opens the monorepo with that app chosen. Each project opens in a tab of the window (⌘T for a new one; ⌘N still opens a new window), with its own preview, chat, dev server and agent; tabs in the background keep running, and the tab strip shows when one's agent is working, waiting for your answer, or has failed. Opening a project that's already open shows its tab. To open a project on launch: `GUI_OPEN=/path/to/project bun run dev`.

In the chat, the agent's name in the header switches agents (or starts a new chat). Each turn folds the agent's steps into one line ("6 steps · 12s") and, when it changed files, ends with the result: the picked element before and after, the files changed, and **Undo**. Paste or drop reference images ("make it look like this"); the agent sees them. Messages sent while the agent works wait in a queue above the composer and run in order (Stop pauses it; you can remove one or send the next now). The model button opens a searchable list of the agent's models, with its effort levels when it has them. **Auto** (on by default, per project) answers the agent's permission requests for you; switch a project to **Ask** with the chip or ⇧⌘A. Desktop fills the canvas; Laptop (1440 × 900), Tablet (820 × 1180) and Mobile (390 × 844) show your app in a device frame at exactly that size, so you see what fits above the fold on each. On a smaller window the frame is drawn smaller (the label above it says how much) while the page still lays out at the device's size; the agent is told which viewport you're looking at. The camera button in the toolbar copies or saves a full-resolution screenshot of the preview (the visible area or the full page), or attaches it to the chat. The dot at the start of the address bar is the dev server's status: click it to restart or stop the server, show its logs (⇧⌘L), or open the app in your browser. If the server crashes, a bar under the preview offers its logs and a restart. Drag any edge or corner of the chat panel to resize it (docked: its left edge); Gui remembers the size. When you're happy, the pull-request button in the chat header commits the changes to a new branch, pushes it, and opens the pull request (with `gh` when it's signed in, otherwise GitHub's or GitLab's new-PR page). Env files and keys are never committed.

| Action | Shortcut |
| --- | --- |
| New tab / close tab | ⌘T / ⌘W |
| Next / previous tab | ⌃⇥ / ⌃⇧⇥ (or ⇧⌘] / ⇧⌘[) |
| Select element | ⇧⌘C (Esc cancels) |
| Toggle chat | ⌘J |
| Dock chat beside the preview | ⇧⌘D |
| Toggle dev server logs | ⇧⌘L |
| Desktop / laptop / tablet / mobile viewport | ⌘1 / ⌘2 / ⌘3 / ⌘4 |
| Reload preview | ⌘R |
| New chat | ⇧⌘K |
| Stop agent | ⌘. |
| Auto / Ask for the agent's permission requests | ⇧⌘A |
| Undo / redo the agent's last change (outside a text field) | ⌘Z / ⇧⌘Z |
| Settings | ⌘, |
| Preview DevTools | ⌥⌘I |

## How it works

```
BrowserWindow (window.ts)
├─ app chrome (React)         tab strip, toolbar, canvas states, logs drawer
└─ active tab (tab.ts)        one project; other tabs' views are out of the window, still running
   ├─ WebContentsView: preview   your app at localhost, sandboxed, no preload
   └─ WebContentsView: chat      floating, transparent, draggable panel (React)
```

The preview is a native view, so HTML can't overlay it — the chat panel is its own transparent view stacked on top, moved by the main process as you drag it. Each tab owns its views, dev server, agent and preview tools; switching tabs swaps which tab's views are in the window and whose state the chrome shows.

- **Dev server** (`src/main/dev-server.ts`) — runs the dev script in a PTY through your login shell, detects the printed URL, and only marks it ready once a listener in *its own process group* owns the port. If another project's server shadows `localhost` on the other address family, the preview pins to `127.0.0.1` or `[::1]`.
- **Device frames** (`src/main/viewport.ts`) — Chromium's device emulation (`Emulation.setDeviceMetricsOverride` over the inspector's debugger session) lays the page out at the frame's CSS size and draws it scaled into a view that size times the scale, the way DevTools' device mode fits a device to its window. Tablet and Mobile are emulated as mobile devices (`<meta name=viewport>` applies, scrollbars overlay, touch media queries match) while the mouse stays a mouse, so picking and hover work as usual. Picking, the floating chat, crops and screenshots map page coordinates through the scale; screenshots are the page at its CSS size, in the display's pixels.
- **Selection** (`src/main/inspector.ts`) — Chrome DevTools Protocol `Overlay.setInspectMode`, the same picker DevTools uses, so nothing is injected into your DOM. HTML, attributes, computed styles, and the box come from protocol commands that page scripts can't spoof; only the React owner chain is read from the page, and it's validated. Element data is sent to the agent marked as untrusted.
- **Source mapping** (`src/main/source-resolver.ts`) — React 19 records where each JSX element was created (`_debugStack`); Gui resolves that frame through the dev server's source maps to `file:line`. Exact for Vite and Next.js (Turbopack); approximate for Next.js (webpack). Astro pages map through the `data-astro-source-file`/`-loc` attributes its dev server adds. Server-rendered pages wait for hydration before reading fibers.
- **Agents** (`src/main/agents.ts`, `agent.ts`, `agent-status.ts`, `chat.ts`) — spoken to over the [Agent Client Protocol](https://agentclientprotocol.com). Claude Code, Codex, Pi, and Muse Code run through bundled adapters (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`, `pi-acp`, `@bex-co/muse-code-acp`) on Electron's Node. Gui doesn't ship the Claude Code and Codex CLIs those adapters drive (`src/main/agent-binaries.ts`): it uses your own install when its version matches what the adapter was built for, and otherwise **Install** downloads that exact version from npm, checks it against the hash pinned in `bun.lock`, and keeps it in Gui's data folder (your own install is left alone); Grok Build, Kiro, and OpenCode speak ACP themselves and are found on your login-shell PATH, as is the `pi` CLI the Pi adapter drives. Pi doesn't get Gui's preview tools: its adapter doesn't pass MCP servers through. On launch Gui checks the bundled agents and the one you picked by starting (but not prompting) a session; **Check again** on the start screen checks every installed agent. The project's **Ask** or **Auto** also sets the agent's own permission mode (declared per agent in `agents.ts`), when a session starts or resumes and when you switch: Claude Code gets Manual or Auto (Accept edits when its model has no Auto), Codex Read-only or Auto review, and Muse Code On request (with Muse 1.2.1+'s `promptUnmatched` approval policy) or Auto-approve. Grok Build has no ACP modes and takes it as session `_meta` (Ask: `yoloMode` and `autoMode` off; Auto: `autoMode`), so switching resumes its session before the next message. Gui only sets modes the session offers, and leaves the mode alone in between, so a mode you or the agent pick another way stays until the next switch; the chat header shows the current one. Kiro, OpenCode, Pi and custom agents keep the permission mode your own agent config picks. Each agent's own config (CLAUDE.md, hooks, Codex/OpenCode/Pi settings, …) applies as usual. When the agent asks, Gui approves edits to ordinary source files in the project and, in **Ask** mode, asks you in the chat about everything else. In **Auto** mode (`src/main/auto-approve.ts`) it also approves commands, fetches, and reads, picking only one-time approvals; it still asks when a request names a file outside the project, edits a sensitive file (config, dotfiles, lockfiles, scripts, `package.json`, git hooks), changes the agent's mode or plan, or the agent itself flags it (Claude's own ask rules and safety checks). Commands aren't sandboxed: Auto trusts the agent's commands the way its own auto modes do.
- **Preview tools for the agent** (`src/main/mcp-server.ts`, `preview-tools.ts`) — each tab serves an MCP server on loopback (random port, bearer token) that Gui passes to every agent session that accepts HTTP MCP servers. Agents can `preview_screenshot` (an element, the full page, or at a viewport width like 390), `preview_inspect` (computed styles, box, and source file for a selector), `preview_console`, `preview_navigate`, `preview_reload`, and `dev_server_logs` — so they check their own visual changes instead of guessing.
- **Errors** (`src/main/problems.ts`) — console errors since the last navigation and dev-server build errors since the last successful rebuild show above the composer with a **Fix** button, and ride along with every prompt as untrusted context.
- **History** (`src/main/history.ts`) — each project's transcript, checkpoints, and agent session are saved, so after a restart the chat is still there, old turns can still be undone, and the agent resumes its session (ACP `session/load`) with its memory.
- **Settings** (`src/main/settings.ts`, `src/renderer/src/settings/`) — a separate window (⌘,) for switching agents on and off, signing in, adding custom agents, the default agent and chat docking, revoking trusted projects, clearing recent projects, and clearing chat history, checkpoints, and preview site data. Projects open in a tab keep their chat history and checkpoints when those are cleared.
- **Checkpoints** (`src/main/checkpoints.ts`) — before and after every turn the working tree is snapshotted into a shadow git repo under the app's data folder (your `.git` is never touched). **Undo** restores the files that turn (and any later ones) changed to how they were before it; files you edited yourself are left alone. **Redo** reverses the undo.

## Scripts

- `bun run dev` — app with hot reload
- `bun run build` — production bundle in `out/`
- `bun run dist` — packaged macOS app in `release/` (see below)
- `bun run install-app` — builds Gui and installs it as `/Applications/Gui.app` (quits and reopens a running Gui). To update, `git pull && bun run install-app`
- `bun run test:e2e` — end-to-end tests against real dev servers (agent turns run only with `GUI_E2E_AGENT=<agent id>`, e.g. `claude`, `codex`, `grok`, `kiro`, `opencode`, or `pi`, since they use real usage)
- `bun run typecheck` / `bun run lint` / `bun run format`

## Packaging

`CSC_IDENTITY_AUTO_DISCOVERY=false bun run dist` builds an unsigned arm64 `.app`, `.dmg`, and `.zip` (the agent CLIs aren't included; see Agents above). For a signed, notarized build, put a Developer ID Application certificate in your keychain (or set `CSC_LINK` + `CSC_KEY_PASSWORD`) and one set of notarization credentials (`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or an App Store Connect API key) before `bun run dist`. `electron-builder.yml` explains each fuse and entitlement. Unsigned builds get a new ad-hoc signature each time, so macOS asks for keychain access on first launch.

## Security model

The preview runs your app plus whatever third-party scripts it loads, so it is treated as semi-trusted: it has no preload or IPC access, its session denies permission requests (camera, clipboard reads, devices, external protocols) by default, and element picking only works on local origins.

Agents get Gui's preview tools over a loopback MCP server that needs a per-tab token and rejects other `Host` headers. The tools only act on the local dev server. Everything they return from the page or dev server (element data, console, logs) is fenced and marked as untrusted, the same as selected-element context. Claude's preview tools are pre-allowed by exact name; nothing is auto-approved by matching a tool's title. Chat history is stored owner-only (`0600`), without URL query strings.

Before shipping a signed build, note that the `runAsNode` fuse is on because the agent adapters run on Electron's bundled Node. Any process that can launch the signed app binary with `ELECTRON_RUN_AS_NODE=1` inherits the app's TCC grants. Running the adapters on a separately signed Node binary would allow the fuse to be turned off.

## Not yet

Multi-select and region annotation, quick direct-manipulation tweaks, Vue/Svelte source mapping, exact Next.js webpack mapping, auto-update, and parallel variations. Source-map resolution runs on the main thread; very large Next.js maps can briefly stall the UI on pick — moving it to a worker is planned.
