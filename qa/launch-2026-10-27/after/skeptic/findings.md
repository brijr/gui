# Skeptic — after

Target: rebuilt Gui at http://127.0.0.1:4331. Real Chrome, 1280 × 800, used because IAB was unavailable in the rerun. Temporary viewport override reset afterward. No product source inspected, no native account created, no legal agreement accepted.

## Journey and evidence

1. **Healthy:** home page now offers Cost and setup, Privacy, and Terms immediately above the download/demo buttons. It says the demo needs no account and names its supported changes. [Hero](01-hero-links.png).
2. **Improved, residual uncertainty:** Cost and setup opens the right section. It says no payment is collected when downloading the alpha, the agent uses a separate account/plan, and the native Mac app requires a Gui account and agent. It still does not state whether using Gui after signup costs anything, whether there is a trial, or future pricing. [Cost and setup](02-cost-setup.png).
3. **Healthy policy disclosure:** Privacy is readable, dated October 27, and says product emails are optional and off for new accounts. [Privacy](03-privacy.png), [account choice](04-optional-marketing.png).
4. **Healthy policy disclosure:** Terms also says marketing emails are optional and off for new accounts, limited to Gui, and gives the opt-in/opt-out location. This browser run verifies published policy text only; it does not prove service behavior. [Terms](05-terms-optional-email.png).
5. **Healthy:** Try it now clearly says “Browser demo: bold, serif, or blue. No live AI agent.” The automatic run is labeled “Example playing” with a Try it yourself control. I used that control to stop the example. [Disclosure](06-disclosed-example.png).
6. **Recoverable guidance:** I first sent “Make this blue” without selecting text. The demo responded with a specific instruction to select text first. I selected “real app” and then clicked Make this blue. [Guidance](07-selection-guidance.png).
7. **Browser demo success:** “real app” visibly turned blue; the chat showed the change and an Undo button. [Own change](08-personal-success.png).

## Original findings status

| Finding | Result |
| --- | --- |
| SK-1: missing pricing | Partially resolved. Discoverability, download-payment statement, agent cost separation and setup requirements are clear. Native usage price/trial/future pricing remains an owner decision. |
| SK-2: marketing bundled with signup | Published Privacy/Terms now explicitly describe opt-in and off-by-default for new accounts. Actual account default was not browser-tested in this run. |
| SK-3: undisclosed automatic demo | Resolved in browser: simulation, example playback and supported requests are clear, and Try it yourself works. |

## Limits

First success remains a browser demo change, not a native Gui project or freshly created account. No install/sign-in or external email submission was performed. localhost:4331 resolved to an unrelated Photobooz site via a different local listener; that target was rejected, and all accepted evidence comes from explicit 127.0.0.1:4331 Gui. A rapid click on Terms immediately after closing the demo happened during its closing transition and did not navigate; retry after the closed state succeeded.
