#!/usr/bin/env bash
# test-config.sh — launcher config is atomic, user-only, and secret-free.
# Fixture HOME only; asserts same-directory temp files, 0600 permissions,
# single-line validation, round-trips, and no secret-shaped content.
# Run: bash scripts/launcher/tests/test-config.sh   (repo root)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
fail() { echo "CONFIG-FAIL: $1"; exit 1; }
source "$REPO/scripts/launcher/linux/lib/config.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export HOME="$T"
CFG_DIR="$T/.local/share/sentry/launcher"
# Round-trip and overwrite semantics.
sentry_config_set SENTRY_NODE_BINARY "/usr/bin/node"
sentry_config_set SENTRY_REPO_PATH "/home/u/Sentry"
[ "$(sentry_config_get SENTRY_NODE_BINARY)" = "/usr/bin/node" ] || fail "round-trip"
sentry_config_set SENTRY_NODE_BINARY "/opt/node/bin/node"
[ "$(sentry_config_get SENTRY_NODE_BINARY)" = "/opt/node/bin/node" ] || fail "overwrite"
[ "$(sentry_config_get SENTRY_MISSING_KEY)" = "" ] || fail "missing key"
# Same-directory temp: no leftovers beside the config itself.
leftovers=$(ls -A "$CFG_DIR" | grep -v '^sentry.conf$' || true)
[ -z "$leftovers" ] || fail "temp leftovers: [$leftovers]"
# User-only permissions on real POSIX hosts (MSYS emulates modes differently).
case "${OSTYPE:-}" in
  msys* | cygwin*) echo "  (permission bits skipped: emulated modes)" ;;
  *)
    [ "$(stat -c '%a' "$CFG_DIR/sentry.conf")" = "600" ] || fail "permissions"
    ;;
esac
# Single-line and quote validation rejects unsafe values.
if sentry_config_set SENTRY_NODE_BINARY "$(printf 'a\nb')" 2>/dev/null; then fail "newline accepted"; fi
if sentry_config_set SENTRY_NODE_BINARY "a'b" 2>/dev/null; then fail "quote accepted"; fi
[ "$(sentry_config_get SENTRY_NODE_BINARY)" = "/opt/node/bin/node" ] || fail "rejected write mutated"
# Stored keys/values never look secret-shaped.
if grep -q -i -E 'key|token|secret|password' "$CFG_DIR/sentry.conf"; then
  fail "secret-shaped content"
fi
echo CONFIG-OK
