# Agents

Run `bun run check` before calling the work done. One e2e spec: `bun run test:e2e -g <name>`.

**Where things live.** Electron main is `src/main`, preload `src/preload`, UI `src/renderer`, shared types `src/shared`. The accounts worker is `accounts/`. The marketing site is `www/`.

**Project lifetime.** `ProjectResources` owns one opening. Capture `generation` and drop late async work with `stillCurrent` / `ifCurrent`. Chat turns use `ChatController`'s epoch the same way. Never keep a resource past dispose.

**Subprocesses.** Spawn and `execFile` only through `src/main/process.ts` (`spawnProcess`, `childEnv`). That module scrubs agent/Electron env and can set `BROWSER=none`. Do not import `node:child_process` elsewhere in `src/`.

**Coordinates.** Page, viewport, and scaled view pixels are different types in `src/shared/coords.ts`. Convert explicitly; do not multiply a rect by scale inline.

**Growth.** Transcripts, checkpoints, and terminal output share caps in `src/shared/bounded.ts`.

**GitHub tokens.** `RepoToken` is an installation token for one repo. `UserGitHubToken` is the user's OAuth token. They are not interchangeable.

**Commits.** What a user sees, in plain words (`fix:`, `feat:`, `chore:`).

**Human review.** Credential handling, anything that writes the user's git repo, and release/signing scripts need a person before they land. Do not commit secrets.

Skills: `.cursor/skills/release`, `.cursor/skills/e2e-motion`. Git hook: `git config core.hooksPath .githooks`.
