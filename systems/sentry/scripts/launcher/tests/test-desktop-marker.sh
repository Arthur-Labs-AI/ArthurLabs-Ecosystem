#!/usr/bin/env bash
# test-desktop-marker.sh — live process-marker recognition (no pgrep mock).
# Starts a harmless process whose argv contains the launcher marker and
# proves sentry_desktop_running() sees it while ignoring unmarked ones.
# Skips cleanly where pgrep is absent; procps parsing is the subject.
# Run: bash scripts/launcher/tests/test-desktop-marker.sh   (repo root)
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
fail() { echo "MARKER-FAIL: $1"; exit 1; }
if ! command -v pgrep >/dev/null 2>&1; then
  echo "MARKER-SKIP: pgrep absent on this host"
  exit 0
fi
source "$REPO/scripts/launcher/linux/lib/desktop-ctl.sh"
# Marker assembled exactly like the helper so neither script matches itself.
MARKER="--sentry-"app
# Harmless long-running fixture: argv[0] carries the marker, sleep waits.
bash -c 'exec -a "sentry-fixture --sentry-app" sleep 120' &
FIXTURE_PID=$!
trap 'kill "$FIXTURE_PID" 2>/dev/null || true' EXIT
sleep 1
if ! kill -0 "$FIXTURE_PID" 2>/dev/null; then fail "fixture did not start"; fi
# An unmarked sleeper must never be reported.
sleep 120 &
PLAIN_PID=$!
trap 'kill "$FIXTURE_PID" "$PLAIN_PID" 2>/dev/null || true' EXIT
PIDS="$(sentry_desktop_pids)"
[ -n "$PIDS" ] || fail "marked process not detected"
case " $PIDS " in
  *" $FIXTURE_PID "*) ;;
  *) fail "fixture pid $FIXTURE_PID not in [$PIDS]" ;;
esac
case " $PIDS " in
  *" $PLAIN_PID "*) fail "unmarked pid $PLAIN_PID reported as Sentry" ;;
esac
if ! sentry_desktop_running; then fail "sentry_desktop_running false"; fi
kill "$FIXTURE_PID" "$PLAIN_PID" 2>/dev/null || true
trap - EXIT
echo MARKER-OK
