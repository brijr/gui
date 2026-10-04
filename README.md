# Grat

A browser-first Mac app for designing real interfaces with your own AI agents. Grat runs your project's dev server, shows your app in Chromium, and lets you point at an element and ask for a change in a floating chat. The agent edits your actual code; hot reload updates the preview.

## Requirements

- macOS (Apple Silicon tested)
- [Bun](https://bun.sh) 1.4+
- A signed-in agent CLI login: **Claude Code** (`claude`, then log in) and/or **Codex** (`codex login`). Grat bundles the ACP adapters for both and reuses your existing logins.
- git (Xcode Command Line Tools) — used for per-turn checkpoints

## Run

```bash
bun install
bun run dev
```

Open a project folder (⌘O). Grat detects the package manager and `dev` script, asks before running it the first time (showing the script), starts it, and loads the URL it prints. To open a project on launch: `GRAT_OPEN=/path/to/project bun run dev`.

| Action | Shortcut |
| --- | --- |
| Select element | ⇧⌘C (Esc cancels) |
| Toggle chat | ⌘J |
| Dock chat beside the preview | ⇧⌘D |
| Toggle dev server logs | ⇧⌘L |
| Desktop / tablet / mobile viewport | ⌘1 / ⌘2 / ⌘3 |
| Reload preview | ⌘R |
| New chat | ⇧⌘K |
| Stop agent | ⌘. |
| Preview DevTools | ⌥⌘I |

## How it works

```
BrowserWindow
├─ app chrome (React)         toolbar, canvas states, logs drawer
├─ WebContentsView: preview   your app at localhost, sandboxed, no preload
└─ WebContentsView: chat      floating, transparent, draggable panel (React)
```

The preview is a native view, so HTML can't overlay it — the chat panel is its own transparent view stacked on top, moved by the main process as you drag it.

- **Dev server** (`src/main/dev-server.ts`) — runs the dev script in a PTY through your login shell, detects the printed URL, and only marks it ready once a listener in *its own process group* owns the port. If another project's server shadows `localhost` on the other address family, the preview pins to `127.0.0.1` or `[::1]`.
- **Selection** (`src/main/inspector.ts`) — Chrome DevTools Protocol `Overlay.setInspectMode`, the same picker DevTools uses, so nothing is injected into your DOM. HTML, attributes, computed styles, and the box come from protocol commands that page scripts can't spoof; only the React owner chain is read from the page, and it's validated. Element data is sent to the agent marked as untrusted.
- **Source mapping** (`src/main/source-resolver.ts`) — React 19 records where each JSX element was created (`_debugStack`); Grat resolves that frame through the dev server's source maps to `file:line`. Exact for Vite and Next.js (Turbopack); approximate for Next.js (webpack). Server-rendered pages wait for hydration before reading fibers.
- **Agents** (`src/main/agent.ts`, `chat.ts`) — spoken to over the [Agent Client Protocol](https://agentclientprotocol.com) via `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp`, run on Electron's bundled Node. Grat doesn't ship the Claude Code and Codex CLIs the adapters drive (`src/main/agent-binaries.ts`): it uses your own install when its version matches what the adapter was built for, and otherwise the start screen's **Install** button downloads that exact version from npm, checks it against the hash pinned in `bun.lock`, and keeps it in Grat's data folder (your own install is left alone). **Sign in** then runs the agent's own browser sign-in. Each session keeps the permission mode your own agent config picks, and your CLAUDE.md, hooks, and Codex config apply as usual. When the agent asks, Grat auto-approves edits to ordinary source files in the project and asks you in the chat about everything else — config files, dotfiles, lockfiles, scripts, `package.json`, and commands.
- **Preview tools for the agent** (`src/main/mcp-server.ts`, `preview-tools.ts`) — each window serves an MCP server on loopback (random port, bearer token) that Grat passes to every agent session. Agents can `preview_screenshot` (an element, the full page, or at a viewport width like 390), `preview_inspect` (computed styles, box, and source file for a selector), `preview_console`, `preview_navigate`, `preview_reload`, and `dev_server_logs` — so they check their own visual changes instead of guessing.
- **Errors** (`src/main/problems.ts`) — console errors since the last navigation and dev-server build errors since the last successful rebuild show above the composer with a **Fix** button, and ride along with every prompt as untrusted context.
- **History** (`src/main/history.ts`) — each project's transcript, checkpoints, and agent session are saved, so after a restart the chat is still there, old turns can still be undone, and the agent resumes its session (ACP `session/load`) with its memory.
- **Checkpoints** (`src/main/checkpoints.ts`) — before and after every turn the working tree is snapshotted into a shadow git repo under the app's data folder (your `.git` is never touched). **Undo** restores the files that turn (and any later ones) changed to how they were before it; files you edited yourself are left alone. **Redo** reverses the undo.

## Scripts

- `bun run dev` — app with hot reload
- `bun run build` — production bundle in `out/`
- `bun run dist` — packaged macOS app in `release/` (see below)
- `bun run test:e2e` — end-to-end tests against real dev servers (agent turns run only with `GRAT_E2E_AGENT=claude|codex`, since they use real usage)
- `bun run typecheck` / `bun run lint` / `bun run format`

## Packaging

`CSC_IDENTITY_AUTO_DISCOVERY=false bun run dist` builds an unsigned arm64 `.app`, `.dmg`, and `.zip` (the agent CLIs aren't included; see Agents above). For a signed, notarized build, put a Developer ID Application certificate in your keychain (or set `CSC_LINK` + `CSC_KEY_PASSWORD`) and one set of notarization credentials (`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or an App Store Connect API key) before `bun run dist`. `electron-builder.yml` explains each fuse and entitlement. Unsigned builds get a new ad-hoc signature each time, so macOS asks for keychain access on first launch.

## Security model

The preview runs your app plus whatever third-party scripts it loads, so it is treated as semi-trusted: it has no preload or IPC access, its session denies permission requests (camera, clipboard reads, devices, external protocols) by default, and element picking only works on local origins.

Agents get Grat's preview tools over a loopback MCP server that needs a per-window token and rejects other `Host` headers. The tools only act on the local dev server. Everything they return from the page or dev server (element data, console, logs) is fenced and marked as untrusted, the same as selected-element context. Claude's preview tools are pre-allowed by exact name; nothing is auto-approved by matching a tool's title. Chat history is stored owner-only (`0600`), without URL query strings.

Before shipping a signed build, note that the `runAsNode` fuse is on because the agent adapters run on Electron's bundled Node. Any process that can launch the signed app binary with `ELECTRON_RUN_AS_NODE=1` inherits the app's TCC grants. Running the adapters on a separately signed Node binary would allow the fuse to be turned off.

## Not yet

Multi-select and region annotation, quick direct-manipulation tweaks, Vue/Svelte source mapping, exact Next.js webpack mapping, a model picker, auto-update, and parallel variations. Source-map resolution runs on the main thread; very large Next.js maps can briefly stall the UI on pick — moving it to a worker is planned.
