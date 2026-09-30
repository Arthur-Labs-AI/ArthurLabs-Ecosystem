#!/usr/bin/env bash
# lib/desktop-ctl.sh — Sentry Desktop process recognition and graceful control.
# Never broad-kills: processes match only the launcher's --sentry-app marker,
# and shutdown always goes through Electron's --sentry-control=stop path.
set -u

# Resolve the native Electron binary (empty when not built).
sentry_electron_binary() {
  local repo="$1"
  local exe="$repo/apps/desktop/node_modules/electron/dist/electron"
  if [ -x "$exe" ]; then printf '%s\n' "$exe"; fi
  return 0
}

# PIDs of Sentry Desktop processes (launcher marker only). Empty when idle.
# The pattern is assembled so this script never matches its own command line.
sentry_desktop_pids() {
  if ! command -v pgrep >/dev/null 2>&1; then return 0; fi
  local marker="--sentry-"app
  pgrep -f "$marker" 2>/dev/null || true
  return 0
}

sentry_desktop_running() {
  [ -n "$(sentry_desktop_pids)" ]
}

# Graceful stop through the running instance (second-instance control).
# Returns 0 once no marker processes remain, 1 otherwise (never kills).
sentry_desktop_stop_graceful() {
  local repo="$1"
  local timeout_s="${2:-45}"
  if ! sentry_desktop_running; then
    echo "Sentry is not currently running."
    return 0
  fi
  local exe="$(sentry_electron_binary "$repo")"
  if [ -z "$exe" ]; then
    echo "  [X] Electron binary not found; cannot send a graceful stop."
    return 1
  fi
  (cd "$repo/apps/desktop" && "$exe" . --sentry-control=stop >/dev/null 2>&1 &)
  local waited=0
  while [ "$waited" -lt "$timeout_s" ]; do
    if ! sentry_desktop_running; then
      echo "Sentry stopped."
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  echo "  [!] Sentry did not exit promptly; its window may need closing manually. No other apps were touched."
  return 1
}

# Best-effort stop before setup phases (warns, never fails setup itself).
sentry_desktop_ensure_stopped() {
  local repo="$1"
  if ! sentry_desktop_running; then return 0; fi
  echo "  Stopping the running Sentry instance..."
  sentry_desktop_stop_graceful "$repo" 45 || true
  return 0
}

# Persist a non-secret provider binary path through Desktop (warn-continue).
sentry_desktop_persist_binary() {
  local repo="$1"
  local key="$2"
  local path="$3"
  local exe="$(sentry_electron_binary "$repo")"
  if [ -z "$exe" ]; then
    echo "  [!] Electron binary not found; cannot persist $key."
    return 1
  fi
  if (cd "$repo/apps/desktop" && timeout 120 "$exe" . --sentry-setup-provider-binary "$key" "$path" >/dev/null 2>&1); then
    echo "  [OK] Persisted $key"
    return 0
  fi
  echo "  [!] Could not persist $key through Desktop."
  return 1
}

