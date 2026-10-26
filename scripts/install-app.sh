#!/bin/sh
# Builds Gui and installs it as /Applications/Gui.app, replacing the copy that's there.
# Update to the latest main the same way:  git pull && bun run install-app
set -eu
cd "$(dirname "$0")/.."

# Command Line Tools don't include actool. Use the installed Xcode for this build
# without changing xcode-select globally or overriding an explicit DEVELOPER_DIR.
if [ -z "${DEVELOPER_DIR:-}" ] && ! xcrun --find actool >/dev/null 2>&1; then
  if [ -d /Applications/Xcode.app/Contents/Developer ]; then
    export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  fi
fi
if ! xcrun actool --version >/dev/null 2>&1; then
  echo "Packaging requires Xcode 26+ with a working actool. Set DEVELOPER_DIR to its Contents/Developer directory." >&2
  exit 1
fi

# Without a Developer ID certificate the build gets an ad-hoc signature (electron-builder.yml).
export CSC_IDENTITY_AUTO_DISCOVERY="${CSC_IDENTITY_AUTO_DISCOVERY:-false}"
bun run build
# Ignore electron-builder's Node shebang: its ESM dependencies must not use an older
# Node from the user's shell (for example, a Conda environment).
bunx --bun electron-builder --mac --dir

app=release/mac-arm64/Gui.app
target=/Applications/Gui.app
if [ ! -d "$app" ]; then
  echo "The build didn't produce $app" >&2
  exit 1
fi

# Quitting Gui stops the dev servers and agents it started; it reopens once installed.
reopen=false
if pgrep -xq Gui; then
  reopen=true
  echo "Quitting Gui to replace it…"
  osascript -e 'tell application id "dev.gui.app" to quit' >/dev/null
  waited=0
  while pgrep -xq Gui; do
    if [ "$waited" -ge 60 ]; then
      echo "Gui is still open. Quit it, then run this again." >&2
      exit 1
    fi
    sleep 0.5
    waited=$((waited + 1))
  done
fi

rm -rf "$target"
ditto "$app" "$target"
echo "Installed $target"

# The `gui` command opens a folder in Gui from the terminal. /usr/local/bin is on every
# Mac's PATH; when it needs an administrator, Gui's app menu installs it instead.
link=/usr/local/bin/gui
cli="$target/Contents/Resources/bin/gui"
if [ "$(readlink "$link" 2>/dev/null)" != "$cli" ]; then
  if mkdir -p "$(dirname "$link")" 2>/dev/null && ln -sf "$cli" "$link" 2>/dev/null; then
    echo "Installed the gui command: run gui in a project folder to open it in Gui"
    # Like Gui's menu item: the command comes with the skill that tells agents about it.
    sh "$cli" skill setup || true
  else
    echo "To open folders from the terminal with gui, choose Gui > Install 'gui' Command…"
  fi
elif [ ! -e "$HOME/.agents/skills/open-in-gui" ]; then
  echo "To let your coding agents open projects in Gui, run: gui skill setup"
fi
if [ "$reopen" = true ]; then open "$target"; fi
