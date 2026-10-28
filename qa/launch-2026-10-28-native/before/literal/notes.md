# Native QA: literal reader

App: /Users/brijr/Library/Caches/GuiLaunchQA/20261028/Gui QA Literal.app
Scratch folder: /tmp/gui-native-qa-20261028/literal-project
Persona: first-time non-native English reader; follow literal instructions.

## Journey so far
1. Welcome: Open project… -> native picker -> scratch folder.
2. Read Start App confirmation and started trusted scratch app.
3. Preview loaded automatically. Clicked Select element; clicked visible Hello Gui headline.
4. Typed exact request: Make the title blue. Clicked Send. Real Claude Code turn started; new branch visible.

## Candidate clarity findings
- Welcome uses “agents”, “Clone by URL”, and “New canvas” without a short explanation of what each choice opens. Main Open project action is clear. Screenshot 01.
- Initial branch notice says “new branch” and “main” without explaining that these are saved versions of the project. This requires Git knowledge before the first plain edit. Screenshot 03.
- Picked card prominently shows “<h1>” and “html > body > main > h1” instead of a plain label like “Heading: Hello Gui”. Screenshot 05.
- Selection mode AX exposes instructions (“Click an element…”) but screenshot 04 does not visibly show that guidance. Needs another inspection before treating as confirmed defect.

Account/signup not tested: this is isolated development editor profile with GUI_ACCOUNT_REQUIRED=0.

## Verified outcome
- PASS: Real Claude Code handled “Make the title blue”. “Hello Gui” visibly changed from black to blue (#0066ff). Result showed before/after images, “1 file changed +1 −1”, and Undo. Screenshot 07.
- PASS: Clicked Undo. Preview visibly returned to black; Result showed Undone and Redo. Screenshot 08.
- No agent auth, startup, selection, send, Result, or Undo blocking failure on this path. No source files were inspected or edited by this QA agent.

## Findings for parent implementation triage
1. P2 clarity: picked selection is presented as code (“<h1>” and CSS path). Repro: open project -> Select element -> click headline. Expected plain heading label first; technical selector can remain in details. Screenshot 05.
2. P2 clarity: first-edit safety notice assumes Git vocabulary (“branch”, “main”). Expected concise explanation that edits start in a separate version. Screenshot 03.
3. P3 clarity: welcome has several unexplained choices (“New canvas”, “Clone by URL”, “agents”). Expected brief helper copy or tooltips. Screenshot 01.
4. Candidate visual guidance issue: selection-mode AX had “Click an element / Drag for a screenshot / ⇧ to pick more / Esc when done”, but screenshot 04 shows no visible instruction strip. The flow still worked by following the prior chat instruction; parent should inspect overlay bounds/style. This is not classified as a blocking failure.
5. P3 accessibility: after completion and after Undo, screenshot composer placeholder is “Ask Claude Code…” while fresh full AX still says “Queue a message…”. Parent can check dynamic accessible placeholder updates; no visible-user failure.

## Environment and evidence
All interactions used cua native app API. Exact screenshot bytes saved directly from app.getScreenshot(); no screenshot compositing. App capture worked using canonical Caches app path. This pass does not validate production signup/sign-in or terms acceptance. No new security permissions were granted.
