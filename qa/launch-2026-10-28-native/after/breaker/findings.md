# Breaker persona — native Gui rerun

Date: October 28, 2026. Native CUA only. Exact isolated app: /Users/brijr/Library/Caches/GuiLaunchQA/20261028/Gui QA Breaker.app. Fresh breaker-after-profile, GUI_ACCOUNT_REQUIRED=0 for editor testing, real Claude Code Ready. Scratch project only; no product source inspection or modification, no preload/CDP, no production terms/account, and no interaction with /Applications/Gui.app.

## Result

Real native first success repeated: selected Hello Gui heading changed from green to orange (#c2410c) by the actual Claude Code provider, with a rendered orange heading and Before/After Result. The original Back-to-about:blank defect is fixed in this native rerun. Rapid Redo now also passes a focused visual rerun after the scratch fixture watcher was repaired. No remaining product defect was found in this persona rerun; the initial mismatch is preserved below as audit chronology.

## Numbered journey

1. **Healthy — Welcome.** New project is primary, with plain helper text explaining New project, New canvas, Open project. Claude Code and Codex show Ready.
2. **Healthy — Junk clone URL.** Double-click Clone by URL opens one form; HTML/emoji/path junk and double-click Clone produce the clear repository-format message, without an external clone. Screenshot01.
3. **Healthy — Escape after invalid clone submit.** Actual native Escape from the focused Clone button returns to the welcome screen. Key routing worked this run.
4. **Healthy — Junk project name.** Double-click New project opens one form; slashes/HTML/emoji name and double-click Create produce the plain name-format message. Actual Escape after invalid submission exits the form. Screenshot02.
5. **Harness exclusion — First open interrupted.** Selected exact scratch and accepted the trusted command. Terminal-session cleanup then killed the configured QA app process/server. Parent confirmed the process was cleaned up, and CUA launched stock Electron without repository arguments when rebound. Screenshot03 is excluded from product findings. Parent relaunched a detached controlled process, PID35206, using the preserved profile.
6. **Healthy — Real scratch open.** Recent gui-qa-breaker opened the scratch project and real preview on 5280.
7. **Fixed — Initial Back.** Native AX shows Back and Forward disabled on first project page. Attempted double-click Back leaves real green heading visible. Reload retains the app and correct address. Screenshot04.
8. **Fixed — Valid history.** Native address input navigated to http://127.0.0.1:5280/#second. Back changes displayed address to root, disables Back, enables Forward. Forward restores #second and the actual preview. Screenshot05. No about:blank or stale toolbar state.
9. **Healthy — Actual selected-heading edit.** Native Select element → actual Hello Gui h1. Selection label now says Heading Hello Gui. Pasted Make only the selected Hello Gui heading orange (#c2410c) instead of green. Keep all other content and layout the same. Double Send created one real turn. Screenshot06.
10. **First success — Real orange result.** Claude Code completed the edit; native preview is orange, Result shows green Before/orange After, 1 file changed +1−1 and Undo. Screenshot07.
11. **Healthy — Double Undo.** Actual preview returned green, Result says Undone with Redo. Screenshot08.
12. **Needs verification — Double Redo.** Native AX switches from Redo to Undo, and the Result After remains orange, but actual preview remained green in immediate and settled screenshots. Screenshot09 (`09-double-redo-preview-mismatch.png`). Root must inspect scratch/checkpoint state to distinguish rapid-toggle race, stale live preview, or an evidence issue. It is not a proven pass.

## Initial candidate — resolved as scratch-fixture behavior

- **P2 candidate: rapid Redo can report applied while the preview still shows the undone version.** Reproduction: real green-to-orange edit → double-click Undo → green + Undone → double-click Redo → AX Undo but preview remains green. Before/After result still shows orange After. Screenshot09. Root was notified immediately and given UI lease for verification.

## Evidence limits and lease

Screenshot03 is a confirmed harness shutdown, not a product opening defect. This editor test bypasses production account requirements via development configuration and does not prove production signup. No additional AI turn was sent. UI lease returned immediately after final mismatch screenshot; filesystem notes were written afterward.


## Focused completion and fixture triage

Root independently verified that the saved scratch HTML contained the orange #c2410c style, chat state recorded applied (reverted=false, redo=null), and HTTP on5280 served the orange document. Those checks were performed by root; this persona did not inspect source or invoke preload/CDP. Root identified the stale preview as a scratch-server watcher error: watching the index.html inode with fs.watch stops observing replacement files after Git's atomic restore. Root changed only the disposable fixture server to watch the directory and filter index.html. No product patch was needed for Redo.

13. **Healthy — Fixture restart through product UI.** Used the actual native Dev server: Running menu → Restart Dev Server. Real preview became orange and agreed with the existing applied Result. `10-restarted-fixture-orange.png`.
14. **Healthy — Repeat double Undo.** Existing actual-provider Result → double-click Undo. Preview became green and Result said Undone with Redo. `11-double-undo-green.png`.
15. **Healthy — Repeat double Redo.** Double-click Redo. Preview became orange and Result offered Undo. `12-double-redo-orange.png`. The screenshot was visually inspected and matches native AX applied state.

Final breaker verdict: native first success, malformed-input handling, duplicate-click handling, Escape recovery, initial Back guard, Reload, valid Back/Forward navigation, and rapid Undo/Redo all passed. The initial screenshot09 mismatch is an excluded fixture issue, not a remaining product regression. No additional AI turn was spent. UI lease was returned immediately after screenshot12; notes were updated afterward.
