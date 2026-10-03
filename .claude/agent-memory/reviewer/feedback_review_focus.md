---
name: grat-review-focus
description: How Grat code reviews should be run — defect-focused, read-only, no style or memoization nits
metadata:
  type: feedback
---

Grat reviews should report real defects, each with a concrete failure scenario, file:line, and a suggested fix, ranked by severity. Do not edit source files. Defects to look for:
- races
- leaked processes, listeners, or timers
- lifecycle bugs: window close, project switch, agent switch mid-turn, dev server restart
- error handling that hides failures
- React effect and stale-state bugs

**Why:** Requested on 2026-10-03. Biome already passes, React Compiler is on, and e2e runs cover the happy path, so style nits and useMemo/useCallback suggestions are noise.

**How to apply:** Skip formatting and naming nits and manual memoization advice. Prioritize edge cases and lifecycle paths that happy-path e2e runs wouldn't exercise. When nothing was run, say explicitly that the findings come from reading the code. Related: [[grat-stack]].
