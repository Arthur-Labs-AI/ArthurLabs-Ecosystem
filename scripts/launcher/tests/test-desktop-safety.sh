#!/usr/bin/env bash
# Failed graceful shutdown must block update and setup before mutation.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
L="$REPO/scripts/launcher/linux"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
fail() { echo "DESKTOPSAFETY-FAIL: $1"; exit 1; }
source "$L/lib/desktop-ctl.sh"
source "$L/commands/update.sh"
source "$L/commands/setup.sh"
sentry_desktop_running() { return 0; }
sentry_desktop_stop_graceful() { return 1; }
sentry_seed_node_env() { :; }
sentry_fail() { echo "$*"; }
sentry_require_cachyos() { return 0; }
sentry_product_version() { echo 0.1.0-beta.1; }
sentry_short_sha() { echo old; }
sentry_section() { echo MUTATION >> "$T/mutations"; }
export REPO_ROOT="$REPO"
git() {
  case "$*" in
    *'rev-parse --abbrev-ref HEAD') echo main ;;
    *'rev-parse HEAD') echo old ;;
    *'status --porcelain') : ;;
    *'fetch --prune origin main') : ;;
    *'rev-parse origin/main') echo new ;;
    *'merge-base --is-ancestor'*) : ;;
    *) echo MUTATION >> "$T/mutations"; return 1 ;;
  esac
}
if out=$(sentry_desktop_ensure_stopped "$REPO" 2>&1); then
  fail "failed graceful stop was reported as success"
fi
case "$out" in *'sentry stop'*) ;; *) fail "missing recovery instructions" ;; esac
if out=$(cmd_update 2>&1); then fail "update accepted failed shutdown"; fi
[ ! -e "$T/mutations" ] || fail "update merged or rebuilt after failed stop"
if out=$(cmd_setup 2>&1); then fail "setup accepted failed shutdown"; fi
[ ! -e "$T/mutations" ] || fail "setup continued after failed stop"
# Successful shutdown and the idle path retain their existing semantics.
sentry_desktop_stop_graceful() { return 0; }
sentry_desktop_ensure_stopped "$REPO" >/dev/null || fail "successful stop refused"
sentry_desktop_running() { return 1; }
sentry_desktop_stop_graceful() { fail "idle path attempted stop"; }
sentry_desktop_ensure_stopped "$REPO" || fail "idle path refused"
echo DESKTOPSAFETY-OK
