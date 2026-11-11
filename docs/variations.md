# Variations

Pick an element (⌘D) and ask for options: "show me 15 ways to make this better". The agent writes each version as real code in your project, behind a small switch Gui controls, and a bar floats in the preview's bottom-left corner: **3 of 15 · Tighter hierarchy**, with ‹ › to flip, **Use this**, and ×. ← and → flip too while the bar has the keyboard; in the page they stay the page's. The page is your app, so each version is styled by your own CSS and design system, and hover and state work.

Code: `src/main/variations.ts` (the set), `src/main/picker.ts` and `src/renderer/src/pick/overlay.tsx` (the bar), `preview_variations` in `src/main/mcp-preview-tools.ts`.

## The bar and the page

The bar stays in the corner while the page scrolls under it, 12px in from the preview's edges, as the floating chat sits in its corner. The preview is the page Gui shows: the canvas on Desktop, the page inside a device frame, never the docked chat beside it. When the floating chat (panel, pill or bubble) is in the bottom-left corner, the bar sits just right of it, 12px away, and moves with it; the bar's name shortens first when there's little room. While only the bar shows, its overlay is only as big as the bar, so the rest of the page takes the pointer as usual.

When a set first shows, and after each flip (‹ ›, the keys, or the agent's `show`), Gui waits briefly for the version to render and scrolls the page to its element, unless it's already in full view. It centers it, which keeps it clear of the bar at the bottom; a version taller than the page scrolls to its top, and one that already fills the page stays put. The scroll is smooth unless the page prefers reduced motion, and never moves the focus.

## The switch

Gui decides which version shows; the agent's switch follows. For a set with id `<set>`:

- **Storage.** Gui writes `localStorage['gui:variation:<set>'] = '<variant id>'` in the preview's page. The switch reads it on every render. A missing or unknown value means `original`, so outside Gui the app looks as it did.
- **Event.** Gui then dispatches `new CustomEvent('gui:variation', { detail: { set, variant } })` on `window`. The switch renders again when it hears one.
- **Element.** The root element of whichever version renders carries `data-gui-variation="<set>"` and `data-gui-variant="<variant id>"`. Gui finds the element by the first, to scroll it into view, and checks the second to tell the agent whether the switch worked.
- **Ids.** Set and version ids are lowercase letters, digits and dashes (up to 40). `original` is always a version: the code as it was, first in the list, so ‹ › compare against it.

Gui runs this in the page's main world over the debugger session (`Runtime.evaluate`), as the inspector and preview tools do, with ids it has validated. Storage keeps the choice through hot reloads and full reloads.

In React the switch is one hook:

```tsx
const key = 'gui:variation:hero'
const subscribe = (changed: () => void) => {
  addEventListener('gui:variation', changed)
  return () => removeEventListener('gui:variation', changed)
}
const variant = useSyncExternalStore(subscribe, () => localStorage.getItem(key) ?? 'original', () => 'original')
```

## The tool

`preview_variations`, called once the versions are written and build:

| Field | | |
| --- | --- | --- |
| `set` | string | the set's id, such as `hero` |
| `variants` | `{ id, name }[]`, 1–15 | the new versions in order, without `original`; `name` is short ("Tighter hierarchy", up to 40 characters) |
| `show` | string, optional | the version to show; by default the first |

Gui flips the page to `show`, waits up to 3 s for the element to say it's showing it, and only then shows the bar (it never names a version the page isn't showing) and scrolls it into view (the tool returns once the scroll ends, so a screenshot after it sees the page at rest). The result says which version is up, or why not: nothing matches `[data-gui-variation="<set>"]`, or it shows another version. The agent calls it again with each `show` and takes a `preview_screenshot` to check every version renders. Its description says to keep a set in as few files as possible, so it's easy to remove.

The set belongs to the project opening and to the message (turn) that first showed it. Calling the tool again with the same set id, even in a later message, keeps that first message.

## Use this and discard

- **Use this** sends a message, as the canvas's starter prompts do: keep that version as the real code, and remove the other versions and the switch. It's a normal message, with before and after and Undo. The bar goes; the page keeps showing the chosen version while the agent works.
- **× or Esc** (with the bar focused) discards the set: it undoes the message that made it, with the chat's own Undo (`ChatController.restoreTurn`). When later messages changed files too, the bar asks first, as Undo to here does: "Undo this and 2 later messages? You can redo." Once that message is marked undone the bar goes and Gui forgets the stored choice. Redo in the chat brings the code back, but not the bar.

The set also goes when its message is undone from the chat, on a new chat, and when the project closes or another opens.

## When things go wrong

- **One broken version breaks the build.** The versions share a build, so the dev server's error shows for all of them, above the composer and in `preview_console`. The tool's check times out and says the page isn't showing the version; the agent fixes it and calls again. Discard still undoes everything.
- **The agent ignores the contract.** If nothing carries the set's attribute, or the page doesn't switch to the version asked for, no bar shows and the tool tells the agent what to fix; the user sees the page as it is, with the message's Undo.
- **The element disappears** (another page, a version that renders nothing). The bar stays in its corner; a flip finds nothing to scroll to and leaves the page where it is.
- **You edit files mid-set.** Discard uses Undo's checks: when a file it would restore changed outside Gui, it asks before overwriting it ("Overwrite changes made outside Gui?"); Cancel leaves the code alone. If Gui's saved versions are missing, or the agent is still working, the bar says so and nothing changes.
- **You switch tabs.** The bar is the tab's, like its preview: it goes with the tab and comes back with it. The agent's work in a background tab carries on.

## Next steps

- A grid of all the versions at once, to compare them side by side.
- Keeping a set across app restarts (it lives with the project opening today; the code and Undo survive, the bar doesn't).
