# Skeptic — real native after-fix rerun

Run: October 28, 2026. Actual built native app `/Users/brijr/Library/Caches/GuiLaunchQA/20261028/Gui QA Skeptic.app`, fresh isolated `skeptic-after-profile`, ordinary development mode (`GUI_ACCOUNT_REQUIRED=0`). Existing real Claude Code provider account; no mock agent or demo response. Disposable project `/tmp/gui-native-qa-20261028/skeptic-project`, served by Gui at `http://127.0.0.1:5281/`.

All native interaction used CUA accessibility controls and the native folder picker. PNG files are unmodified native captures. This persona did not inspect or edit product source. Only the real agent edited the scratch project in response to the visible request. The user's active `/Applications/Gui.app` was untouched. No sign-in, account creation, legal acceptance, new OS/security permission, commit, push, or publication occurred.

## Journey and evidence

1. **Healthy welcome.** Opened the fresh native welcome. The main project actions and agent readiness are clear. [Welcome](01-native-welcome.png).
2. **Cost uncertainty resolved in Agents.** Settings → Agents visibly says the AI agent uses my own account and plan through ACP, I pay the provider directly, and Gui adds no AI usage charges. Claude Code is Ready and its local version is shown. [Agents](02-agent-settings-costs.png).
3. **Policies and alpha price resolved in Account.** Settings → Account has a visible Cost and policies section: Gui is free during alpha, the agent uses my account/plan, I pay the provider directly, and Gui adds no AI usage charges. Terms and Privacy Policy links are visible beside this disclosure. Signed-out state and crash-report details are readable. Did not press Sign in. [Account](03-account-cost-and-policies.png).
4. **Healthy trust decision.** Open project → native picker → exact scratch folder. The Start App prompt names `npm run dev`, shows `PORT=5281 QA_SLOW=0 bun server.ts`, advises trusting the project, and explains that the decision is remembered for this project. [Trust prompt](04-start-app-trust.png).
5. **Auto scope explained before sending.** The real teal Hello Gui preview loads. The composer visibly explains that Auto lets the agent edit files and run commands without asking, including commands outside this project, and that turning Auto off reviews more requests. This addresses the original permission-scope confusion before the first message. [Before send](05-project-auto-scope-before-send.png).
6. **Healthy selection and request.** Selected the actual Hello Gui heading. Composer shows Heading Hello Gui. Requested only orange `#b45309`, keeping text, size, spacing, and other styling, with preview verification. [Selected request](06-selected-heading-request.png).
7. **Genuine first success.** Claude Code performed real steps; heading visibly became orange. Result shows teal Before / orange After, 1 file changed +1 −1, Follow up, and Undo. Agent reports computed `rgb(180, 83, 9)` and no console errors. This persona independently verified the visible color/result, not the internal computed style or console. [Result](07-real-agent-result.png).
8. **Healthy Undo.** Undo restored the heading visibly to teal. Result is Undone and Redo is offered. [Undo](08-undo.png).
9. **Healthy Redo.** Redo restored orange and Undo is offered again. No manual preview reload was needed. [Redo](09-redo.png).
10. **Local website agrees.** In an actual Chrome tab, inspected current local `http://127.0.0.1:4331/`: visible Before you start links and Free during alpha disclosure, Cost and setup provider-billing explanation, Terms cost section, and Privacy details. No registration or agreement was submitted. [Website](10-local-site-disclosures.png), [Cost](11-local-site-cost.png), [Terms](12-local-site-terms.png), [Privacy](13-local-site-privacy.png). This is evidence for the current local website; it is not a deployment claim.

## Original findings retest

| ID | After-fix result | Evidence |
| --- | --- | --- |
| NSK-1: Missing native cost/policy context | Resolved at the inspected Settings decision points. Agents explains provider billing; Account states free alpha/no Gui AI charges and exposes Terms/Privacy. | 02–03 |
| NSK-2: Auto permission scope unclear | Resolved. Full permission scope and how to review more requests are visible before the first Send. | 05–06 |

No additional user-visible blocker or confusion was observed in this scoped journey.

## Accessibility observation for parent triage

Saved full native accessibility text alongside Result, Undo, and Redo: [Result AX](07-real-agent-result-ax.txt), [Undo AX](08-undo-ax.txt), [Redo AX](09-redo-ax.txt). At completed Result, this same CUA binding still reported composer placeholder `Queue a message…`, while the native screenshot visibly read `Ask Claude Code…`. After clicking Undo, both AX and screenshot read `Ask Claude Code…`; Redo preserved that agreement. This is an AX/cache observation for an independent fresh-binding comparison, not a new product defect conclusion.

## Limits

- This genuine native editor path uses a fresh Gui profile and an already-authenticated provider account in ordinary development mode. Production account-required onboarding, fresh provider installation/authentication, account creation, and legal acceptance remain unproven by this persona.
- The scratch project retained the baseline branch and teal heading. The rerun is a distinct real edit from teal to orange, then reversible Undo/Redo; it does not claim to start from a new git repository.
- No product code was changed by this persona. Parent owns required `bun run check` and implementation validation; this evidence-only subtask did not run a repository test suite.

UI lease returned to the parent immediately after saving the final Redo screenshot. The same live QA app remains on the orange Result after Redo.
