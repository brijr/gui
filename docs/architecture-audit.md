# Architecture audit

## Implemented cleanup

The targeted cleanup below is implemented in the working tree. The original findings
after this section describe the audit baseline at commit `c7efd81`; their line references
and original verification results are historical.

- Account-session errors and GitHub reconnection errors now have distinct codes. Provider
  expiry preserves the Gui login, including compatibility with older clients.
- `ProjectResources` owns project services and provides one idempotent teardown path.
  Final history saves finish before history claims and recordings are retired. Generation
  guards reject late resources from replaced projects.
- Plain proposal/shipping state and window presentation helpers remove runtime import
  cycles. Git operations and secret scanning have focused modules.
- Chat streaming uses revisioned item patches, independent turn subscriptions, and bounded
  snapshot recovery retries. Deferred resets and failed final-update recovery have regressions.
- Source-map fetching, parsing, consumers, and lookups run in a bounded worker. History
  serialization yields in bounded chunks, with worker disk writes and an atomic final rename.
  Normal closure is asynchronous; process shutdown retains a synchronous final-save fallback.
- All request/response IPC handlers are connected to shared argument/result types. Account
  handlers are feature-scoped and use a common error envelope; older handlers retain their
  existing wire shapes during incremental migration. Sender checks precede validation.
- `bun run check` combines typechecks, lint, layer/cycle checks, fast desktop checks, and
  account-service checks. The dependency checker passes across 160 source modules.

Synthetic measurements demonstrate scaling improvements rather than typical UI latency:
streaming a 1 MiB answer in 1 KiB increments transfers about 1.18 MB instead of 537.6 MB.
A roughly 80 MB history benchmark reduced the longest sampled main-loop timer gap from
30.96 ms during synchronous serialization to 3.92 ms during chunked saving; that save took
87.58 ms overall. These measurements do not establish a renderer CPU or memory improvement.

Remaining incremental work: native panel orchestration still occupies much of `ProjectTab`;
the chat controller, account router, and central shared types remain large; transcript rows
are not virtualized. These can be separated as their features change. The current changes
do not replace those modules wholesale.

Current verification: combined checks and production build pass, including 16 fast desktop
tests, standalone transport/store checks, and 25 account-service tests. Selected Electron
checks cover account flows, archives, queues, permissions, source picking in Vite and Next,
shipping, tab ownership/background operation, terminals, motion, and recordings. Two test
assumptions were corrected: an ambiguous email selector and an unclamped drag expectation
outside the window. Their reruns pass. The complete Electron suite was not run.
The final grouped archive, source-picking, panel-grab, and tab-lifecycle run passed all eight
tests after the last production build.

Compiled workers also passed a temporary ASAR probe under Electron 44.5.1: source-map
dependencies load, chunked history writes finish/fsync, and aborted writes remove temporary
files. This validates worker packaging, rather than a full packaged installation test.

## Original audit baseline

Reviewed October 10, 2026. Scope: desktop source, account service, build configuration,
dependency direction, persistence, resource lifecycles, and representative tests. The website
was inspected for project separation and build configuration, but not audited in equal depth.

## Assessment

The overall architecture fits the product. Keep Electron's main/preload/renderer separation,
native preview views, ACP agent integration, and the separate account service. The code is
not indiscriminately abstracted, and several difficult concerns already have focused owners:
PTY output, process groups, viewport emulation, picking, preview tools, and checkpoint storage.

The main weakness is that orchestration has accumulated in a few large controllers. There
are also concrete scaling risks in chat transport and main-process work. One account/GitHub
error-contract bug was reproduced. A targeted cleanup is warranted; a rewrite is not.

Performance findings below describe code paths and expected scaling, not measured UI lag.
Import findings come from a local static import scan, with the reported cycles checked in
source. This is not a complete security audit or an exhaustive dead-code analysis.

## Findings, in priority order

### 1. High: GitHub credential expiry incorrectly invalidates the Gui login

Evidence:

- `accounts/src/worker.ts:190`: `accessToken()` returns HTTP 401 for missing/invalid GitHub
  refresh credentials. The GitHub request helper at line 149 also maps provider 401 to 401.
- `accounts/src/worker.ts:939`: `/repositories` uses that token path after validating the
  Gui account session.
- `src/main/account.ts:131`: every non-`/auth/` 401 with a token calls `forgetSession()`.
- `src/main/github.ts:24`: repository listing uses this shared account client.

Trigger: a signed-in user's GitHub token expires and cannot refresh. Listing repositories
returns 401, and the desktop forgets a Gui account session that the service still accepts.
This confuses two independent authentication domains and can return the user to sign-in.

Verification: an isolated characterization test used the account suite's SQLite/provider
fixtures, signed in, expired GitHub credentials and removed their refresh token, then checked
that `/repositories` returned 401 while `/account` still returned 200 with the same session.
The test passed. Desktop session clearing was verified by tracing the client code; this
specific desktop interaction was not exercised end to end.

Recommendation: distinguish account-session failure from provider reconnection with stable
error codes. Only the former should clear the Gui session. Preserve legacy-client behavior
by using a non-401 status for provider reconnection failures, as the missing-connection path
already does. Add service and client regression coverage.

