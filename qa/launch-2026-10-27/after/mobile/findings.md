# Mobile persona — rerun

Run: October 27, 2026. Real Chrome fallback: this child turn exposed no IAB browser. A 375 × 812 viewport was confirmed by DOM. URL: http://127.0.0.1:4332. The same server throttle imposed shared 400 kbit/s throughput and 400 ms latency. The Worker received an iPhone user agent; the browser remained desktop Chromium, without touch or virtual keyboard emulation.

## Journey and health

1. **Landing — passes.** Clear Mac app wording and supported demo scope appear before use. Cost/setup, privacy, and terms links are above the actions. No horizontal overflow. Screenshot: 01-landing.png.
2. **Phone download — passes.** Download for Mac redirects to /#mac-only without an SSL error. The visible message says: “Gui is a Mac app. Open usegui.com on your Mac to download it.” Accepted stable screenshot: 07-mobile-download-guidance-stable.png. Screenshot 02 was captured before layout settled and is chronology only.
3. **Demo opening — passes.** Browser demo/no live AI scope is visible. The empty state describes the automated example and Try it yourself. Clicking Try it yourself during the example cleared the selection and allowed an independent selection. Screenshots: 03-demo-example.png and 04-demo-takeover-ready.png.
4. **Own change — passes.** Selected “real app” and clicked Make this blue. The words became blue, rgb(0, 102, 255), and the resulting turn offered Undo. Screenshot: 05-blue-change-success.png, reopened from disk and inspected.
5. **Undo — passes.** Undo restored black text, rgb(16, 22, 30), and became Redo. Screenshot: 06-undo-success.png.
6. **Exit — passes.** Close demo returned to the prior /#mac-only state and phone guidance. The viewport override was reset.

## Baseline issue results

- **M1 resolved:** Demo scope and the automatic example are explained; Try it yourself lets the user take over.
- **M2 resolved:** The preview is 343 px wide at scale 0.914667 instead of about 192 px. Headline and body text are readable. Its 274 px viewport height fits the upper panel and scrolls.
- **M3 resolved:** All three suggestion buttons measure 44 px high. Undo measures 44 px high. Controls fit at 375 × 812 without horizontal overflow.

No remaining launch blocker was found in this mobile browser journey. The chat transcript has its own scroll region; the resulting change and Undo remain visible. Native install/account creation, real phone touch precision, virtual keyboard behavior, and browser-level network emulation remain untested. No external account or email was used.
