#!/bin/sh
# Builds a signed, notarized Gui and publishes it to the update feed (electron-builder.yml
# `publish`) and https://usegui.com/download. Each version publishes once, tagged v<version>,
# with a GitHub Release whose notes are its entry in www/src/changelog.ts (add that first).
# If package.json's version is already tagged, this bumps it (0.1.0-alpha.9 → 0.1.0-alpha.10,
# 1.2.3 → 1.2.4) and commits that; to pick a version yourself, commit it first.
#
# Needs, once per Mac:
#   - A "Developer ID Application" certificate in the login keychain (Xcode → Settings →
#     Accounts → Manage Certificates → + → Developer ID Application).
#   - Notarization credentials. By default a keychain profile named gui-notary:
#       xcrun notarytool store-credentials gui-notary --apple-id <you> --team-id <TEAMID>
#     (or set APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER, or APPLE_ID/
#     APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID, as electron-builder.yml describes).
#   - Wrangler signed in to the Cloudflare account with the gui-releases R2 bucket
#     (cd www && bunx wrangler login).
#   - gh signed in to GitHub (gh auth login), for the GitHub Release.
set -eu
cd "$(dirname "$0")/.."

fail() {
  echo "$1" >&2
  exit 1
}

bucket=gui-releases

# The site (www/) isn't part of the app, so work on it can be in progress.
[ -z "$(git status --porcelain -- . ':!www')" ] || fail "Commit or stash your changes first: a release is built from a commit."
[ "$(git branch --show-current)" = main ] || fail "Release from main."
# The last steps push main and the tag. Find out now whether GitHub would refuse that push,
# not after the feed is live.
git fetch -q origin main || fail "Couldn't fetch main from origin."
git merge-base --is-ancestor FETCH_HEAD main ||
  fail "origin/main has commits your main doesn't. Pull them first: a release pushes main."

if [ -z "${DEVELOPER_DIR:-}" ] && ! xcrun --find actool >/dev/null 2>&1; then
  if [ -d /Applications/Xcode.app/Contents/Developer ]; then
    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  fi
fi
xcrun actool --version >/dev/null 2>&1 || fail "Packaging requires Xcode 26+. Set DEVELOPER_DIR to its Contents/Developer directory."

if [ -z "${CSC_LINK:-}" ] && ! security find-identity -v -p codesigning | grep -q "Developer ID Application"; then
  fail "No Developer ID Application certificate in the keychain. See the top of this script."
fi
unset CSC_IDENTITY_AUTO_DISCOVERY

# notarytool arguments for the DMG, from the same credentials electron-builder uses.
if [ -n "${APPLE_API_KEY:-}" ]; then
  notary="--key $APPLE_API_KEY --key-id ${APPLE_API_KEY_ID:?} --issuer ${APPLE_API_ISSUER:?}"
elif [ -n "${APPLE_ID:-}" ]; then
  notary="--apple-id $APPLE_ID --password ${APPLE_APP_SPECIFIC_PASSWORD:?} --team-id ${APPLE_TEAM_ID:?}"
else
  export APPLE_KEYCHAIN_PROFILE="${APPLE_KEYCHAIN_PROFILE:-gui-notary}"
  notary="--keychain-profile $APPLE_KEYCHAIN_PROFILE"
  # shellcheck disable=SC2086
  xcrun notarytool history $notary >/dev/null 2>&1 ||
    fail "Notarization profile $APPLE_KEYCHAIN_PROFILE doesn't work. See the top of this script."
fi
(cd www && bunx wrangler r2 bucket info "$bucket" >/dev/null 2>&1) ||
  fail "Wrangler can't reach the $bucket R2 bucket. Run: cd www && bunx wrangler login"
gh auth status >/dev/null 2>&1 || fail "gh isn't signed in to GitHub. Run: gh auth login"

version=$(node -p 'require("./package.json").version')
next=$version
if git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
  # Bump the last number: 0.1.0-alpha.9 → 0.1.0-alpha.10, 1.2.3 → 1.2.4.
  next=$(echo "$version" | awk -F. -v OFS=. '{ $NF = $NF + 1; print }')
  git rev-parse -q --verify "refs/tags/v$next" >/dev/null && fail "v$next is already tagged too."
