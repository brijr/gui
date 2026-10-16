---
name: e2e-motion
description: Wait for Gui preview morphs, chat springs, and layout to settle in Playwright e2e tests. Use when writing or fixing e2e tests that move the chat, resize the preview, change viewports, or assert geometry.
---

# Waiting out motion

Do not use Playwright `waitForTimeout`. Architecture CI rejects it in `e2e/**/*.spec.ts`.

Poll for the state you mean, with `waitFor` from `e2e/helpers/env.ts`. Errors from the check count as "not yet".

**Preview morphs** (viewport, zoom, dock, drawer, focus mode) spring the live view. Unpackaged builds expose `globalThis.guiMorphing` (a `Set` of in-flight ids in `src/main/preview-morph.ts`). Wait until it is empty **and** the layout you care about matches, as `e2e/sidebar.spec.ts` and `e2e/select-bubble.spec.ts` do:

```ts
const now = await session.app.evaluate(() => ({
  morphing: ((globalThis as { guiMorphing?: Set<number> }).guiMorphing?.size ?? 0) > 0,
}))
if (now.morphing) return null
```

**Chat panel springs** (drag, throw, dodge) move the native view in `src/main/panel-flight.ts`. Read bounds from main (`WebContentsView.getBounds()`), not a screenshot, and `waitFor` the corner/gap you expect. See `e2e/panel-motion.spec.ts`.

**Chat page transitions** (send, queue, permission collapse) are view transitions in the chat renderer. Assert the DOM or snapshot, not elapsed milliseconds. See `e2e/chat-motion.spec.ts`.

Fixed `sleep` from `e2e/helpers/env.ts` is only for measuring motion (sampling springs) or capturing a recording for a duration. Prefer `waitFor` everywhere else.

`launch({ reducedMotion: 'reduce' })` disables springs when the test is about the end state, not the path.
