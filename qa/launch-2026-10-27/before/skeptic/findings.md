# Skeptic — before

Browser: real in-app browser, 1280 × 720. Target: local Gui landing page at http://127.0.0.1:4330. No product source inspected. No account created or legal terms accepted.

## Journey

1. Open landing page and search the full visible page for pricing. **Blocked on trust:** no price, free/paid statement, or pricing link. The deep “Bring your own agent” section explains that the agent uses its own plan, but says nothing about Gui’s price. [Screenshot](01-no-pricing.png).
2. Read Privacy from the footer. **Readable and reachable:** explains local project data, agent providers, crash reports and accounts. [Screenshot](02-privacy.png).
3. Read account/email provisions. **Annoyed:** account creation automatically subscribes the user to emails about Gui and other WIP products; opting out requires later app settings or an unsubscribe link. [Screenshot](03-marketing-default.png).
4. Read Terms. **Readable, trust remains blocked:** says a Gui account is required, and repeats the marketing-email agreement. Does not explain Gui’s cost. [Screenshot](04-terms.png).
5. Return home and choose “Try it now.” **Confused:** the demo starts selecting text, typing a prompt and reporting code edits by itself, although the initial instructions ask the user to select an element. Nothing on the entry screen identifies it as a scripted simulation with no live agent. [Entry](05-demo-entry.png), [automatic edit](06-demo-auto.png).
6. Observe the completed example and choose “Make this blue.” **Browser demo success:** the words turn blue and a result with Undo appears. [Example result](07-demo-result.png), [personal change](08-personal-success.png).

## Issues

| ID | Severity | Finding | Reproduction |
| --- | --- | --- | --- |
| SK-1 | High | No Gui pricing or explicit cost statement before download/account commitment | Open landing, inspect every section and footer, then Terms. There is no price or pricing route. |
| SK-2 | Medium | Broad marketing subscription is coupled to account creation | Footer → Privacy → Email; Terms → Emails from us. Both describe marketing about Gui and other WIP products as part of account creation. |
| SK-3 | Medium | “Try it now” runs an undisclosed automated example while asking for user input | Home → Try it now → do nothing. The demo selects “real app,” writes “Make this semi-bold,” and produces an edit result on its own. |

## Limits

First success was a browser demo change, not a newly signed-in native Gui project. Pricing uncertainty would stop this persona before installing or creating an account. Native download/install/auth was not performed; the installed Gui currently contains another active project. Policy text is evidence of the advertised account behavior, not proof of the underlying subscription implementation.
