#!/usr/bin/env bash
# test-package-map-sync.sh — the bash pacman adapter and the tested
# launcher-logic.mjs decision table must agree (single source, two forms).
# Run: bash scripts/launcher/tests/test-package-map-sync.sh   (repo root)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
fail() { echo "MAPSYNC-FAIL: $1"; exit 1; }
source "$REPO/scripts/launcher/linux/lib/common.sh"
LOGIC_URL="$(sentry_file_url "$REPO/scripts/launcher/launcher-logic.mjs")"
. "$REPO/scripts/launcher/linux/distros/cachyos.sh"
for exe in git curl ca-certificates node npm bwrap socat; do
  bash_pkg=$(sentry_cachyos_package_for "$exe") || fail "bash map missing $exe"
  node_pkg=$(node -e 'import(process.argv[1]).then((m) => console.log(m.CACHYOS_PACKAGES[process.argv[2]] ?? ""))' -- "$LOGIC_URL" "$exe")
  [ "$bash_pkg" = "$node_pkg" ] || fail "$exe: bash [$bash_pkg] != logic [$node_pkg]"
done
if sentry_cachyos_package_for nope 2>/dev/null; then fail "unknown accepted"; fi
echo MAPSYNC-OK
