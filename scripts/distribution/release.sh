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
  "$ROOT/desktop/sentry" --sentry-control=stop
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
    mkdir -p "$HOME/.local/share/sentry/logs"
    setsid "$ROOT/desktop/sentry" --sentry-app >>"$HOME/.local/share/sentry/logs/release-desktop.log" 2>&1 </dev/null &
    echo 'Desktop launch requested. Check Environment for readiness.' ;;
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
