# Native Gui mobile persona — after rerun

Run: October 28, 2026. Target: /Users/brijr/Library/Caches/GuiLaunchQA/20261028/Gui QA Mobile.app, using the fresh mobile-after-profile prepared by the QA lead. The real Electron editor and real Claude Code agent were used. All interaction was through native CUA; this persona did not inspect or manipulate product source, preload APIs, CDP, or browser internals.

## Journey and health

1. **Welcome — passes.** New project is the primary action. Open project, New canvas, and Clone by URL have explanations. Claude Code shows Ready. Screenshot: 01-welcome.png.
2. **Open/start — passes.** Used Open project and the native folder picker for /tmp/gui-native-qa-20261028/mobile-project. Gui displayed the exact npm run dev command and Start App confirmation. Screenshot: 02-start-confirmation.png.
3. **Loading — passes.** The accessibility state briefly showed Loading your app… with Details and disabled preview actions. The app loaded successfully. Screenshot 03-slow-loading-state.png was captured after loading had already completed, so it documents the loaded desktop state, not the earlier loading indicator.
4. **Mobile preview — passes.** Selected the native Mobile preset. Its label reads Mobile · 390 × 844 · 95%. Content is readable, the page scrolls vertically, and chat stays beside the preview. Screenshot: 04-mobile-preview.png.
5. **Select/request — passes.** Selected the Hello Gui heading. The updated selection chip says Heading Hello Gui in plain language. Auto mode's command scope is explained before sending. Submitted the same request as baseline: “Make the selected heading purple (#7c3aed). Keep the words the same. Check the result at 375px wide using Gui preview tools before you finish.” Screenshot: 05-selected-and-request.png.
6. **Real first success — passes.** Claude Code changed the real scratch index.html in 10 seconds. The native preview showed purple Hello Gui. The result card offered before/after, one changed file, Follow up, and Undo. Screenshot: 06-real-purple-result.png.
7. **Agent verification — passes within the stated limit.** Expanded seven steps. The actual edit command, Screenshot the preview, Inspect element, and Check preview errors all showed Done. The final response says the result was checked at 375px wide. Screenshot: 07-real-tool-trace.png.
8. **Undo — passes.** Undo restored black Hello Gui. The result card showed Undone and Redo. Screenshot: 08-undo-restored.png.
9. **Redo — passes.** Redo restored purple Hello Gui and the Undo action. Screenshot: 09-redo-purple.png. The disposable scratch project was left in this uncommitted state for review.

## Findings

No reproducible product defect, confusion, or first-success blocker was found in this native mobile editor rerun. The improved welcome explanations, plain selection label, and Auto disclosure remain readable with the mobile preview open.

## Coverage boundaries

Gui is a Mac app with a desktop minimum window size; it was not run as a 375px native phone app. Its actual built-in Mobile preset is 390 × 844. The real agent reported a 375px tool check, but the native trace exposes tool titles rather than parameter values, and those parameters are not retained for independent verification. Exact 375px coverage is therefore agent-reported here.

The scratch preview server imposed 400 ms response latency and 50 kB/s HTML delivery. This approximates a slow preview connection, not packet-level 3G for every native app or agent request. No physical touch screen, mobile keyboard, device browser, or full network emulation was tested.

This editor run used the lead's ordinary development profile with GUI_ACCOUNT_REQUIRED=0. It does not prove production account creation or sign-in; that separate flow still requires the user's approval for terms/auth permissions. No external account, email, commit, release, or permission expansion was performed.

All PNGs are exact native screenshots from this rerun and were visually inspected. The UI lease was returned immediately after the successful Redo capture.
