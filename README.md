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

Open a project folder (⌘O). Grat detects the package manager and `dev` script, starts it, and loads the URL it prints. To open a project on launch: `GRAT_OPEN=/path/to/project bun run dev`.

| Action | Shortcut |
| --- | --- |
| Select element | ⇧⌘C (Esc cancels) |
| Toggle chat | ⌘J |
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
- **Selection** (`src/main/inspector.ts`) — Chrome DevTools Protocol `Overlay.setInspectMode`, the same picker DevTools uses, so nothing is injected into your DOM. The picked node yields outer HTML, computed styles, a cropped screenshot, and the React owner chain.
- **Source mapping** (`src/main/source-resolver.ts`) — React 19 records where each JSX element was created (`_debugStack`); Grat resolves that frame through the dev server's source maps to `file:line`. Exact for Vite and Next.js (Turbopack); approximate for Next.js (webpack). Server-rendered pages wait for hydration before reading fibers.
- **Agents** (`src/main/agent.ts`, `chat.ts`) — spoken to over the [Agent Client Protocol](https://agentclientprotocol.com) via `@agentclientprotocol/claude-agent-acp` and `@agentclientprotocol/codex-acp`, run on Electron's bundled Node. Sessions start in an edit-accepting mode when the agent offers one; other tool permissions are asked inline in the chat. Your agent config (CLAUDE.md, hooks, Codex config) applies as usual.
- **Checkpoints** (`src/main/checkpoints.ts`) — before and after every turn the working tree is snapshotted into a shadow git repo under the app's data folder (your `.git` is never touched). **Undo** restores files changed since that turn began; **Redo** reverses the undo.

## Scripts

- `bun run dev` — app with hot reload
- `bun run build` — production bundle in `out/`
- `bun run typecheck` / `bun run lint` / `bun run format`

## Not yet

Packaging/signing, chat history persistence, multi-select, agent self-verification tools (MCP), console errors as context, and parallel variations are planned for later phases.
