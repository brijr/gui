# Impatient persona — valid baseline

Date: 2026-10-27. Browser: fresh Chrome tab via Computer Use. In-app browser unavailable to child runtime. Valid target: http://127.0.0.1:4331, built site with the actual download Worker. The earlier Astro-only `/download` 404 is a harness defect and is excluded from product findings.

1. Landing page — renders. Skimmed headline and clicked the first visible call to action, **Download for Mac**. Evidence: `03-valid-landing.png`.
2. Download — succeeds. Browser download event completed to `~/Downloads/Gui (1).dmg`. The landing page remains unchanged. Evidence: `04-download-completed.png` (browser event, rather than screenshot, proves completion).
3. Native install — intentionally not attempted: an unrelated project is open in the installed Gui. This is an audit boundary, not a product failure.

## Findings

- **Minor friction:** No inline confirmation or installation next step after Download for Mac. The browser completes a DMG download while the landing page remains visually unchanged. A skimming user has to know to open the DMG and install it. Suggested copy: Open Gui.dmg, drag Gui to Applications, then open Gui. The download itself works; do not report it as broken.

## Outcome and limits

First browser conversion (download) succeeded. Native first design is unverified. Shared Chrome viewport changed to 375px during capture because the mobile persona was running; these two screenshots show the narrow rendering, not a desktop-only claim. Waiting to run the separate browser-demo journey at desktop width.

Screenshots 01 and 02 are retained as rejected harness evidence and do not support production findings. Screenshots 03 and 04 were captured, saved, and visually inspected.

## Separate browser-demo attempt

4. Clicked **Try it now** — demo opens, with **Point at something to change**, **Click an element on the page, then write the change**, a Select element button, and an Ask Claude Code composer. Evidence: `05-demo-entry.png`.
5. Clicked **Select element** — the example automatically plays a fixed **Make this semi-bold** request and reaches a before/after result for **real app**, without this persona authoring or sending a request. Evidence: `06-demo-result.png`.

- **Confusion, moderate:** The entry copy tells me to select and write a change, but after selecting, the canned example proceeds itself. Try it now does not explain this is a scripted demonstration. A skimmer can mistake the fixed example for a live agent and wait for their own chance to act. Suggested: label the browser demonstration and its fixed example clearly, with a direct action to run it.
- **Positive:** The before/after result is visually legible and offers follow-up suggestions, giving a quick view of Gui's intended benefit.

Browser-demo first success: reached a canned before/after example, not a genuine AI-authored design or native first project. Native installation and signup remain unverified. Screenshots 05 and 06 are also 375px; resetting the viewport did not restore a desktop-size native Chrome window for this agent. Do not count their dimensions as a desktop QA pass.