fi
# This version's /changelog bullets, which are also its GitHub Release notes.
notes=$(V=$next bun -e 'const { releases } = await import("./www/src/changelog.ts")
const r = releases.find((r) => r.version === process.env.V)
if (r) console.log(r.changes.map((c) => "- " + c).join("\n"))')
[ -n "$notes" ] || fail "Add $next to the top of www/src/changelog.ts first: the date and what a user would notice."
if [ "$next" != "$version" ]; then
  sed -i '' "s/\"version\": \"$version\"/\"version\": \"$next\"/" package.json
  [ "$(node -p 'require("./package.json").version')" = "$next" ] || fail "Couldn't bump package.json to $next."
  git commit -q -m "chore: release $next [skip ci]" -- package.json
  version=$next
fi
tag="v$version"
case "$version" in
  *-*) channel=$(echo "${version#*-}" | sed 's/\..*//') ;;
  *) channel=latest ;;
esac

echo "Releasing Gui $version ($channel channel)…"
bun run check
rm -rf release
# Official: asks for a Gui account, takes updates and sends crash reports (official-build.ts).
GUI_OFFICIAL_BUILD=1 bun run build
# electron-builder signs and notarizes the app; it doesn't publish (that's below).
bunx --bun electron-builder --mac --publish never

app=release/mac-arm64/Gui.app
dmg="release/Gui-$version-arm64.dmg"
zip="release/Gui-$version-arm64.zip"
for file in "$app" "$dmg" "$zip" "$zip.blockmap" "release/$channel-mac.yml"; do
  [ -e "$file" ] || fail "The build didn't produce $file"
done

codesign --verify --deep --strict "$app" || fail "Gui.app's signature doesn't verify."
xcrun stapler validate "$app" >/dev/null || fail "Gui.app isn't notarized. Check the notarization credentials."
spctl --assess --type execute "$app" || fail "Gatekeeper rejects Gui.app."

# The DMG is what people download, so Gatekeeper checks it too. The feed's DMG checksum goes
# stale once the ticket is stapled; updates only use the zip.
echo "Notarizing the DMG…"
# shellcheck disable=SC2086
xcrun notarytool submit "$dmg" $notary --wait
xcrun stapler staple "$dmg"
spctl --assess --type open --context context:primary-signature "$dmg" || fail "Gatekeeper rejects the DMG."

put() {
  (cd www && bunx wrangler r2 object put "$bucket/$1" --file "../$2" --content-type "$3" --remote)
}
put "$(basename "$zip")" "$zip" application/zip
put "$(basename "$zip").blockmap" "$zip.blockmap" application/octet-stream
put "$(basename "$dmg")" "$dmg" application/x-apple-diskimage
# usegui.com/download serves Gui-arm64.dmg, the newest stable release, and the alpha's copy
# until there is one. A prerelease replaces only its own channel's copy.
put "Gui-$channel-arm64.dmg" "$dmg" application/x-apple-diskimage
if [ "$channel" = latest ]; then
  put "Gui-arm64.dmg" "$dmg" application/x-apple-diskimage
fi
# Last, so installed copies only see the version once its files are there. An alpha build
# writes one feed; a stable one also writes alpha-mac.yml and beta-mac.yml, which is how
# copies installed from a prerelease reach it (generateUpdatesFilesForAllChannels).
for feed in release/*-mac.yml; do
  put "$(basename "$feed")" "$feed" text/yaml
done
# Read each feed back the way an installed copy does, before anything is tagged.
for feed in release/*-mac.yml; do
  curl -fsS --max-time 60 "$site/$(basename "$feed")" | grep -qxF "version: $version" ||
    fail "$site/$(basename "$feed") doesn't name $version after the upload. The files are in the bucket; nothing is tagged or pushed. Find out why before running this again."
done

git tag -a "$tag" -m "Gui $version"
git push origin main "$tag"
prerelease=
[ "$channel" = latest ] || prerelease=--prerelease
# shellcheck disable=SC2086
gh release create "$tag" --verify-tag --title "Gui $version" --notes "$notes" $prerelease
echo "Released Gui $version: https://usegui.com/download"
