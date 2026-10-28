# Persona 4: literal English reader — before fixes

Target: Gui landing page at http://127.0.0.1:4330, real in-app browser, 1280 × 720. Journey: landing → interactive demo → own requested change → suggested change. Native app/account onboarding was outside this browser journey; no production account or acceptance of terms occurred.

## Steps

1. **Landing — understandable actions, unclear product description.** “Download for Mac” is concrete. “An agent harness” and “the agent that you use now” assume prior knowledge and an existing agent. No plain first-time setup expectation appears next to the actions. Evidence: `01-landing-jargon.png`.
2. **Try it now — misleading scope.** Clicked the visible “Try it now” button. The demo says “Point at something to change” and “Click an element on the page, then write the change. Your agent edits the code and the page updates.” It does not disclose this is a limited simulation before the request. Evidence: `02-demo-open.png` (opening animation); `03-select-instruction.png` (stable selection screen).
3. **Select element — surprising automatic action.** Clicking the labeled “Select element” button selects the words “real app” automatically and starts an unsolicited “Make this semi-bold.” turn. I had not clicked an element in the page or sent a request. The instruction says selection, not “Play example.” Evidence: `04-result-before-send.png`, which shows a completed semi-bold transcript while my different request remains unsent in the composer.
4. **Own wording — rejected.** Following the instruction literally, typed “Make this bold.” and clicked Send. The demo replies “This demo has no agent, so it can only make the changes in the suggestions.” The visible suggestion “Make this bolder” represents essentially the same change, so the natural phrasing is unnecessarily rejected. Evidence: `05-bold-rejected.png`.
5. **Suggested wording — success.** Clicked “Make this bolder.” It changes the weight from 450 to 750 and visibly bolds “real app.” First requested demo success achieved after recovering from the wording rejection. Evidence: `06-suggestion-success.png`.

## Findings

| ID | Severity | Problem | Recommended fix | Evidence |
|---|---|---|---|---|
| L1 | P1 | “Write the change” promises free wording, but “Make this bold.” is rejected while “Make this bolder” works. | Disclose supported demo changes before entry and accept ordinary variants such as bold/bolder. | 05-bold-rejected.png |
| L2 | P2 | “Select element” performs selection plus an automatic example request. | Separate selecting from running the example, or label the action “Play example” and describe it. | 04-result-before-send.png |
| L3 | P2 | Landing description uses “agent harness” and assumes the visitor already has an agent. | Explain the product in ordinary words and state the required setup/agent account next to starting actions. | 01-landing-jargon.png |
| L4 | P2 | Demo instructions imply any element and a real agent; limitations are explained only after failure. | Label it as a guided browser demo and explain selection scope and suggested actions up front. | 03-select-instruction.png, 05-bold-rejected.png |

Saved screenshots 05 and 06 were reopened from disk and visually verified. Screenshots 01, 03, and 04 were inspected at capture and their exact bytes saved. Screenshot 02 records an opening transition and is not used as stable visual-layout evidence. No source inspection was used to form these findings.