### 2. Medium: ProjectTab mixes project lifetime, native presentation, and workflows

Evidence: `src/main/tab.ts` has 3,393 lines and imports 43 local modules. `ProjectTab` owns
native views, panel springs, screenshots, recordings, picking, project setup, dev servers,
terminals, chat/history wiring, and shipping/review actions. Compare project setup at line
631, resource teardown at line 883, and full tab disposal at line 3216.

The lifetime rules work through null fields, generation checks, service identity checks,
timers, and separate teardown paths. Those safeguards are useful, but their distribution
makes a new feature require understanding many unrelated states. Project-resource teardown
is repeated in `closeProject()` and `dispose()`, increasing the chance they diverge.

Recommendation: extract a project resource owner containing the dev server, terminals,
chat, recording store, history claim, and MCP server, with one idempotent disposal path.
Separately extract chat-view presentation (dock/float/popout, springs, resize and tuck).
Keep `ProjectTab` as the composition owner of those objects and its native views. Extend
the existing generation checks with explicit ownership; do not replace them with a generic
event bus or a dependency-injection framework.

Acceptance: replacing/closing a project and disposing a tab share the same project cleanup;
late async completions cannot attach resources to a superseded project; tab switching and
background operation continue to pass existing lifecycle tests.

### 3. Medium: Two runtime dependency cycles undermine the intended layering

Verified cycles:

- `src/main/window.ts:15` imports `ProjectTab`; `src/main/tab.ts:129` imports window helpers.
- `src/renderer/src/chat/store.ts:13` imports the ship-sheet component module, which imports
  the proposal component module at line 21; `proposal.tsx:26` imports the chat store.
  The proposal and ship-sheet modules also import each other directly.

These are architectural coupling findings, not evidence that initialization currently
fails. The renderer cycle is particularly awkward because state modules depend on React
component modules that also create other stores.

Recommendation: move shipping and proposal stores/actions into plain `.ts` modules and
compose cross-feature actions above those stores. Components should consume state modules.
For the main process, give the tab the window operations it needs through `TabHost` (which
already exists) or move stateless window helpers into a module that does not import tabs.
Avoid turning every function into an interface solely to break imports.

Acceptance: those import cycles disappear, and state logic can be imported without loading
the associated UI components.

### 4. Medium: Chat streaming cost grows with the full current turn

Evidence:

- `src/main/chat.ts:1846`: streaming updates are batched on a 32 ms timer.
- `src/main/chat.ts:1854`: each flush emits the entire `record.turn`.
- `src/main/tab.ts:705`: the turn listener sends that turn to the chat renderer.
- `src/renderer/src/chat/store.ts:133`: receiving a turn searches and copies the turns array.
- `src/renderer/src/chat/chat-panel.tsx:105` subscribes to the entire turns array; line 753
  mounts all transcript turns, without transcript virtualization.

Batching is already good. Nevertheless, as a response or tool transcript grows, every
flush transfers all prior content in that turn again. The renderer also retains the full
transcript's mounted content. React Compiler can reduce rendering work but cannot eliminate
IPC serialization or the mounted history's memory cost.

Recommendation: retain full snapshots for initial load/reset, then use ordered turn/item
patches for streaming. Include a revision or sequence and a snapshot recovery path. Normalize
the renderer store by turn ID so individual rows can subscribe independently. Profile long
transcripts before adding virtualization, since expanding steps and motion need to keep
working.

Acceptance: synthetic long responses demonstrate bounded update payloads; long tool-heavy
chats preserve scrolling, permissions, and reconnect behavior. Measure IPC bytes, renderer
commit time, and memory, rather than judging this only by visible animation.

### 5. Medium: Heavy parsing and transcript serialization run on the main event loop

Evidence:

- `src/main/source-resolver.ts:400`: source-map JSON parsing and consumer construction run
  in main; lookups at line 435 can also perform synchronous consumer work.
- Source maps have a 32 MiB fetch cap and a 20-entry cache. The cache is bounded by entry
  count rather than retained bytes; decoding and consumer structures add memory beyond JSON.
- `src/main/history.ts:321`: each save walks and stringifies the whole transcript.
- `src/main/chat.ts:153`: active chats schedule saves every 1.5 seconds while updates occur.
- `src/main/history.ts:354`: chat disposal synchronously serializes, writes, and fsyncs history.
- `src/main/prefs.ts:154`: preference changes also use synchronous atomic writes.

Async fetching and file writes do not move JSON parsing/stringification off the main thread.
Large maps or long chats can therefore compete with input handling, native-view motion, and
other tabs. The README already acknowledges the source-map concern.

Recommendation: move source-map parsing/lookups into a worker with bounded work and a
memory budget. Measure transcript serialization first; if material, move it off main or
persist changed records with periodic compact snapshots. Use an async final flush for normal
tab closure, preserving a deliberate shutdown fallback and the current protection against
an older background write overwriting a final save. Small preferences are a lower priority
than maps and transcripts.

