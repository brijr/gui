# Skeptic — real native baseline

Run: October 28, 2026. Native app `/Users/brijr/Library/Caches/GuiLaunchQA/20261028/Gui QA Skeptic.app`, isolated skeptic profile, ordinary development mode (`GUI_ACCOUNT_REQUIRED=0`). Real Claude Code using the existing provider account, no mocked agent or browser-demo response. Disposable project `/tmp/gui-native-qa-20261028/skeptic-project`, served by Gui at `http://127.0.0.1:5281/`.

All app interaction used CUA accessibility controls. No product source was inspected or edited by this QA persona. The real agent edited the scratch project's file in response to the UI request. The user's active `/Applications/Gui.app` was not touched. No Gui sign-in, account creation, legal acceptance, commit, push, or publication was performed.

## Journey

1. **Healthy launch, trust questions unanswered locally.** Opened the isolated native welcome screen. It explains the core action and displays Claude Code/Codex as Ready. No cost statement or Terms/Privacy links are visible there. [Welcome](01-native-welcome.png).
2. **Clear agent status, missing cost context.** Opened Settings → Agents. It shows “Your install · 2.1.312” and Ready for Claude Code. The screen does not say who bills usage or link to provider prices/policies. [Agents](02-agent-settings-costs-absent.png).
3. **Readable privacy control, policies not linked.** Opened Settings → Account. Signed-out state and crash-report content are clear. Crash reporting is on. No visible Terms/Privacy link or cost information appears beside Sign in. Did not press Sign in. [Account](03-account-settings.png).
4. **Healthy trust prompt.** Chose Open project and selected the disposable skeptic folder. Start App names the project, the exact `npm run dev` command/script, tells the user to trust the project, and says the decision is remembered for this project. [Start App](04-start-app-trust.png).
5. **Healthy project load; approval scope unclear.** Started the app and saw the real Hello Gui page. The chat explains that the first message starts a separate branch. Auto mode is already on; its accessible help only says “Auto mode,” with no visible explanation of which agent permissions it approves. [Ready](05-project-ready-auto-on.png).
6. **Healthy selection.** Used Select element and clicked Hello Gui. The composer shows the selected `<h1>` and its screenshot/path. Typed: “Change only the selected Hello Gui heading text color to teal (#008080). Keep the text, size, spacing, and all other styling unchanged. Verify the result in the preview.” [Selected heading](06-selected-real-heading.png).
7. **Genuine native first success.** Sent the request. Claude Code ran real steps, the preview turned teal, and Result displayed before/after, 1 file changed +1 −1, Follow up and Undo. The app created a separate branch as promised. [Real result](07-real-agent-success.png).
8. **Healthy Undo.** Pressed Undo. The preview returned to black, the result was marked Undone, and Redo appeared. [Undo](08-undo.png).
9. **Healthy Redo.** Pressed Redo. The preview returned to teal and Undo was available again. [Redo](09-redo.png).

## Findings to merge

| ID | Severity | Finding | Evidence / reproduction |
| --- | --- | --- | --- |
| NSK-1 | Medium | Native baseline offers no visible cost/policy context at the first-time decision points | Fresh native welcome → Settings → Agents → Account. No visible Gui pricing, provider billing explanation, Terms link, or Privacy link on these screens. Screenshots 01–03. This does not assert the current website lacks those disclosures. |
| NSK-2 | Medium | Auto mode starts enabled without explaining its permission scope | Open trusted project → inspect composer before first message. Chip reads Auto and its help reads Auto mode. A first-time skeptic cannot tell from that label what actions will be approved. Screenshot 05. |

## Strengths

- The start-command trust prompt is specific and candid about what will execute and how long consent persists.
- Claude Code is reused from the local installation and its version/status are visible.
- Branch creation is explained before the first message.
- Selected-element context, real visual verification, before/after, Undo and Redo all worked on the first genuine edit.

## Limits and launch caveats

- This native baseline predates the latest website/source disclosure changes; owner-confirmed product policy is that Gui is free during alpha and agent usage is paid directly to the provider through the user's own account. The absence finding is confined to the native screens actually observed.
- Ordinary development mode allowed this signed-out local-project flow. Production account-required onboarding, fresh provider authentication, and account creation are separate unproven steps. Legal acceptance remains pending user approval and was not bypassed in the UI.
- Ready agent accounts were already present on this machine. This is genuine native project/agent behavior, but not proof that a new user can install and authenticate every provider.
- The agent reported no console errors. The QA persona independently verified the visible teal result, before/after card, black Undo state, and teal Redo state; it did not independently inspect source or console internals.
- Product code was not modified by this QA persona. No `bun run check` was run for this evidence-only subtask; the parent owns implementation validation.

UI lease returned to the parent after final screenshot capture.
