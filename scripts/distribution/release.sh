#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
COMMAND="${1:-help}"
if [ $# -gt 0 ]; then shift; fi
case "$COMMAND" in
  help|--help|-h)
    echo 'Sentry pinned distribution: setup | tools | open | stop | status | doctor | version | help'
    echo 'Extract each approved archive into a separate version/SHA directory. update is disabled; see INSTALL.md.'
    exit 0 ;;
  update) echo 'Pinned release: obtain and verify an approved archive, stop Sentry, then run its setup. No development update.' >&2; exit 1 ;;
esac
command -v node >/dev/null || { echo 'Standalone Linux Node >=22 required; see INSTALL.md' >&2; exit 1; }
node "$ROOT/scripts/distribution/verify.mjs" "$ROOT" >/dev/null
if [ "$COMMAND" = version ]; then cat "$ROOT/build-identity.json"; exit 0; fi
. "$ROOT/scripts/launcher/linux/lib/host-gate.sh"
sentry_require_cachyos
[ "$(uname -m)" = x86_64 ] || { echo 'x64 required' >&2; exit 1; }
release_stop() {
  command -v timeout >/dev/null || { echo 'GNU timeout (coreutils) required; maintenance refused. Repair prerequisites and retry stop.' >&2; return 1; }
  local control_status=0
  # GNU timeout creates a separate process group for this short-lived helper.
  # Its deadline/signals never target the existing Desktop/runtime or active QA.
  timeout --kill-after=2s 45s "$ROOT/desktop/sentry" --sentry-control=stop || control_status=$?
  if [ "$control_status" -ne 0 ]; then
    echo "Graceful stop control failed or timed out (exit $control_status); maintenance refused. Cancel active QA, close Sentry and retry stop. No running Desktop/runtime was force-stopped." >&2
    return 1
  fi
  . "$ROOT/scripts/launcher/linux/lib/desktop-ctl.sh"
  local attempt
  for attempt in {1..45}; do
    if ! sentry_desktop_running && node "$ROOT/scripts/distribution/maintenance.mjs" >/dev/null 2>&1; then
      echo 'Sentry stopped.'
      return 0
    fi
    sleep 1
  done
  echo 'Graceful stop did not finish. Cancel active QA and retry; maintenance refused. No processes were killed.' >&2
  return 1
}
case "$COMMAND" in
  setup|repair) release_stop; bash "$ROOT/scripts/distribution/bootstrap-runtime.sh" native ;;
  open)
    [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || { echo 'Use a graphical session' >&2; exit 1; }
    [ -x "$ROOT/desktop/sentry" ] || { echo 'Packaged Desktop executable unavailable; verify/extract the approved archive again.' >&2; exit 1; }
    command -v setsid >/dev/null || { echo 'setsid (util-linux) required for detached launch.' >&2; exit 1; }
    . "$ROOT/scripts/launcher/linux/lib/desktop-ctl.sh"
    mkdir -p "$HOME/.local/share/sentry/logs"
    log="$HOME/.local/share/sentry/logs/release-desktop.log"
    # --wait preserves the exit status even if setsid must fork a new session.
    setsid --wait "$ROOT/desktop/sentry" --sentry-app >>"$log" 2>&1 </dev/null &
    launched_pid=$!
    for probe in {1..10}; do
      sleep 0.2
      if ! kill -0 "$launched_pid" 2>/dev/null; then
        launch_status=0
        wait "$launched_pid" || launch_status=$?
        if [ "$launch_status" = 0 ] && sentry_desktop_running; then
          echo "Desktop launch handed to an existing instance; check Environment for runtime and provider readiness. Log: $log"
          exit 0
        fi
        echo "Sentry exited during startup (exit $launch_status). Log: $log" >&2
        echo 'Review the startup log and run: ./sentry doctor' >&2
        exit 1
      fi
    done
    echo "Desktop process survived initial startup; check Environment for runtime and provider readiness. Log: $log" ;;
  stop) release_stop ;;
  doctor|status)
    cat "$ROOT/build-identity.json"
    echo "Runtime current: $(readlink "$HOME/.local/share/sentry/runtime/current" 2>/dev/null || echo NONE)"
    . "$ROOT/scripts/launcher/linux/lib/broker.sh"
    sentry_broker_probe "$(sentry_broker_socket)" || true
    bash "$ROOT/scripts/launcher/linux/check-systemd.sh"
    bash "$ROOT/scripts/launcher/linux/check-sandbox.sh"
    echo 'Open Environment for matching runtime identity and provider readiness. No paid requests.' ;;
  tools)
    release_stop
    node "$ROOT/scripts/distribution/maintenance.mjs"
    . "$ROOT/scripts/launcher/linux/lib/common.sh"
    . "$ROOT/scripts/launcher/linux/lib/agents.sh"
    sentry_desktop_persist_binary() { "$ROOT/desktop/sentry" --sentry-setup-provider-binary "$2" "$3"; }
    sentry_provision_agents "$ROOT" ;;
  *) echo "Unknown command: $COMMAND" >&2; exit 1 ;;
esac
