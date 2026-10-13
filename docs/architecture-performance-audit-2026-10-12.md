# Architecture and performance audit

All seven findings were remediated on October 13, 2026, with regression coverage and
measured results below. The initial audit was performed on October 12.

Reviewed October 12, 2026, at commit `af6ecaa`, including the current working tree.
Scope: Electron desktop architecture and critical runtime paths, the account service,
builds, and representative lifecycle coverage. The static website received a lighter
source/build review. Existing website brand edits were preserved.

The architecture fits Gui: retain the main/preload/renderer boundary, native preview
views, authoritative main-process state, ACP adapters, and the separate account service.
The audit prioritized canvas consistency, chat rendering, and the canvas capture
lifecycle; those paths now have the fixes and coverage below.

The fixes documented at the top of [the earlier audit](architecture-audit.md) are present.
This review confirms revisioned chat patches, independent turn subscriptions, bounded
source-map workers, chunked history saves, typed request handlers, project resource
ownership, and passing dependency checks. Historical findings about full-turn IPC,
main-thread source-map parsing, import cycles, and provider expiry should not be treated
as current defects.

## Remediation and verification

All seven findings have implementation coverage. The existing main/preload/renderer
boundaries and native preview views remain the composition model.

| Finding | Implemented change | Regression coverage |
| --- | --- | --- |
| 1. Canvas consistency | One mutation lane for file, layout, section, watcher and undo operations; coalescing ordered manifest writer; successful writes alone advance the saved marker; awaited disposal and project handoff | Concurrent IDs and the 60-frame limit; older/newer and failed-write interleavings; accepted mutations during close; close/reopen; layout during undo; user undo preserves agent edits |
| 2. Transcript mounting | Measured variable-height transcript window with overscan, active permission rows, scroll anchors and retained disclosure/action state | 300-turn opening, scrolling away and back, disclosures, redo, permission content, desktop/narrow layouts |
| 3. Markdown streaming | Cached settled blocks and bounded unstable tails; shared parser worker; final full-document GFM parse; incremental mounting of dense lists/tables | Incomplete syntax, late references/footnotes, safe links and image handling, replacements/disposal/worker errors, composer input during streaming, single 2,500-row table |
| 4. Canvas captures | Global bounded priority queue; interactive captures ahead of background work; font/image/frame readiness with deadlines; unload and stop painting while idle; shared asset signatures | Cancellation and stale-result suppression; failed navigation cannot become a fresh thumbnail; idle animation/painting; live and reopened CSS changes |
| 5. History paths | Small durable recent summaries; bounded read worker and chunked result transfer; yielding archive snapshots and serialized index mutations; sequential index rebuild | Legacy migration, large strings, special keys, malformed recovery, replacement during read failure, claims/retirement, archive/reopen/remove, overlapping archives |
| 6. GitHub discovery | Four concurrent installation scans; bounded account/provider-scoped discovery hints followed by fresh access checks; coalesced short-lived desktop listings; session/generation-scoped credential leases | Pagination, concurrency cap, revoked/moved installations, account isolation, provider failures, account switch/disconnect during pending credentials, fresh mutation credentials and fallback behavior |
| 7. Controller coupling | Extracted transcript/presentation, board persistence/capture/workflows/IPC, project handoff, history read/summary/transfer and account discovery owners | Runtime layer/import checks and existing lifecycle/workflow coverage |

Cross-review also closed stale credential completion after sign-out, unidentified history
read failures moving a replacement file, layout/section changes racing file-based undo,
and agent edits crossing a user undo boundary.

### Measurements after remediation

Production Electron probes used structured Markdown fixtures. These are local samples;
the before/after streaming inputs differ slightly in size, so they are not a percentage
speedup benchmark.

