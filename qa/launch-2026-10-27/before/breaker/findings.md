# Breaker persona — baseline

Real browser: independent Codex in-app browser tab, desktop 1280 × 720. Local Astro 4330 initially, actual Worker harness 4331 for valid synthetic waitlist. No real external account or email sent. No source inspection.

## Journey

1. Landing loaded. Double-clicked waitlist opener: dialog appeared then disappeared; a single click opened it reliably. Annoying but recoverable.
2. Pasted `<script>alert(1)</script>` into Email and double-clicked Sign up. Browser rejected invalid email with a clear validation bubble. Healthy. `01-junk-email-validation.png`.
3. Double-clicked Try it now. Only one demo opened. Closed during intro, reopened; animation recovered. Healthy.
4. Tried to paste into the apparently enabled composer during intro. It was not editable until the scripted session ended; no upfront demo instruction explains this waiting period. `02-demo-busy-no-guidance.png`.
5. Pasted ~3 KB repeated emoji and HTML into Message, double-clicked Send. HTML rendered safely as text, only one message/reply appeared. Healthy resilience. `03-long-message.png`.
6. Only after submitting did reply explain: “This demo has no agent, so it can only make the changes in the suggestions.” The input's “Ask Claude Code…” wording had implied arbitrary requests would work. Confusing capability mismatch.
7. Opened Worker harness at 4331, used synthetic qa-breaker@example.invalid and double-clicked Sign up. Exactly one success state shown. `04-waitlist-success.png`. Actual duplicate DB counting is outside browser evidence.
8. Pressed browser Back with waitlist success modal open. Browser left the entire 4331 flow to prior 4330 page instead of dismissing the modal. Forward returned to the landing without restoring modal. `05-back-leaves-flow.png`. This demonstrates missing modal navigation state, not server failure.

## Findings

- **P2 — Demo capability disclosed too late.** Visible “Ask Claude Code…” composer invites arbitrary requests; the limits appear only after failed free-form request. Put the demo/suggestion-only explanation before input. Shared impact likely first-time demo users.
- **P2 — Browser Back abandons the open modal flow.** Add history state/Back handling for demo and signup dialogs so Back closes current flow before leaving site. Baseline screenshot shows prior document, the recorded URL is the decisive evidence.
- **P3 — Waitlist double-click can immediately dismiss dialog.** First click opens centered modal; second click can land on its backdrop. Single click recovers. No duplicate waitlist write observed.
- **P3 — Intro composer looks available but does not accept typing.** Mark the intro and disabled/read-only composer clearly, or let users skip into interactive mode.

## Limits

Native installation/account onboarding is outside this browser demo. Local Astro route404s were excluded because the actual Worker provides those routes. Screenshot03 captures junk prompt while processing, not the later explanatory reply; wording was verified in a fresh DOM snapshot.

9. Double-clicked Make this blue. Exactly one supported change completed: selected words turned blue, agent reply confirms color, Undo is available. Browser demo first success reached. `06-supported-change-success.png`.
