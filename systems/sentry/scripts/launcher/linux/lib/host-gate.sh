#!/usr/bin/env bash
# lib/host-gate.sh — CachyOS-only support boundary for the native launcher.
# Reads ${SENTRY_OS_RELEASE_PATH:-/etc/os-release}; the env override is the
# test seam so fixtures prove routing without a CachyOS host.
# Product support requires ID=cachyos. ID_LIKE is never sufficient.
set -u

sentry_os_release_path() {
  if [ -n "${SENTRY_OS_RELEASE_PATH:-}" ]; then
    printf '%s\n' "$SENTRY_OS_RELEASE_PATH"
  else
    printf '%s\n' "/etc/os-release"
  fi
}

# Lower-cased ID field, or empty when unreadable.
sentry_os_id() {
  local path="$(sentry_os_release_path)"
  local id=""
  if [ -f "$path" ]; then
    id=$(sed -n 's/^ID=//p' "$path" 2>/dev/null | head -n 1 | tr -d '"' | tr '[:upper:]' '[:lower:]')
  fi
  printf '%s\n' "$id"
}

# Human-readable distro name for diagnostics (never a secret).
sentry_os_pretty() {
  local path="$(sentry_os_release_path)"
  local name=""
  if [ -f "$path" ]; then
    name=$(sed -n 's/^PRETTY_NAME=//p' "$path" 2>/dev/null | head -n 1 | sed 's/^"//;s/"$//')
    if [ -z "$name" ]; then
      name=$(sed -n 's/^NAME=//p' "$path" 2>/dev/null | head -n 1 | sed 's/^"//;s/"$//')
    fi
  fi
  if [ -z "$name" ]; then name="unknown"; fi
  printf '%s\n' "$name" | head -c 200
}

# Fail closed unless this host is CachyOS. Prints the exact support message.
sentry_require_cachyos() {
  local id="$(sentry_os_id)"
  if [ "$id" = "cachyos" ]; then return 0; fi
  echo "Native Linux support currently targets CachyOS only."
  echo "Detected: $(sentry_os_pretty)."
  return 3
}

