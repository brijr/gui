#!/bin/sh
# Re-runs new or changed e2e specs several times. A full 10× pass on every spec would
# dominate macOS CI; at most two changed files run `--repeat-each=10`.
set -eu
cd "$(dirname "$0")/.."

range() {
  if [ -n "${BASE:-}" ]; then
    echo "${BASE}...HEAD"
    return
  fi
  if [ -n "${BEFORE:-}" ] && [ "$BEFORE" != "0000000000000000000000000000000000000000" ]; then
    echo "${BEFORE}...HEAD"
    return
  fi
  echo "HEAD~1...HEAD"
}

specs=$(git diff --name-only --diff-filter=AM "$(range)" -- 'e2e/*.spec.ts' 'e2e/**/*.spec.ts' |
  grep -v '/fixtures/' |
  head -n 2 || true)

if [ -z "$specs" ]; then
  echo "No changed e2e specs; skipping flake gate."
  exit 0
fi

echo "Flake gate (10×):"
echo "$specs"

bun run build
# playwright.config.ts runs from e2e/; pass paths relative to the repo.
# bun run test:e2e builds again; call playwright on the already-built app.
bunx playwright test --repeat-each=10 $specs
