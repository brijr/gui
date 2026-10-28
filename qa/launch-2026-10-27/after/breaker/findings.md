# Breaker persona — rerun

Result: browser demo first success and local waitlist first success reached. No remaining functional product defect found in the repeated baseline interactions. The minor status-color note found during verification is now resolved.

Browser: fresh Chrome tab at 1280 × 800. IAB was unavailable in the resumed child context, so Chrome was the supported fallback. Target: fixed built site with actual Worker at http://127.0.0.1:4331. Synthetic local-only address qa-breaker@example.invalid; no external email/account.

## Repeated journey and evidence

1. **Healthy — Double-click waitlist opener.** Dialog stays open; the old immediate dismissal is gone. `01-double-click-opener.png`.
2. **Healthy — Junk email.** Repeated HTML payload is rejected by browser validation; no script execution. `02-junk-validation.png`.
3. **Healthy — Back/Forward in waitlist.** Back removes the dialog and keeps the current landing URL. Forward restores the dialog. After success, Back still stays on landing; Forward opens a clean form. `08-back-stays-on-landing.png`.
4. **Healthy — Demo intro and scope.** Landing and demo now disclose the supported changes before a request. Intro says Example playing, composer Send stays disabled, and Try it yourself skips the example. `04-demo-intro-and-limits.png`.
5. **Healthy — Long junk and double Send.** A ~3 KB emoji/HTML payload appears as literal text, one user bubble/reply appears, and the UI explains how to select text and use the supported changes. `05-junk-safe-text.png`.
6. **Healthy — Back/Forward in demo.** Back closes the demo after its transition and stays on the landing. Forward restores a usable demo. No stuck overlay or late intro work observed.
7. **Healthy — Own supported change.** Chose Try it yourself, selected the headline, double-clicked Make this blue. Exactly one change completed, headline is visibly blue, completion reply and Undo are visible. `06-own-blue-success.png`.
8. **Healthy — Valid waitlist double-submit.** Synthetic valid email and double-click Sign up reach one clear confirmation, with Done focused. `07-waitlist-success.png`.

## Harness exclusion

`03-waitlist-double-submit-error.png` captures a temporary local harness failure. Parent confirmed the harness process had stopped on a cancelled throttled response stream, repaired it, restarted, and the identical valid waitlist double-submit succeeded afterward. Exclude this artifact from product regression counts.

## Limits

This proves browser demo and waitlist behavior. It does not prove native installation, production account signup, or the number of DB writes. Pending-close behavior was additionally exercised at http://127.0.0.1:4332 (400 ms latency, 400 kbit/s local throttle). A live Saving status was observed before Close; reopening stayed editable after the former request interval, with no stale success/error.

9. **Healthy — Close while Saving, then reopen.** On the throttled endpoint, submitted the synthetic address, observed Saving your address and disabled Saving button, closed, reopened, and changed platform to Linux. The Sign up button was enabled and the old response did not replace the active form. `09-pending-close-reopen-clean.png`, `10-saving-before-close.png`.

## Minor visual note

Resolved: screenshot10 preserves the old red pending color. The focused follow-up at 1280 × 800 on the throttled endpoint captured Saving your address in neutral gray, computed color rgb(107, 107, 107). Screenshot11 (`11-saving-neutral.png`) visibly confirms the corrected pending state and disabled Saving button. All functional checks remain passed.
