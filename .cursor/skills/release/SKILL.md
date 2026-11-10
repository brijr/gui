---
name: release
description: Sign, notarize, and publish a Gui macOS build. Use when cutting a version, debugging Gatekeeper or notarization, or changing electron-builder / scripts/release.sh.
---

# Release Gui

Do not publish from an agent session. Do not put certificates or notary passwords in the repo.

1. Each version publishes once, tagged `v<version>`. If `package.json`'s version is already tagged, the script bumps the last number and commits it (`chore: release <version> [skip ci]`); commit a version yourself to pick a different one. The bump commit and tag are pushed after the upload. An installed copy reads the feed of its own version's channel. An alpha (`0.1.0-alpha.N`) writes only `alpha-mac.yml`; a stable version writes `latest-mac.yml` and also `alpha-mac.yml` and `beta-mac.yml` (`generateUpdatesFilesForAllChannels`), so copies installed from an alpha update to it. A prerelease named anything else (`rc`) gets only its own feed, and no later release reaches it.
2. Work on **main**, with a clean tree except `www/` (the site is not packaged). The script fetches first and stops if `origin/main` has commits the local main lacks, because it ends by pushing main and the tag.
3. Needs, once per Mac:
   - Developer ID Application in the login keychain (Xcode → Settings → Accounts → Manage Certificates), or `CSC_LINK` + `CSC_KEY_PASSWORD` (and `CSC_NAME` if several identities).
   - Notarization: keychain profile `gui-notary` (`xcrun notarytool store-credentials`), **or** `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER`, **or** `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`.
   - Wrangler logged into the Cloudflare account that owns the `gui-releases` R2 bucket (`cd www && bunx wrangler login`).
   - `gh` signed in to GitHub (`gh auth login`), for the GitHub Release.
4. Xcode 26+ `actool` compiles `build/icon.icon`. If Command Line Tools are selected, `scripts/release.sh` sets `DEVELOPER_DIR` to `/Applications/Xcode.app/Contents/Developer`.
5. Run `bun run release` (`scripts/release.sh`). It runs `bun run check`, builds, then `electron-builder --mac --publish never`.
6. `CSC_IDENTITY_AUTO_DISCOVERY` must stay unset for a signed build. Unsigned/ad-hoc builds (`CSC_IDENTITY_AUTO_DISCOVERY=false bun run dist`) get a new signature each time; macOS then re-prompts for the keychain item and the preview stays blank until that is answered.
7. After the build: `scripts/check-packaged-app.sh` imports each agent adapter and each module the main process imports from the packaged `node_modules` (add a new adapter or main-process dependency to its list), `codesign --verify --deep --strict` on `Gui.app`, staple the DMG, confirm `release/$channel-mac.yml` exists. The script refuses to publish if any of that fails.
8. Uploads: the zip first. Then the blockmap and the DMG, as `Gui-<version>-arm64.dmg` and `Gui-<channel>-arm64.dmg`; a stable release also as `Gui-arm64.dmg`, which `usegui.com/download` serves in place of the alpha's once it exists. Every `release/*-mac.yml` goes last and is read back from the site before anything is tagged.
9. Before running it, add the release to the top of `www/src/changelog.ts` (the site's /changelog): the version the script will release, today's date, and a few plain bullets of what a user would notice. The script stops before building if that entry is missing, and after pushing the tag it creates a GitHub Release with those bullets as its notes (`--prerelease` for alphas). Deploy the site (`cd www && bun run deploy`) so /changelog shows it.
10. CI `release-dry-run` only packs when `CSC_LINK` is set; without secrets it checks `electron-builder.yml` and that `scripts/release.sh` parses.

Human review before changing this path.