| Probe | Audit baseline | Remediated build |
| --- | --- | --- |
| 300-turn opening | 15,005 descendants; longest renderer task 347 ms | Peak 5 mounted rows / 361 descendants; no tasks at least 50 ms; largest sampled 20 ms timer gap 46.1 ms |
| 30 streaming updates, nominal 40 ms cadence | 224,640 characters; 20 long tasks; maximum 169 ms | 207,360 characters; no tasks at least 50 ms; sampled timer gap 41.5 ms; composer fill completed in 3 ms |
| Completed dense table | No baseline | One table, 2,500 body rows; no tasks at least 50 ms; sampled timer gap 29 ms |
| Idle animated thumbnail worker | 36 paints / 36 animation ticks in 600 ms | Electron regression confirms about:blank and painting stopped after capture |

The isolated Bun history benchmark uses the same 1,000-turn, 79,959,709-byte data shape.
A recent summary is 136 bytes. Archive/load elapsed time includes worker and transfer
costs; responsiveness is the reason for moving this work off main.

| Operation | Remediated elapsed | Largest sampled 2 ms timer gap |
| --- | --- | --- |
| Durable summary read | 0.21 ms | 2.53 ms |
| Legacy summary migration | 19.55 ms | 3.11 ms |
| Full history load | 103.35 ms | 2.89 ms |
| Archive snapshot | 69.81 ms | 4.99 ms |
| Background final save | 72.57 ms | 2.71 ms |

Desktop/narrow screenshots were inspected. Markdown tables received cell spacing and
borders, and the result row wraps its actions at narrow widths. Verification images:
[desktop transcript](architecture-performance-2026-10-12/transcript-desktop.png),
[narrow transcript](architecture-performance-2026-10-12/transcript-narrow.png), and
[completed narrow Markdown](architecture-performance-2026-10-12/settled-markdown-narrow.png).
The renderer adds a lazy approximately 158 kB parser worker; its chat chunk grows from
approximately 304 kB to 343 kB. Xterm remains in its separate approximately 334 kB chunk.
Oversized or dense unfinished Markdown displays escaped text until final formatting resolves.

### Checks after remediation

| Check | Result |
| --- | --- |
| Desktop, account, and Electron-spec typechecks | Passed |
| Scoped source/test/benchmark/evidence lint | Passed |
| Runtime import/layer checker | Passed across 196 TypeScript modules |
| Fast desktop tests | 83 passed; 1,932 reported assertions, plus isolated probe assertions |
| Chat store and transport checks | Passed; bounded revisioned patch behavior retained |
| Account-service tests | 29 passed; 217 assertions |
| Desktop production build | Passed, including read and Markdown workers |
| Electron suite | 135 enabled tests passed across the full run and focused rerun; 5 intentionally skipped |
| Deterministic canvas interleaving probe | Passed all 10 repetitions after controlled watcher delivery |
| History benchmark | Completed; timings above |
| Desktop/narrow design verification | Three screenshots inspected; table spacing and result-action wrapping corrected |
| Full workspace `bun run check` | Passed with the user's existing website formatting edits preserved |

The full Electron run completed with 133 passes and two geometry tests that sampled a
native resize before it settled. Their fixtures now use reduced motion for static geometry
and poll exact page dimensions; both passed on the focused rerun. Animated handoffs passed
the separate motion specs. The icon harness now explicitly bypasses account sign-in,
matching the shared test fixtures. The isolated Bun canvas test controls watcher delivery;
real file watching remains covered by Electron capture/asset regressions.

The four pre-existing website edits were neither changed nor included in the commits.
The full workspace check includes those edits; a clean checkout retains the pre-existing
website formatting discrepancies. Core source and changed files pass scoped lint.
Paid-agent generation performance, production GitHub/WorkOS latency, packaged startup,
memory-growth stress, and CPU/battery budgets remain outside these measurements.

The original findings and audit-time checks below describe base commit `af6ecaa`.
Their source line numbers are historical references, not current implementation locations.

## Findings in recommended order

### 1. High: canvas mutations and saves can overwrite each other

