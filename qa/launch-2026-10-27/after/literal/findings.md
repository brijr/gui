# Persona 4: literal English reader — after fixes

Target: http://127.0.0.1:4331 in a fresh real Chrome tab at 1280 × 800. The in-app browser was unavailable during rerun, so Chrome was used. No product source was inspected. No product edits were made.

## Result: first requested demo change passed

1. **Landing — pass.** The hero now says “Design on your real app. Tell your AI coding agent what to change.” The next paragraph explains Gui is a Mac app and describes select → describe → edit. The browser-demo capabilities and no-account requirement are visible before entering it. Evidence: `01-plain-landing.png`.
2. **Enter demo — pass.** Clicked “Try it now.” The panel discloses “Browser demo: bold, serif, or blue. No live AI agent.” The automatic example is labeled “Example playing,” and the “Try it yourself” action is available. Evidence: `02-labeled-example.png`.
3. **Take control — pass.** Clicked “Try it yourself.” Status changed to “Your turn. Select text and try bold, serif, or blue.” The chat remained empty, the headline stayed light, and suggestion controls stayed disabled until selection. No unexplained edit occurred. Evidence: `03-your-turn-no-auto-edit.png`.
4. **Select and write — pass.** Clicked the words “real app” in the live page, then typed exactly the previously rejected wording, “Make this bold.” The selected span appeared in the composer and Send became enabled. No example turn or unrelated request appeared while entering the message. Evidence: `04-bold-ready-to-send.png`.
5. **First success — pass.** Clicked Send once. The demo accepted the phrase, displayed one completed request, reported the selected text weight changed from 250 to 550, and visibly bolded “real app.” Undo was available. Evidence: `05-bold-first-success.png`.

All four original literal-reader findings were addressed in this rerun: plain hero wording, limitations disclosed in advance, labeled and interruptible example playback, and accepted natural wording. No new blocker occurred on the tested browser path. This verifies browser-demo success, not native Mac installation, account creation, or a real AI agent turn.

Screenshots 03 and 05 were reopened from saved files and visually inspected. Viewport override was reset afterward.

## Environment note (excluded from product findings)

The initially supplied `http://localhost:4331` resolved to an unrelated Photobooz server. No controls there were used; `00-wrong-target-blocker.png` records the mismatch. The parent supplied the verified IPv4 target `http://127.0.0.1:4331`, which displayed the correct rebuilt Gui site and was used for all steps above.
