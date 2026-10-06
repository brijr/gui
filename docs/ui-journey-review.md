# Gui user journey review

Reviewed October 5, 2026 in the running Electron app with `bun dev`, using the Apple Design guidelines.

## Changes

- Project creation and cloning have persistent field labels and explain the next save-location step.
- Projects without a dev script lead with building the app in chat. Open chat reveals the panel and focuses the composer. The package.json instruction is under Details.
- Signed-out GitHub Projects reads for a saved session before accessing Keychain. Opening Projects no longer requests secure storage unnecessarily.
- GitHub's Back action is above the page content.
- Chat settings explains floating and sidebar layouts.
- Segmented controls, switches, Settings navigation, and recording cards give immediate press feedback. Settings pages cross-fade briefly without moving their content.
- Recording playback, metadata, and errors use Gui's supported theme tokens.
- Journey tests reflect the current start screen and compact recording cards. Regression checks cover signed-out Keychain access and opening chat from an empty project.

## Manual coverage

| Page or journey | Verified in the running app |
| --- | --- |
| Start page and tabs | New tab, recent chats and projects, project actions, tab closing |
| New project | Name entry, save-location dialog, isolated empty project, direct chat action |
| Clone form | Persistent label, save-location guidance, Escape cancellation |
| GitHub Projects | Connected repository list in installed Gui; signed-out page and Back in development Gui |
| Settings | Agents, custom-agent form and cancellation, Chat, Projects, Storage |
| Preview | Local project trust prompt and startup, desktop and mobile layout, focus mode and Escape |
| Selection and chat | Real heading selected, source location attached, composer focused, live agent response |
| Chat layout | Dock, float, header drag, minimize, expand, model and effort picker dismissal |
| Screenshots | Preview screenshot attached to composer and removed |
| Recording | Capture, stop, attachment, preview dialog, playback with advancing timeline, close and removal |
| Terminal and logs | Drawer opening, terminal input, dev-server tab, drawer closing |
| Pull request | Review form and return to chat; no live publication from the app |
| Help | Shortcut sheet, keyboard navigation and Escape dismissal |

## Automated verification

- Typecheck, lint, production build, and diff whitespace checks passed.
- 46 distinct UI checks passed across the broad run and affected-suite rerun. Coverage includes setup and failure recovery, GitHub against a test service, models, recording persistence and frame tools, selection, terminal lifecycle and output flooding, simulated shipping, shortcuts, viewports, docking, tab motion, layout interruptions, and reduced motion.
- Six spring checks passed for damping, frame-rate independence, velocity handoff, retargeting, momentum projection, and CSS easing.
- Two focus-dependent checks were skipped by the local suite's default configuration. The native walkthrough separately exercised chat focus, selection focus, terminal input, and restoring the composer after recording.
- Four obsolete assertions failed in the first broad run. The corrected start-screen and recording tests passed in the rerun.

Live GitHub sign-in, repository creation, agent installation, and publishing from Gui were not performed during this review. GitHub and shipping mutations were verified against isolated test services and repositories. The walkthrough used one live read-only agent turn. CI is a separate check triggered by pushing main.

## Second pass

Walked through again on October 5, 2026 in `bun dev`, as a user with a fresh Vite project: start screen, trust prompt, starting the app, picking, a live Codex turn, Undo, viewports, drawer, Settings, a second tab, GitHub projects, cloning, shortcuts, focus mode, docked chat, the pull-request sheet and the dev server stopping.

- Start screen agents: installed but unchecked agents read "Installed" rather than a column of "Check now" links, and choosing one switches to it (checking it on the way).
- An agent whose login expires mid-chat no longer ends the turn at a bare "Authentication required". The turn offers Sign in, the agent shows signed out everywhere, and the message drops terminal instructions when Gui can sign in itself.
- After picking, the empty chat asks for the change instead of offering to pick again.
- Long, thin picks (headings, nav bars) read in their thumbnail and in Before/After instead of shrinking to a hairline.
- The model chip drops the effort before cutting the model name ("Sonne…").
- The chat header names the agent's mode only when Gui didn't set it from Ask or Auto, so "Auto review" no longer sits beside "Auto".
- A dev server stopped from outside Gui (SIGINT, SIGTERM) shows a calm bar with Start, not a crash, and its package manager's "exited with code" line isn't offered to the agent as an error to fix.
- Branch and path labels keep a short prefix whole ("gui/make-this…", not "g… /make-this…").
- Settings → Projects matches its sibling sections; GitHub buttons size to their labels and repositories use the shared list.
- Menus call cloning "Clone by URL…", as the start screen does, and the project menu uses title case.

Verification: typecheck, lint and the production build passed. The full UI suite ran 113 tests: 107 passed, 5 were skipped by default (agent turns and focus-dependent checks), and one stale assertion failed. Its row lookup also matched the row's Remove button. With that fixed, the recent-chat, GitHub and Settings specs passed on a rebuild after the last changes.

Not exercised live: GitHub sign-in and repository creation, finishing an agent's browser sign-in, and publishing a pull request.
