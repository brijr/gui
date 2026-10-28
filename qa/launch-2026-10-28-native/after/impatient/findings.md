# Impatient native persona — after rerun

Result: PASS. No product error encountered. Both reported frictions are fixed in this native journey.

Scope: the real isolated Gui QA Impatient.app at `/Users/brijr/Library/Caches/GuiLaunchQA/20261028/Gui QA Impatient.app`, fresh after profile, real installed Claude Code and real local Website project. Feature QA used `GUI_ACCOUNT_REQUIRED=0`; this does not prove signup. No authentication action, terms acceptance, OS permission, or security prompt was performed. No product source was inspected or edited by this persona.

1. Skimmed the welcome screen and clicked the strongest blue action, now **New project**. The explanation below distinguishes New project, New canvas, and Open project. Unlike before, the first action directly starts creation instead of opening an existing-folder picker. Evidence: `01-welcome-new-project-primary.png`.
2. Kept Website, named it `impatient-after`, clicked Create, selected `/tmp/gui-native-qa-20261028` in the native picker, and clicked Create Here. The resulting new project is `/private/tmp/gui-native-qa-20261028/impatient-after`; the earlier coffee project was not overwritten.
3. Dependencies installed and the native preview ran at `http://localhost:5175/`. The first-use Auto explanation was visible in chat before sending. Evidence: `02-project-running.png`.
4. The suggestion list disappeared once startup reached the preview, so entered the comparable request: “Build a landing page for a coffee shop. Keep it local and do not use external services.” Sent it to the real default Claude Code provider. Native chat showed Working. Evidence: `03-real-agent-working.png` (captured after the subsequent preview click, while the bubble transition was settling).
5. During the actual turn, clicked the preview headline. Select element was OFF (Value 0); selection mode was never enabled. Chat automatically tucked to a small spinner bubble. Evidence: `04-working-auto-tucked-bubble.png` and its AX capture.
6. Made no Show chat, minimize, or chat-toggle action while waiting. The real agent completed and the full chat returned automatically, showing the final response and Result card. This directly verifies the chat restoration fix. The agent built a local Hearth & Bean landing page with a coffee illustration, menu, story, address, and hours. Result showed **2 files changed, +169 −56**. Evidence: `05-result-returned-automatically.png` and its AX capture.
7. Clicked Undo on that actual Result. The preview visibly returned to “A clear headline that says what you do,” and the card showed Undone / Redo. Evidence: `06-undo-restored-starter.png`.
8. Clicked Redo. The preview visibly returned to “Good coffee, slow mornings.” / Hearth & Bean, and Undo became available again. Evidence: `07-redo-restored-ai-page.png` and its AX capture.

No remaining confusion, blocker, or quit-triggering error was found in this rerun. The result is an actual native project and real AI-generated edit, including verified Undo/Redo; it is not a manual empty frame or a website demo.

UI lease returned to parent immediately after saving the final Redo captures. No additional UI exploration followed.
