#!/usr/bin/env bash
# commands/open.sh — launch Sentry Desktop on CachyOS (detached).
# The Desktop itself still boots the runtime through NativeLinuxRuntimeClient;
# `open` only starts the Desktop host. Electron single-instance locking
# prevents duplicates: relaunching focuses the existing window.
set -u

cmd_open() {
  local repo="$REPO_ROOT"
  if [ ! -f "$repo/apps/desktop/dist/main/index.js" ] || [ ! -f "$repo/apps/desktop/dist/renderer/index.html" ]; then
    sentry_fail "Sentry is not built."
    echo "Run: sentry setup"
    return 1
  fi
  local exe="$(sentry_electron_binary "$repo")"
  if [ -z "$exe" ]; then
    sentry_fail "Electron binary not found. Run: sentry setup"
    return 1
  fi
  if ! command -v setsid >/dev/null 2>&1; then
    sentry_fail "setsid is unavailable (util-linux required for detached launch)."
    return 1
  fi
  # Prefer the setup-resolved Node for the Desktop child environment; the
  # Desktop resolver stays fallback-safe when it is absent or stale.
  local configured_node="$(sentry_config_get SENTRY_NODE_BINARY)"
  if [ -n "$configured_node" ] && [ -x "$configured_node" ]; then
    export SENTRY_NODE_BINARY="$configured_node"
  fi
  local logdir="$HOME/.local/share/sentry/logs"
  mkdir -p "$logdir"
  local log="$logdir/desktop-$(date +%Y%m%d).log"
  local already=0
  if sentry_desktop_running; then already=1; fi
  (cd "$repo/apps/desktop" && exec setsid "$exe" . --sentry-app) >>"$log" 2>&1 < /dev/null &
  local launched_pid=$!
  if [ "$already" = "1" ]; then
    echo "Sentry is already running; focusing the existing window."
  else
    # Catch early loader/display failures. Surviving this bounded window
    # proves only process startup; Environment/doctor verify runtime readiness.
    local probe
    for probe in {1..10}; do
      sleep 0.2
      if ! kill -0 "$launched_pid" 2>/dev/null; then
        local launch_status=0
        wait "$launched_pid" || launch_status=$?
        sentry_fail "Sentry exited during startup (exit $launch_status)."
        echo "  Log: $log"
        echo "  Review the log and run: sentry doctor"
        return 1
      fi
    done
    echo "Sentry Desktop process started; check Environment for runtime readiness."
  fi
  echo "  Log: $log"
  return 0
}
