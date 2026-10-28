# Native launch QA — October 28, 2026

Open `report.html` for the merged ranked list and screenshot galleries. `report.json` contains the structured findings; each persona's `before/` and `after/` folder contains exact native screenshots and its journey notes. The earlier real-browser audit lives in `../launch-2026-10-27/`.

The native target was the repository's `bun run build` output, run by the official installed Electron runtime in five isolated app bundles under `/Users/brijr/Library/Caches/GuiLaunchQA/20261028/`. Each bundle had its own development profile and disposable Git project under `/tmp/gui-native-qa-20261028/`. Real Claude Code edited those projects through Gui's normal UI. Provider authentication already existed on this Mac. The user's installed Gui app and active project were not used.

Editor profiles used the ordinary `GUI_ACCOUNT_REQUIRED=0` development setting. A separate `GUI_ACCOUNT_REQUIRED=1` app displays the real sign-in boundary; production signup has not been completed because accepting Gui's legal terms requires the user's explicit approval. This distinction is intentional in the evidence and must be retained when sharing the report.

The literal, mobile, breaker and skeptic fixtures are small local HTML apps served by Bun. The mobile fixture adds 400 ms response latency and delivers HTML at 50 kB/s. Its live-reload watcher watches the containing directory and filters `index.html`, so Git's replacement of the file during Undo/Redo does not detach the watcher. A first attempt watched the file inode; the breaker notes retain that excluded harness failure. The impatient persona used Gui's actual New project → Website flow instead.

Native processes must survive terminal-session cleanup: the final QA launcher detaches the official runtime, redirects logs to files, and releases its parent. CUA's automatic launch of an unconfigured Electron bundle opens stock Electron, so that is not an acceptable substitute for launching the repository with its project CLI argument.

The website's local Worker harness is `../launch-2026-10-27/harness.ts`. Its memory-only database never sends email. Port 4331 serves the site; port 4332 adds a shared 400 kbit/s + 400 ms server throttle. Use `127.0.0.1`, not `localhost`, to avoid another local IPv6 service. Exact 375px coverage belongs to the real browser run; the native Mac editor's phone preset is 390px.

Validation commands and outcomes are in `verification.txt`. No commit, deployment, release, signing operation, or external message is part of this QA patch. Account-service changes need human review before landing under the repository's AGENTS.md.
