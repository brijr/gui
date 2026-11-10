# Packaging and releases

Builds from source are yours: they don't ask for a Gui account (you can still sign in from **Settings → Account** to connect GitHub), don't take updates from usegui.com, and never send crash reports. Only releases from `bun run release` do those (`src/main/official-build.ts`).

## Packaging

`CSC_IDENTITY_AUTO_DISCOVERY=false bun run dist` builds an unsigned arm64 `.app`, `.dmg`, and `.zip` (the agent CLIs aren't included; see [Agents](architecture.md)). For a signed, notarized build, put a Developer ID Application certificate in your keychain (or set `CSC_LINK` + `CSC_KEY_PASSWORD`) and one set of notarization credentials (`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, or an App Store Connect API key) before `bun run dist`. `electron-builder.yml` explains each fuse and entitlement. Unsigned builds get a new ad-hoc signature each time, so macOS asks for keychain access on first launch.

## Releases

Before a release, add it to the top of `www/src/changelog.ts` (the site's /changelog): the version the script will release, today's date, and a few plain bullets of what a user would notice. The script stops before building without that entry, and the bullets become the GitHub Release's notes.

`bun run release` publishes a version from main, which must already have everything on `origin/main`. If the version in `package.json` is already tagged, it bumps the last number (`0.1.0-alpha.9` → `0.1.0-alpha.10`) and commits that; to pick a version yourself, commit it first. It runs `bun run check`, builds, checks that the packaged app can load its agent adapters and the main process's modules (`scripts/check-packaged-app.sh`), verifies the signature, notarization and Gatekeeper, notarizes the DMG, uploads the build to the `gui-releases` R2 bucket, reads the feed back from `usegui.com/releases`, tags and pushes `v<version>`, and creates the GitHub Release (a prerelease for an alpha). The setup it needs is at the top of `scripts/release.sh`: a Developer ID certificate, notarization credentials, and Wrangler and `gh` signed in. Afterwards, deploy the site (`cd www && bun run deploy`) so /changelog shows the release.

Official releases check `usegui.com/releases` at launch and every 4 hours, download a new version in the background, and offer to restart into it (**Gui → Check for Updates…** checks now).

An installed copy follows the channel of its own version: `0.1.0-alpha.N` reads `alpha-mac.yml`, a stable version reads `latest-mac.yml`. An alpha release writes only `alpha-mac.yml`. A stable release writes `latest-mac.yml`, `alpha-mac.yml` and `beta-mac.yml`, so copies installed from an alpha update to it and follow stable releases from then on. `usegui.com/download` serves the newest stable DMG (`Gui-arm64.dmg`), and the newest alpha's (`Gui-alpha-arm64.dmg`) until there is one.

## Crash reports

Official releases send crash reports (`src/main/crash-reports.ts`): uncaught errors in main, errors that stop one of Gui's windows drawing, and crashed renderer and helper processes, with home folders removed from paths. They go to `usegui.com/crash`, which keeps them in the `gui-www` D1 database; `bun run --cwd www crashes` lists the last 7 days. **Settings → Account → Send crash reports** turns them off, and builds from source never send them.

## Signing and the runAsNode fuse

Before shipping a signed build, note that the `runAsNode` fuse is on because the agent adapters run on Electron's bundled Node. Any process that can launch the signed app binary with `ELECTRON_RUN_AS_NODE=1` inherits the app's TCC grants. Running the adapters on a separately signed Node binary would allow the fuse to be turned off.
