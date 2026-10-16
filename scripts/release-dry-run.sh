#!/bin/sh
# Checks release config without publishing. Signs only when CSC_LINK (or a Developer ID
# in the keychain) is present; otherwise exits 0 after validating the files CI can see.
set -eu
cd "$(dirname "$0")/.."

fail() {
  echo "$1" >&2
  exit 1
}

[ -f electron-builder.yml ] || fail "electron-builder.yml is missing."
[ -f scripts/release.sh ] || fail "scripts/release.sh is missing."
bash -n scripts/release.sh || fail "scripts/release.sh does not parse."

node --input-type=module -e '
import { readFileSync } from "node:fs"
const yml = readFileSync("electron-builder.yml", "utf8")
for (const key of ["appId:", "mac:", "publish:", "productName:"]) {
  if (!yml.includes(key)) {
    console.error("electron-builder.yml is missing " + key.slice(0, -1))
    process.exit(1)
  }
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"))
if (!pkg.version) {
  console.error("package.json has no version")
  process.exit(1)
}
console.log("Release config for Gui " + pkg.version + " looks complete.")
'

has_cert=0
if [ -n "${CSC_LINK:-}" ]; then
  has_cert=1
elif command -v security >/dev/null 2>&1 && security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
  has_cert=1
fi

if [ "$has_cert" -eq 0 ]; then
  echo "No signing certificate in this environment; skipping electron-builder."
  echo "Add CSC_LINK (and CSC_KEY_PASSWORD) to GitHub Actions to exercise signing."
  exit 0
fi

echo "Signing credentials present; packing a directory build without publishing."
unset CSC_IDENTITY_AUTO_DISCOVERY
bun run build
bunx --bun electron-builder --mac --dir --publish never
