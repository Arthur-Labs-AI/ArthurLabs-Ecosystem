#!/usr/bin/env bash
# test-setup-phases.sh — setup --list-phases matches the tested decision
# table, so documentation, tests, and the orchestrator cannot drift.
# Run: bash scripts/launcher/tests/test-setup-phases.sh   (repo root)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
fail() { echo "PHASES-FAIL: $1"; exit 1; }
source "$REPO/scripts/launcher/linux/lib/common.sh"
LOGIC_URL="$(sentry_file_url "$REPO/scripts/launcher/launcher-logic.mjs")"
want=$(node -e 'import(process.argv[1]).then((m) => console.log(m.setupPhaseNames().join(String.fromCharCode(10))))' -- "$LOGIC_URL")
got=$(bash "$REPO/sentry" setup --list-phases)
[ "$got" = "$want" ] || fail "phase list drift: got [$got]"
echo PHASES-OK
