# Mobile first-time persona — baseline

Run: October 27, 2026. Real in-app browser, viewport 375 × 812.
URL: http://127.0.0.1:4332. Production build through real Worker with memory-only database. Server-side network approximation: shared 400 kbit/s + 400 ms latency. Worker receives iPhone UA; browser remains desktop Chromium, no touch or virtual keyboard emulation.

## Journey
1. Landing rendered in about 6.8 seconds for browser create/navigation call. Text and controls fit; no horizontal overflow. Screenshot 01-landing.png.
2. Tapped Try it now. A scripted example starts selecting, typing, and editing on its own, though initial instruction says to click an element and write a change. Screenshot 02-demo-initial.png is transitional, retained for chronology only; 03-demo-ready.png is accepted stable evidence.
3. After tutorial completed, tapped Make this blue. The selected words turned blue and Undo appeared: first browser-demo success reached. Screenshot 04-blue-change-success.png, reopened from disk.
4. Closed demo and attempted Download for Mac. Local harness redirected to HTTPS localhost and browser produced SSL protocol failure. Excluded from product findings; native/download path cannot be evaluated from this run.

## Findings
- **M1, medium: unannounced automatic tutorial.** Opening Try it now takes over selection and the message field before user input. Same issue seen by other personas; initial copy does not explain the automatic example or simulated agent. Evidence: 03-demo-ready.png.
- **M2, medium: tiny mobile preview.** The375px page shrinks to about192px wide to fit the entire page viewport in the upper panel. Rendered body text is around9px and the selected words are hard to read or tap. Preview is only useful for watching the selected example; picking an arbitrary element is difficult. Evidence: 03-demo-ready.png and04-blue-change-success.png.
- **M3, medium: small touch targets.** The suggested changes and Undo are about28px high, closely stacked. Mobile user can finish, but hitting the desired action is unnecessarily difficult. Evidence: 04-blue-change-success.png.

## Health
Landing: passes fit. Demo opening: confusing. Suggested change: succeeds. Browser back, real phone keyboard, touch precision, actual network packet emulation, native install and account signup: not verified. No live external accounts or emails used. Viewport restored.
