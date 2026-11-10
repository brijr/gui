#!/bin/sh
# Checks that a packaged Gui.app has every module it loads from node_modules: a dependency that
# didn't reach the package, or a file that `files` in electron-builder.yml left out, stops here
# and not in an agent or the updater on someone's Mac. scripts/release.sh runs it on the built
# app before it uploads anything.
#
#   sh scripts/check-packaged-app.sh release/mac-arm64/Gui.app
#
# Each module is imported with the system's node, never the app's own binary, from a copy of
# the package's node_modules in a temporary folder. Node looks for a module in every
# node_modules above the file that imports it; from release/ that reaches the repo's own, where
# everything is installed and nothing would ever be missing.
set -eu
app=${1:?usage: check-packaged-app.sh <Gui.app>}
packaged="$app/Contents/Resources/app.asar.unpacked/node_modules"
[ -d "$packaged" ] || { echo "$packaged isn't there." >&2; exit 1; }
work=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$work"' EXIT
cp -R "$packaged" "$work/node_modules"
cd "$work"
above=$work
while [ "$above" != / ]; do
  above=$(dirname "$above")
  [ ! -d "$above/node_modules" ] || { echo "$above/node_modules would hide a missing module. Set TMPDIR somewhere else." >&2; exit 1; }
done

# Imports one module the way Gui starts an adapter (src/main/agent.ts), with nobody on stdin.
# An adapter then exits or waits; one still running after a few seconds has loaded. Exit 70
# is ours: the import itself failed.
loads() {
  out=$(env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS -u NODE_PATH \
    perl -e 'alarm 6; exec @ARGV' node --input-type=module \
    -e 'import(process.argv[1]).catch((error) => { console.error(error); process.exit(70) })' \
    "$1" </dev/null 2>&1) && code=0 || code=$?
  [ "$code" != 70 ] && ! echo "$out" | grep -q "ERR_MODULE_NOT_FOUND\|Cannot find module\|Cannot find package"
}

status=0
# The agent adapters (src/main/agents.ts), then what the main process imports itself (the
# packages out/main leaves as imports). electron-updater only needs Electron once it's used.
for module in \
  ./node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js \
  ./node_modules/@agentclientprotocol/codex-acp/dist/index.js \
  ./node_modules/pi-acp/dist/index.js \
  ./node_modules/@bex-co/muse-code-acp/dist/index.js \
  ./node_modules/amp-acp/dist/index.js \
  electron-updater node-pty zod @agentclientprotocol/sdk source-map-js \
  @modelcontextprotocol/sdk/server/mcp.js @modelcontextprotocol/sdk/server/streamableHttp.js; do
  if ! loads "$module"; then
    echo "The packaged app can't load ${module#./node_modules/}:" >&2
    echo "$out" | grep -v '^ *at ' | head -4 | sed 's/^/  /' >&2
    status=1
  fi
done
if [ "$status" = 0 ]; then
  echo "The packaged app loads its agent adapters and the main process's modules."
fi
exit "$status"
