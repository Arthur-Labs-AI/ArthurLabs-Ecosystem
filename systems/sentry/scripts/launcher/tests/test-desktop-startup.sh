#!/usr/bin/env bash
# Exercise immediate Electron failure with real child processes, no desktop.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
T=$(mktemp -d)
fixture_pid=""
trap 'if [ -n "$fixture_pid" ]; then kill "$fixture_pid" 2>/dev/null || true; fi; rm -rf "$T"' EXIT
fail() { echo "STARTUP-FAIL: $1"; exit 1; }
export HOME="$T"
export REPO_ROOT="$T/repo"
mkdir -p "$REPO_ROOT/apps/desktop/dist/main" "$REPO_ROOT/apps/desktop/dist/renderer"
touch "$REPO_ROOT/apps/desktop/dist/main/index.js" "$REPO_ROOT/apps/desktop/dist/renderer/index.html"
source "$REPO/scripts/launcher/linux/commands/open.sh"
sentry_fail() { echo "$*"; }
sentry_config_get() { :; }
sentry_desktop_running() { return 1; }
sentry_electron_binary() { echo "$T/electron"; }
cat > "$T/electron" <<'SCRIPT'
#!/bin/bash
echo 'fixture Electron startup failure' >&2
exit 42
SCRIPT
chmod +x "$T/electron"
if out=$(cmd_open 2>&1); then fail "immediate Electron failure reported success"; fi
case "$out" in *'sentry doctor'*) ;; *) fail "missing recovery instructions" ;; esac
grep -q 'fixture Electron startup failure' "$T"/.local/share/sentry/logs/desktop-*.log || fail "failure log missing"
cat > "$T/electron" <<SCRIPT
#!/bin/bash
echo \$\$ > "$T/pid"
exec sleep 30
SCRIPT
if ! cmd_open > "$T/success.log" 2>&1; then fail "surviving child refused"; fi
fixture_pid=$(cat "$T/pid")
kill -0 "$fixture_pid" || fail "successful launch child absent"
echo STARTUP-OK
