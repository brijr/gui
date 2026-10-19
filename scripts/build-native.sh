#!/bin/sh
# Builds Gui's native helpers into native/.build/. Packaged as Contents/Resources/bin/ by
# electron-builder (extraResources) and signed with the app.
#   gui-transcribe: on-device speech transcription for narrated recordings (src/main/transcribe.ts)
set -e
cd "$(dirname "$0")/.."
out=native/.build
src=native/transcribe/main.swift
bin=$out/gui-transcribe
if [ "$(uname)" != "Darwin" ] || ! command -v swiftc >/dev/null 2>&1; then
  echo "build-native: no swiftc here; narrated recordings won't be transcribed." >&2
  exit 0
fi
mkdir -p "$out"
# Up to date: nothing to do (dev runs this on every start).
if [ -x "$bin" ] && [ "$bin" -nt "$src" ]; then exit 0; fi
# Runs on macOS 13 (Gui's minimum) and reports there that it needs macOS 26.
swiftc -O -parse-as-library -target arm64-apple-macos13.0 "$src" -o "$bin"