Sources: [frame creation](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/src/main/board-session.ts#L314),
[manifest saving](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/src/main/board-session.ts#L621),
[IPC dispatch](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/src/main/index.ts#L963).

Frame creation captures the set of occupied IDs before awaiting a directory read.
Concurrent calls with the same name can both allocate the same ID and write the same HTML
file. The frame limit is checked before that await as well. The UI dispatches frame
creation asynchronously, so rapid actions can overlap.

Manifest writes have separate temporary files and atomic renames, but no ordering.
A slow older write can rename after a newer write, leaving older state on disk.
`save()` also sets `written` before the write succeeds. After an error, an unchanged
retry is skipped because that marker already says the state was saved.

Controlled source-level probes, with Electron and the manifest writer replaced by local
fixtures, reproduced all three outcomes:

| Probe | Observed result |
| --- | --- |
| Resolve Newer save, then Older save | Persisted Older; subsequent save performed no correction |
| Reject one manifest write, then retry unchanged state | Zero additional writes |
| Concurrently create two frames named Same | IDs were same and same; two manifest entries, one unique file ID |

These are deterministic interleaving/error characterizations, rather than a claim that
every ordinary rename loses data. Atomic file replacement prevents partial JSON; it does
not establish mutation order.

Recommended fix: give each board a mutation queue or reserve IDs synchronously after
checking current state. Add one coalescing manifest writer with ordered snapshots.
Update the successful-write marker only after completion, and retain dirty state after
failure. Reconcile watcher-originated mutations through the same ownership rules.

Include board persistence in the resource owner's awaited completion:
[ProjectResources currently starts board disposal without awaiting it](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/src/main/project-resources.ts#L102).
Three real Electron immediate-quit probes preserved the pending layout successfully on
this machine; this audit did not reproduce shutdown data loss. Awaiting the board writer
is still needed to make its completion contract explicit.

Acceptance: distinct IDs under overlapping creation; newest acknowledged state wins on
disk; failed writes remain retryable; close/reopen waits for final board persistence.

### 2. Medium: opening a long transcript mounts the entire history

Source: [transcript rows](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/src/renderer/src/chat/chat-panel.tsx#L757).

Individual row subscriptions correctly isolate streaming updates. Initial load still
mounts every turn, including its Markdown and nested content. The long-chat hint at
150 turns does not bound this work.

In the production Electron build, seeded completed turns with approximately 936
characters of structured Markdown each produced:

| History | Mounted transcript descendants | Longest renderer task |
| --- | --- | --- |
| 50 turns | 2,501 | 72 ms |
| 300 turns | 15,005 | 347 ms; 344 ms on a second run |

The measured task includes rendering and associated browser work; it is not an isolated
React commit measurement. Total project-open time includes setup and IPC, so it is not
used here as a transcript-only benchmark.

Recommended fix: virtualize turns with measured heights and a modest overscan window.
Keep the active turn and unanswered permission content available. Preserve scroll
anchoring, expanded disclosures, redo affordances, and the existing transition behavior.
Lazy-mount expensive closed details. CSS content visibility may help layout cost, but
does not remove the initial React/Markdown work.

Acceptance: increasing archived history no longer increases mounted rows without bound,
and reopening 300 turns avoids a single several-hundred-millisecond renderer task.

### 3. Medium: large streamed Markdown reparses the accumulated response

Sources: [Markdown component](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/src/renderer/src/chat/markdown.tsx#L20),
[32 ms publication batching](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/src/main/chat.ts#L2107).

Each changed text value runs through ReactMarkdown and GFM processing again.
Efficient IPC patches and React Compiler do not make that changing input reusable.

The Electron probe injected valid revisioned updates into the real chat renderer,
with 30 append updates at a nominal 40 ms cadence:

| Final response size | Renderer tasks of at least 50 ms | Largest task |
| --- | --- | --- |
| 37,440 ASCII characters | None observed | Below the reporting threshold |
| 224,640 ASCII characters | 20 | 169 ms |

The larger run accumulated 2,153 ms in reported long tasks and finished in 2.69 seconds.
It rendered about 10,087 descendants in the changed turn. This synthetic Markdown uses
many headings and lists; a plain paragraph or code block can behave differently. The
probe isolates the renderer update path and does not measure a real agent's generation
rate or the complete agent/main-process pipeline.

Recommended fix: memoize completed Markdown blocks, reparse the unfinished tail, and
adapt the display cadence to response size. Use a cheap live representation when a
single unstable block becomes very large, then render final Markdown on completion.
Simply delaying a whole-response parse reduces frequency but preserves its worst stall.

Acceptance: a large appended answer stays interactive while links, tables, fenced code,
and incomplete Markdown render correctly.

### 4. Medium: thumbnail capture leaves a live renderer and delays interactive captures

Sources: [capture queue](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/src/main/board-session.ts#L677),
[screenshot queue](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/src/main/board-session.ts#L710),
[offscreen rendering](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/src/main/board-session.ts#L723).

After capture, the cached offscreen window remains loaded with the last frame's page.
It is muted but continues executing that page. A real Electron probe finished eight
animated frame thumbnails in 3.88 seconds, then observed 36 paint events and 36 animation
ticks over 600 ms, with `isPainting()` still true. That demonstrates continuing work at
about 60 frames/second after the thumbnails were complete. CPU percentage and battery
impact were not measured.

Background thumbnails, user exports, and agent screenshots share the same promise chain.
Every render waits a fixed 400 ms after loading. At the supported 60-frame limit,
recapturing all frames therefore adds at least 24 seconds of fixed draw waits, before
navigation and encoding. An interactive screenshot queued behind that work must wait.
This lower bound follows from the source; a 60-frame batch was not benchmarked.

Recommended fix: unload pages when a capture worker becomes idle, with explicit
painting start/stop and cleanup when reused. Prioritize requested screenshots and
visible frames over background thumbnails. Keep concurrency small and globally
bounded across boards; cancellation and version checks should discard obsolete jobs.
Use readiness signals with a deadline rather than an unconditional delay where possible.

Related cache correctness: [watching](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/src/main/board-session.ts#L530)
tracks frame HTML and the manifest, and [reuse on open](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/src/main/board-session.ts#L147)
compares only HTML and thumbnail mtimes. Shared CSS, JavaScript, or image edits can leave
thumbnails stale, including after reopen. This is source-verified, without a separate
asset-change reproduction. Debounced shared-asset invalidation belongs in the capture owner.

Acceptance: idle capture windows have no running frame page; interactive screenshots
can overtake stale background jobs; changing shared assets invalidates affected thumbnails.

### 5. Medium: history summaries and archives bypass the bounded save path

Sources: [recent summary read](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/src/main/history.ts#L115),
[history load](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/src/main/history.ts#L129),
[archive index rebuild](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/src/main/history.ts#L472),
[archive write](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/src/main/history.ts#L525),
[recent fan-out](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/src/main/recent.ts#L37).

Normal HistoryWriter saves yield serialization work and write through a worker.
Archiving still calls synchronous `serializeHistory()` in main before its async disk
write. Loading and recent-message extraction parse the entire JSON in main. The recent
screen can read all 12 recent projects to obtain a single short summary per project;
opening a project also refreshes that list. A missing archive index loads all transcripts
concurrently to reconstruct summaries.

An isolated Bun source-level probe using a 1,000-turn, 79,959,709-byte history measured:

| Operation | Total elapsed | Largest sampled 2 ms timer gap |
| --- | --- | --- |
| lastMessage | 25.30 ms | 10.36 ms |
| loadHistory | 25.70 ms | 11.10 ms |
| archiveChat | 54.88 ms | 25.97 ms |
| Existing worker-backed close benchmark | 73.69 ms | 3.13 ms |

The last row is a separate run of `bun run benchmark:history` with the same data shape.
These are synthetic single-run measurements in Bun, not Electron latency guarantees.
Timer gaps include scheduler noise. They demonstrate the remaining paths and why total
save time and main-loop responsiveness need separate measurement.

Recommended fix: maintain small durable summaries for live chats, use the bounded writer
for archive snapshots, and move large-file parse/settlement off main. Bound archive
rebuild concurrency. Preserve atomic writes, history claims, and conservative retention
when a history file cannot be read.

Acceptance: start-screen work depends on summary size rather than transcript bytes;
archiving a large chat yields to input; a missing index rebuild does not read every large
file at once.

### 6. Medium: GitHub operations repeat serial account-wide repository discovery

Sources: [repository enumeration](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/accounts/src/worker.ts#L261),
[credential authorization](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/accounts/src/worker.ts#L989),
[pull-request authorization](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/accounts/src/worker.ts#L1020).

Repository discovery awaits every installation and its pages serially. Both credential
issuance and pull-request creation repeat the complete discovery before finding one
repository. For 25 installations that each fit in one repository page, that is 26
serial listing requests before the credential or pull-request work. This is a source
calculation; production GitHub latency, rate limits, and account distributions were not
measured. The desktop already caches some read credentials for five minutes, which
reduces polling cost but does not remove the server-side operation path.

Recommended fix: use bounded concurrency across installations, coalesce identical
desktop listing requests, and cache UI listings briefly. Investigate a scoped membership
lookup for mutation authorization while preserving fresh server-side access checks and
the existing revocation tests. UI caches must not become the authorization source.

Acceptance: measured request count and latency scale predictably for accounts with
many installations; disconnected repositories remain unavailable for mutations.

### 7. Low: orchestration remains concentrated in several controllers

Sources: [ProjectTab](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/src/main/tab.ts#L283),
[ChatController](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/src/main/chat.ts#L257),
[IPC registration](https://github.com/brijr/gui/blob/af6ecaa8e529c5f1363a3e4bc4c0d07b2e564330/src/main/index.ts#L632).

ProjectTab is 4,091 lines, ChatController 2,319, index.ts 1,671, and the account worker
1,063. File size is supporting evidence, not a defect by itself. The practical coupling
is that tab lifetime, native panel motion, board workflows, project startup, recording,
and chat integration still share a composition controller. ProjectResources already
provides a useful extraction boundary.

Recommended next boundaries: a native chat-presentation owner, a board capture/workflow
owner, feature-scoped IPC registration, and a separate agent-session/policy integration.
Keep ProjectTab responsible for composition, and retain explicit generation, identity,
and disposal guards. Decompose the account router within its current service when its
routes change. Avoid a broad refactor before the reproduced consistency bugs are covered.

## Verification and measurement limits at audit time

| Check | Result |
| --- | --- |
| bun run check | Passed: desktop/account typechecks, lint, architecture checks, fast tests, transport/store checks |
| Fast desktop tests | 34 passed; 888 assertions |
| Account-service tests | 25 passed; 203 assertions |
| Runtime import/layer checker | Passed across 174 TypeScript modules |
| Desktop production build | Passed |
| Website production build | Passed |
| Existing Electron canvas, archive, and tab specs | 7 passed |
| Electron audit probes | Canvas capture, transcript rendering/large Markdown, and three immediate-quit iterations passed; 4 test executions including the larger Markdown rerun |
| Controlled board interleavings | Reproduced stale overwrite, skipped retry, and duplicate IDs |
| History benchmark and path probes | Completed; results above |

Lint emitted one informational template-literal suggestion in the user's existing brand
script edit; it did not fail. Temporary probes were removed from the test discovery tree.
Application source was not changed during the initial audit. The remediation above was implemented afterward.

The complete Electron suite, paid-agent performance, production GitHub/WorkOS latency,
packaged startup, memory-growth stress, and CPU/battery budgets were not measured.
Website source/build review did not include a full browser performance audit.

The desktop production renderer keeps xterm in a separate approximately 334 kB chunk.
The chat-specific chunk is approximately 304 kB, with shared chunks loaded separately;
these are build sizes, not measured startup or heap usage. Preserve existing lazy loading
while measuring startup and per-tab memory before changing the native-view design.

## Implementation sequence

1. Serialize board mutations and persistence; add the three interleaving/error regressions.
2. Bound mounted transcript rows and large-response Markdown work.
3. Make capture workers idle cleanly and prioritize interactive captures.
4. Introduce live-chat summaries and move archive/load work through bounded paths.
5. Reduce GitHub discovery fan-out and extract controllers as the affected features change.

Measure renderer long tasks, input responsiveness, IPC bytes, per-tab memory, idle CPU,
and main-loop gaps independently. Existing transport checks measured about 1.18 MB of
patches versus 537.60 MB of repeated snapshots for a synthetic 1 MiB streamed response;
that improvement should be retained while addressing the remaining renderer costs.
