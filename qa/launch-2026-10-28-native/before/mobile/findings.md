# Native Gui mobile persona — baseline

Run: October 28, 2026. Target: isolated Gui QA Mobile.app at /Users/brijr/Library/Caches/GuiLaunchQA/20261028/Gui QA Mobile.app. This was the real Electron editor with a real Claude Code agent, driven only through native CUA. The user's installed Gui and MatterOS project were not used.

## Scope and limits

Gui is a Mac application, not a phone app. Its native window was not 375px wide. The built-in Mobile preset displayed 390 × 844 at 95% scale, clearly labeled above the preview. The scratch app used the provided server with 400ms response latency and 50kB/s HTML throughput; this approximates a slow connection for the preview, not the native application's whole network.

The agent was explicitly asked to check 375px using Gui preview tools. Its final answer says it checked 375px, and the native trace shows Screenshot the preview, Inspect element, and Check preview errors all completed. The native trace does not expose tool parameters, so 375px itself is agent-reported until the parent checks the persisted tool arguments. No CDP, injected scripts, preload API, or browser automation was used by this persona.

Production sign-in was outside this isolated editor run: the parent configured GUI_ACCOUNT_REQUIRED=0 for the editor profile while the real account flow awaits legal approval. This run proves the editor journey only.

## Journey

1. **Welcome — healthy.** Open project was clear; Claude Code and Codex showed Ready. Screenshot 01-welcome.png.
2. **Open project — healthy.** Used the native folder picker to open /tmp/gui-native-qa-20261028/mobile-project.
3. **Trust/start — healthy.** Gui showed the exact npm run dev command and a clear Start App action. Accepted only this known disposable scratch project's command. Screenshot 02-start-confirmation.png.
4. **Mobile preview — healthy.** Selected the Mobile toolbar button. The page displayed in a 390 × 844 frame at 95%; text and controls were readable, with the chat beside the preview. Screenshot 03-mobile-preview.png.
5. **Selection/request — healthy.** Clicked Select element, selected the Hello Gui heading, and entered: Make the selected heading purple (#7c3aed). Keep the words the same. Check the result at 375px wide using Gui preview tools before you finish. Screenshot 04-selected-and-request.png.
6. **Real first success — healthy.** Claude Code changed the real index.html file in 8 seconds. The preview rendered a purple Hello Gui heading, and the result card showed before/after, one file changed, Follow up, and Undo. Screenshot 05-real-purple-result.png.
7. **Verification trace — healthy, width boundary noted above.** Expanded 6 steps and observed actual command/edit plus preview screenshot, element inspection, and error checking. Screenshot 06-real-tool-trace.png.
8. **Undo — healthy.** Clicked Undo. Hello Gui returned to black and the result card said Undone with Redo. Screenshot 07-undo-restored.png.

## Findings

No reproducible product defect, confusion, or first-success blocker was found on this native editor journey. The native Mobile preset is 390px; 375px was delegated to the real agent's preview tool as requested, with exact parameter verification left to the parent. This is not a claim of physical-phone or phone-width native-app coverage.

## Evidence

All PNGs are exact native screenshots captured during this run. Welcome, start confirmation, preview, selection, purple result, expanded tool trace, and restored result were visually inspected. No external accounts, emails, commits, releases, or permission expansions were performed. The scratch change was undone.
