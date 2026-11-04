#!/usr/bin/env bash
# test-lifecycle-shim.sh — shim install, status honesty, and graceful stop
# with fixture HOME (no desktop, no sudo, no network).
# Run: bash scripts/launcher/tests/test-lifecycle-shim.sh   (repo root)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
fail() { echo "LIFECYCLE-FAIL: $1"; exit 1; }
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export HOME="$T"
export TMPDIR="$T/tmp"
mkdir -p "$TMPDIR"
L="$REPO/scripts/launcher/linux"
source "$L/lib/common.sh"
source "$L/lib/config.sh"
source "$L/lib/shim.sh"
source "$L/lib/broker.sh"
source "$L/lib/desktop-ctl.sh"
source "$L/lib/host-gate.sh"
source "$L/lib/node.sh"
source "$L/commands/status.sh"
source "$L/commands/stop.sh"
export REPO_ROOT="$REPO"

# Shim installs as a symlink and reruns idempotently. MSYS git-bash without
# symlink privilege copies instead of linking, so assert intent per platform:
# a real link must point at the repo entry; a copy must match its content.
assert_shim() {
  if [ -L "$T/.local/bin/sentry" ]; then
    [ "$(readlink "$T/.local/bin/sentry")" = "$REPO/sentry" ] || fail "shim target"
  else
    cmp -s "$T/.local/bin/sentry" "$REPO/sentry" || fail "shim copy content"
  fi
}
sentry_install_shim "$REPO" >/dev/null
assert_shim
sentry_install_shim "$REPO" >/dev/null
assert_shim
# Config stores non-secret launcher state only.
sentry_config_set SENTRY_NODE_BINARY "/usr/bin/node"
[ "$(sentry_config_get SENTRY_NODE_BINARY)" = "/usr/bin/node" ] || fail "config round-trip"
if grep -q -i 'key\|token\|secret' "$T/.local/share/sentry/launcher/sentry.conf"; then
  fail "config mentions secrets"
fi
# Status with no runtime and no broker reports stopped (never alive).
out=$(cmd_status) || fail "status exit"
case "$out" in
  *"Runtime     NONE"*) ;;
  *) fail "status runtime: [$out]" ;;
esac
case "$out" in
  *"Running     no"*) ;;
  *) fail "status running: [$out]" ;;
esac
# A stale regular file at the socket path must still report stopped.
sock=$(sentry_broker_socket)
printf 'stale' > "$sock"
out=$(cmd_status) || fail "status exit (stale)"
case "$out" in
  *"Running     no"*) ;;
  *) fail "stale socket reported alive" ;;
esac
rm -f "$sock"
# --json is machine-readable with running:false.
json=$(cmd_status --json) || fail "status json exit"
node -e 'const o = JSON.parse(process.argv[1]); if (o.sentry.running !== false) { process.exit(1); }' -- "$json" || fail "json running field"
# Stop with no desktop exits 0 without touching anything.
out=$(cmd_stop) || fail "stop exit"
case "$out" in
  *"not currently running"*) ;;
  *) fail "stop message: [$out]" ;;
esac
echo LIFECYCLE-OK
