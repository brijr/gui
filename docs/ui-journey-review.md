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
