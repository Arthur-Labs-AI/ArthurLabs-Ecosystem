#!/usr/bin/env bash
# test-status-pins.sh — status must read agent pins from the current tree,
# never hardcode them (pin updates must not silently go stale).
# Run: bash scripts/launcher/tests/test-status-pins.sh   (repo root)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
fail() { echo "STATUSPINS-FAIL: $1"; exit 1; }
STATUS="$REPO/scripts/launcher/linux/commands/status.sh"
for literal in 1.18.32 2.1.270; do
  if grep -qF "$literal" "$STATUS"; then fail "hardcoded version $literal in status.sh"; fi
done
grep -q 'sentry_logic_pin "$repo" PINNED_OPENCODE_VERSION' "$STATUS" || fail "opencode pin helper missing"
grep -q 'sentry_logic_pin "$repo" PINNED_CLAUDE_CODE_VERSION' "$STATUS" || fail "claude pin helper missing"
echo STATUSPINS-OK