Acceptance: profile main-loop stalls while picking from a large map and streaming a long
chat in several tabs. Persistence remains atomic, and interrupted shutdown preserves the
latest successfully saved state.

### 6. Medium: IPC contracts and errors are maintained in several separate places

Evidence: channel constants and `GuiApi` live in `src/shared/ipc.ts` (600 lines), preload
wrappers in `src/preload/index.ts`, and routing/validation in `src/main/index.ts:506`.
Main handlers are not generically tied to the request/result signatures in `GuiApi`.
Some operations throw, some return `{ error }`, some return false, and some silently return
undefined. `reportError()` and `invokeOrThrow()` cover only part of the surface.

Strict TypeScript checks the preload API implementation, which is valuable, but does not
prove that a handler returns the declared payload. Transport/error changes can drift across
these implementations. Runtime sender checks exist and should remain explicit.

Recommendation: introduce a typed request/result map and small registration helpers for
feature-scoped IPC modules. Define one failure convention for new request/response handlers,
then migrate existing handlers gradually. Keep sender authorization and payload validation
at the boundary. Use shared validators where a payload actually crosses multiple boundaries;
there is no need to generate the entire application API or schema-check every internal object.

Acceptance: wrong request/result types fail compilation; invalid inputs and missing tabs
produce predictable failures; tests cover sender roles as well as successful calls.

## Supporting cleanup

- `src/main/ship.ts` combines Git transport, repository inspection, secret scanning, text
  suggestions, and shipping in 1,416 lines. `proposal.ts` imports repository/command helpers
  from it. Extract a focused Git command/repository module first, then secret scanning, while
  keeping shipping as the workflow. This is lower urgency than the findings above.
- `src/main/chat.ts` (2,033 lines) combines conversation state, agent session management,
  permission decisions, queueing, checkpoints, and persistence. Extract the session/policy
  integration after the project resource owner is established; keep the existing turn-slot
  serialization and epoch protections intact.
- The account worker is a single 1,040-line module covering routing, identity, provider
  connections, crypto, and storage. Separate those concerns within the same service as it
  grows. Additional services would add operational complexity without an established need.
- Shared domain types are centralized in a 961-line file imported by 79 desktop modules.
  Split by domain when touching them, keeping shared contracts independent of Electron and
  React. File size alone does not justify a sweeping reorganization.
- Desktop verification is concentrated in 42 Electron end-to-end spec files. Keep the
  valuable coverage, but add a fast test layer for extracted lifecycle, queue, protocol,
  and persistence behavior. Add dependency-cycle and layer-boundary checks. Root scripts
  currently do not aggregate account-service checks, and no repository `.github` CI
  configuration was present; external CI was not inspected.

## What is already clean

- Renderer source does not import main-process source, and shared source does not import
  main or renderer source, in the local relative-import scan.
- Native views are a justified product choice: the preview has no preload, while trusted UI
  gets a constrained bridge. Sandboxing, context isolation, navigation guards, and packaged
  CSP are explicitly configured.
- `TabHost` makes the tab/window ownership contract visible.
- Checkpoints use per-project Git queues and turn slots across tabs, including canonical
  paths. Multiple chats claim distinct history files. These address real concurrency risks.
- Terminal/dev-server output has bounded retention, batching, acknowledgments, and
  backpressure. Preserve this approach when revisiting chat transport.
- History uses atomic owner-only writes and prevents an in-flight older write replacing the
  final synchronous save. Archives have a summary index rather than always loading transcripts.
- Main owns authoritative application state; UI stores primarily hold drafts and presentation
  state. Multiple UI processes follow from the native-view design, rather than arbitrary
  duplication.
- The account service has focused tests for identity, credential encryption, replay,
  repository authorization, migrations, and provider flows.

## Suggested implementation order

1. Fix account/provider error semantics and add regression coverage.
2. Break the two dependency cycles and extract plain renderer stores/actions.
3. Extract the project resource owner and consolidate teardown; run lifecycle tests.
4. Move source-map work off main and profile long-chat transport/persistence.
5. Implement chat patches if the measurements confirm the expected cost; retain snapshots.
6. Introduce typed IPC registration by feature, supported by fast boundary tests.
7. Decompose shipping/chat modules incrementally as those features change.

Use small changes with preserved behavior. There is no evidence here that the app needs a
new framework, microservices, a generic event bus, or a full rewrite.

## Verification performed

| Check | Result |
| --- | --- |
| Desktop `bun run typecheck` | Passed |
| Desktop `bun run build` | Passed |
| Desktop `bun run lint` | Failed on one pre-existing formatting issue in `src/renderer/src/app/sign-in.tsx:50` |
| Account-service `bun run typecheck` | Passed |
| Account-service `bun test` | 20 passed, 0 failed |
| Isolated expired-provider characterization test | Passed; confirmed provider 401 with valid Gui session |
| Multi-project tabs Electron smoke test | 1 passed; preview/chat/server ownership and tab operations exercised |

The full Electron suite, real paid-agent turns, website tests, packaged installation,
production deployment, and performance benchmarks were not run. Source files were left
unchanged; this report is the only repository addition from the audit.
