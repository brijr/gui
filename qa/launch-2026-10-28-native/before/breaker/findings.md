# Breaker persona — native Gui baseline

Date: October 28, 2026. App: /Users/brijr/Library/Caches/GuiLaunchQA/20261028/Gui QA Breaker.app. All interaction used the native CUA API. Product source was not inspected or changed. User's /Applications/Gui.app and its MatterOS session were not touched.

## Environment and limits

Fresh isolated development profile with GUI_ACCOUNT_REQUIRED=0 for editor testing. Real Claude Code shown Ready. Scratch project /tmp/gui-native-qa-20261028/breaker-project, preview http://127.0.0.1:5280/. No production account, terms acceptance, external clone, or mock agent. Native screenshots were captured, saved, and visually inspected. Account onboarding is not proven by this editor test.

## Numbered journey

1. Healthy: start screen offers Open project, New project, New canvas, Clone by URL; Claude Code and Codex Ready.
2. Healthy: double-click Clone by URL opens one inline form. Pasted malformed HTML/emoji/path string, double-clicked Clone. Clear inline error: Enter a GitHub repo, like owner/repo or its github.com address. No clone started. Screenshot01.
3. Healthy: Cancel returns to start screen. Double-click New project opens one inline form. Malformed slashes/HTML/emoji project name is rejected: Use a name without slashes or colons, like my-app. Screenshot02.
4. Healthy: Cancel → double-click Open project opens one native chooser. Selected exact breaker-project and accepted trusted command npm run dev / PORT=5280 QA_SLOW=0 bun server.ts. Preview displays Hello Gui and instructions.
5. Healthy: clicked native Select element, then actual Hello Gui heading through fresh AX. Selection is real h1 with CSS path; composer gains selected element. Screenshot03 shows picking mode.
6. Healthy: pasted Make only the selected Hello Gui heading green (#16803c). Keep all other content and layout the same. Double-click Send produced one user turn, started real Claude Code, and created branch gui/make-only-the-selected-hello-gui-heading. Screenshot04.
7. Native first success achieved: real Claude Code changed index.html, preview heading visibly green, Result shows Before/After and 1 file changed +1−1, with Undo. Screenshot05. No further AI turn was needed.
8. Healthy: double-click Undo produces black heading, Undone state, and Redo; double-click Redo restores green heading and Undo. Screenshots06–07.
9. Defect: double-click visible preview Back takes app preview to blank white. Fresh AX later explicitly reports HTML content about:blank. Displayed address stays http://127.0.0.1:5280/, Running stays green, Forward remains disabled, Back remains enabled. Chat minimizes. Screenshot08.
10. Defect recovery: visible Reload leaves blank preview and stale local address. Screenshot09. Tried reopening displayed address with native focus/paste/Return and documented ShiftCmdL; input routing did not reliably act, so that part is a harness limit, not an additional product claim. Tried Restart Dev Server from status menu; outcome recorded below.

## Ranked findings

- P1/P2: Back can expose about:blank and strand the preview, with stale address and navigation states. Reproduce after initial project open or completed edit/Undo/Redo: double-click Back. Expected browser navigation either stays on valid project history or Forward allows recovery; observed blank preview, Reload blank, local address unchanged, Forward disabled. Screenshots08–09 and fresh AX evidence. Count one persona; root should validate once against current source/build to determine severity.

## Harness friction excluded

The CUA tool occasionally reported the app changed and required a fresh state before actions. Some keyboard sequences (Go to Folder path paste/Return, later address recovery, Escape in inline forms) did not reliably route. AX button clicks and h1 picking worked and their screenshots match. Do not count Escape behavior as a product defect until independently reproduced.
