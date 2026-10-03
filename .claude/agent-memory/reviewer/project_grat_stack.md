---
name: grat-stack
description: Grat is an Electron 44 + electron-vite desktop app (React 19 renderer, React Compiler, zustand); Next.js/React Router reviewer checks don't apply
metadata:
  type: project
---

As of 2026-10-03 (commit d787848), Grat is an Electron 44 app built with electron-vite. It has no Next.js and no React Router. The main process lives in src/main, the preload is sandboxed CJS, and there are two renderer entries: index.html (toolbar, canvas, logs) and chat.html (floating chat panel in its own WebContentsView).

**Why:** The default reviewer checklist picks its checks by stack (Next.js or React Router). Applied here, it produces false positives: Image/Link wrappers, @/ or ~/ aliases, Server Components, Lenis/Tempus/hamo.

**How to apply:** Skip those checks. Focus instead on:
- main-process lifecycle, especially async work that continues after a window is disposed
- the IPC contract in src/shared/ipc.ts
- child processes: the node-pty dev server, the ACP agent adapters, and shadow git
- renderer effects

See [[grat-review-focus]].
