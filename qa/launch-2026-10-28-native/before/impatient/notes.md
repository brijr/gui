# Impatient native journey — before

Scope: real Gui QA Impatient.app, isolated profile, genuine installed Claude Code. Feature QA used GUI_ACCOUNT_REQUIRED=0 and does not prove signup. No legal terms or OS security prompts were accepted. No product source was inspected or changed by this persona.

## Numbered journey

1. Skimmed welcome; clicked dominant blue Open project. A native folder picker opened. With no existing project there was nothing useful to choose, so cancelled. Annoyance: the strongest CTA assumes I already have a project. Screenshot 01 / 02.
2. Clicked New project, kept default Website, named it impatient-coffee, clicked Create, selected /tmp/gui-native-qa-20261028 in native folder picker, clicked Create Here. Screenshot 04.
3. Project opened at /private/tmp/gui-native-qa-20261028/impatient-coffee. Native UI showed Installing dependencies, then Starting your app, with a first-run explanation. Install and dev server completed without an error. Screenshot 05.
4. Clicked the first chat suggestion, Build a landing page for a coffee shop. This filled the composer; clicked Send. Real Claude Code started and the native UI showed Working. Screenshot 06.
5. Real agent finished in roughly a minute and changed three files (+210 / -55). Native preview at localhost:5175 showed an Impatient Coffee landing page, CSS latte illustration, Great coffee, without the wait headline, menu, and hours. Screenshot 07.
6. During the agent visual checks the chat became minimized. It remained minimized after completion; I reopened the small Show chat bubble to see the final response and Result card. This is a nonblocking completion-discovery annoyance. Screenshot 07 (minimized) and 08 (reopened).
7. Clicked Undo on the real Result card. The preview visibly returned to the original A clear headline that says what you do template and Result showed Undone / Redo. Screenshot 09.
8. Clicked Redo. The coffee page visibly returned, and Undo was available again. Screenshot 10 and AX text confirm the state.

## Actual result

PASS: native project creation -> install -> real coding-agent request -> real rendered AI-built page -> Undo -> Redo. No product error encountered, so the impatient persona did not hit its quit-at-first-error rule. No AI success was inferred from a manual empty frame.

## Harness-only interruption (not a product finding)

The first /tmp cloned app had unique CFBundleName but reused executable identity. AX advanced while screenshots froze at welcome and keyboard did not reach fields; a coordinate action returned noWindowsAvailable. Parent repaired the QA app identity and relaunched at /Users/brijr/Library/Caches/GuiLaunchQA/20261028/Gui QA Impatient.app with a unique executable. Screenshot/AX and field input then agreed. Earlier screenshots 01–03 and harness-blocker-ax.txt must not be counted as a product UI failure. Native folder Go to dialog paste also did not update its field; direct AX setValue did. This is automation interaction friction, not established product behavior.

## Repro of product annoyances

- Zero-project welcome: fresh isolated profile -> strongest blue Open project -> native folder picker, then Cancel to reach creation choices. New project and New canvas are secondary choices without a short distinction.
- Completion discovery: new Website project -> first coffee-shop suggestion -> Send -> allow real Claude Code screenshot/phone checks -> observe minimized chat bubble after agent completion -> reopen Show chat to see final result. Severity: low/nonblocking; actual preview success is visible.

## Auth transition observation

No sign-in or authentication action was performed. On the first binding to the repaired canonical app path, initial AX unexpectedly showed Sign in to Gui / Continue in your browser / Open browser again / Cancel / Terms / Privacy. I did not click anything. The next getAXStateAndScreenshot spontaneously showed welcome. The following New project click was rejected by CUA as user-changed-app, so I rebound the same canonical path. Its welcome now said Open from GitHub rather than Connect GitHub. I proceeded only with New project. Parent was notified of the transition; no auth completion can be attributed to this persona and signup remains unproven.
