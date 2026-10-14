#!/bin/sh
# Builds a signed, notarized Gui and publishes it to the update feed (electron-builder.yml
# `publish`) and https://usegui.com/download. Bump "version" in package.json first; each
# version publishes once, and is tagged v<version>.
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
set -eu
cd "$(dirname "$0")/.."

fail() {
  echo "$1" >&2
  exit 1
}

version=$(node -p 'require("./package.json").version')
tag="v$version"
bucket=gui-releases
case "$version" in
  *-*) channel=$(echo "${version#*-}" | sed 's/\..*//') ;;
  *) channel=latest ;;
esac

[ -z "$(git status --porcelain)" ] || fail "Commit or stash your changes first: a release is built from a commit."
[ "$(git branch --show-current)" = main ] || fail "Release from main."
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  fail "$tag is already released. Bump \"version\" in package.json."
fi

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

echo "Releasing Gui $version ($channel channel)…"
bun run check
rm -rf release
bun run build
# electron-builder signs and notarizes the app; it doesn't publish (that's below).
bunx --bun electron-builder --mac --publish never

app=release/mac-arm64/Gui.app
dmg="release/Gui-$version-arm64.dmg"
zip="release/Gui-$version-arm64.zip"
feed="release/$channel-mac.yml"
for file in "$app" "$dmg" "$zip" "$zip.blockmap" "$feed"; do
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
# usegui.com/download serves this copy.
put "Gui-$channel-arm64.dmg" "$dmg" application/x-apple-diskimage
# Last, so installed copies only see the version once its files are there.
put "$channel-mac.yml" "$feed" text/yaml

git tag -a "$tag" -m "Gui $version"
git push origin "$tag"
echo "Released Gui $version: https://usegui.com/download"
