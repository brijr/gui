# Literal-reader native rerun

Status: PASS for the editor journey and requested copy/selection fixes. No blocking failure on this path.

Environment: canonical `/Users/brijr/Library/Caches/GuiLaunchQA/20261028/Gui QA Literal.app`, fresh literal-after profile, existing `/tmp/gui-native-qa-20261028/literal-project`. Real Claude Code, no agent mocks. Production signup/sign-in and terms acceptance were not tested; this editor profile used `GUI_ACCOUNT_REQUIRED=0`.

## What was verified

1. Welcome helper copy visibly explains New project, New canvas, and Open project. Open project and Clone by URL also expose useful accessibility help. Screenshot `01-welcome.png`.
2. Open project -> native folder picker -> existing scratch project -> Start App succeeded. Preview loaded automatically with black Hello Gui title.
3. First-edit notice visibly says the first message starts a separate version, called a Git branch, and main stays unchanged. This explains the Git term before using it. Screenshot `02-first-edit-guidance.png`.
4. The composer visibly explains Auto scope before the first message: the agent can edit files and run commands without asking, including outside the project; it explains how to review more requests. Screenshots `02` and `05`.
5. Select element displayed visible Click/Drag/Shift/Esc instructions. A second native AX+screenshot observation at 7.113 seconds after entering selection mode still showed the instructions, with no fixed sleep. Screenshots `03-pick-instructions-first.png` and `04-pick-instructions-after-reading.png`.
6. Clicking Hello Gui produced a plain `Heading Hello Gui` selection card, without the previous h1/CSS path. Screenshot `05-heading-card.png`.
7. Sent literal request `Make the title blue`. Real Claude Code edited the project. Preview visibly changed to blue; Result displayed before/after thumbnails, `1 file changed +1 −1`, and Undo. Screenshots `06-agent-working.png` and `07-result-blue.png`.
8. Undo visibly restored black Hello Gui and displayed Undone/Redo. Screenshot `08-undo-black.png`.
9. Redo visibly reapplied blue Hello Gui and restored Undo. Screenshot `09-redo-blue.png`.

## Remaining observation

P3 accessibility: the fresh native accessibility tree still reports composer placeholder `Queue a message…` after the real turn finishes, while the visible screenshot reads `Ask Claude Code…`. The message field remains usable and no visible-user failure occurred. Repro: finish a real turn -> inspect fresh native AX state and screenshot. Seen at Result and Undo/Redo. This mismatch existed in the before pass as well.

No new functional issue found. Optional form Escape was not exercised because this pass was scoped to the required complete edit/Undo/Redo path.

## Evidence handling

All app interactions and observations used native CUA APIs. PNGs are exact bytes returned by native `getScreenshot` / `getAXStateAndScreenshot`; no compositing or browser automation. No product source was inspected or edited by this QA agent. UI lease was returned immediately after screenshot 09; notes were written afterward through the filesystem.
