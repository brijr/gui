# Packaging and releases

Builds from source are yours: they don't ask for a Gui account (you can still sign in from **Settings → Account** to connect GitHub), don't take updates from usegui.com, and never send crash reports. Only releases from `bun run release` do those (`src/main/official-build.ts`).

## Packaging

`CSC_IDENTITY_AUTO_DISCOVERY=false bun run dist` builds an unsigned arm64 `.app`, `.dmg`, and `.zip` (the agent CLIs aren't included; see [Agents](architecture.md)). For a signed, notarized build, put a Developer ID Application certificate in your keychain (or set `CSC_LINK` + `CSC_KEY_PASSWORD`) and one set of notarization credentials (`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or an App Store Connect API key) before `bun run dist`. `electron-builder.yml` explains each fuse and entitlement. Unsigned builds get a new ad-hoc signature each time, so macOS asks for keychain access on first launch.

## Releases

`bun run release` publishes a version from main. If the version in `package.json` is already released, it bumps the last number (`0.1.0-alpha.9` → `0.1.0-alpha.10`) and commits that; to pick a version yourself, commit it first. It runs `bun run check`, builds, verifies the signature, notarization and Gatekeeper, notarizes the DMG, uploads the build to the `gui-releases` R2 bucket, and tags and pushes `v<version>`. The setup it needs is at the top of `scripts/release.sh`. Official releases check `usegui.com/releases` at launch and every 4 hours, download a new version in the background, and offer to restart into it (**Gui → Check for Updates…** checks now). A prerelease version publishes to its own channel (`alpha-mac.yml`), and `usegui.com/download` serves the newest alpha DMG.

## Crash reports

Official releases send crash reports (`src/main/crash-reports.ts`): uncaught errors in main, errors that stop one of Gui's windows drawing, and crashed renderer and helper processes, with home folders removed from paths. They go to `usegui.com/crash`, which keeps them in the `gui-www` D1 database; `bun run --cwd www crashes` lists the last 7 days. **Settings → Account → Send crash reports** turns them off, and builds from source never send them.

## Signing and the runAsNode fuse

Before shipping a signed build, note that the `runAsNode` fuse is on because the agent adapters run on Electron's bundled Node. Any process that can launch the signed app binary with `ELECTRON_RUN_AS_NODE=1` inherits the app's TCC grants. Running the adapters on a separately signed Node binary would allow the fuse to be turned off.
