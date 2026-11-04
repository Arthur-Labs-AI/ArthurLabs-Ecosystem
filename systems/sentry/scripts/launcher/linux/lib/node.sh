#!/usr/bin/env bash
# lib/node.sh — standalone Node >= 22 resolution for native setup.
# Mirrors NativeLinuxPlatform semantics: explicit SENTRY_NODE_BINARY (or
# option) first, else PATH node; absolute result; version gate.
set -u

sentry_node_candidate() {
  if [ -n "${SENTRY_NODE_BINARY:-}" ]; then
    printf '%s\n' "$SENTRY_NODE_BINARY"
  else
    printf '%s\n' "node"
  fi
}

sentry_node_version_of() {
  local exe="$1"
  "$exe" --version 2>/dev/null | head -n 1 | tr -d '[:space:]'
}

sentry_node_major() {
  local out="$1"
  local major=""
  major=$(printf '%s' "$out" | sed -n 's/^v\{0,1\}\([0-9]\{1,\}\)\..*/\1/p' | head -n 1)
  printf '%s\n' "$major"
}

# Preferred Node for launcher commands: setup-persisted config first, then
# an explicitly exported SENTRY_NODE_BINARY, then PATH. The configured path
# is verified executable every time — never trusted stale.
sentry_preferred_node() {
  local cfg="$(sentry_config_get SENTRY_NODE_BINARY)"
  if [ -n "$cfg" ] && [ -x "$cfg" ]; then printf '%s\n' "$cfg"; return 0; fi
  if [ -n "${SENTRY_NODE_BINARY:-}" ] && [ -x "$SENTRY_NODE_BINARY" ]; then
    printf '%s\n' "$SENTRY_NODE_BINARY"
    return 0
  fi
  local found="$(command -v node || true)"
  if [ -n "$found" ]; then printf '%s\n' "$found"; fi
  return 0
}

# Export SENTRY_NODE_BINARY from launcher config when unset and valid.
sentry_seed_node_env() {
  if [ -z "${SENTRY_NODE_BINARY:-}" ]; then
    local cfg="$(sentry_config_get SENTRY_NODE_BINARY)"
    if [ -n "$cfg" ] && [ -x "$cfg" ]; then export SENTRY_NODE_BINARY="$cfg"; fi
  fi
  return 0
}

# Resolve to an absolute executable path (empty when unresolvable).
sentry_node_resolve() {
  local candidate="$1"
  case "$candidate" in
    *"/"*)
      if [ -x "$candidate" ]; then printf '%s\n' "$candidate"; fi
      return 0
      ;;
  esac
  local IFS_SAVE="$IFS"
  IFS=':'
  local dir
  for dir in $PATH; do
    if [ -x "$dir/$candidate" ] && [ ! -d "$dir/$candidate" ]; then
      printf '%s\n' "$dir/$candidate"
      IFS="$IFS_SAVE"
      return 0
    fi
  done
  IFS="$IFS_SAVE"
  return 0
}

# Ensure phase: reuse valid Node, else remediate via the CachyOS adapter.
# Prints SENTRY_NODE_RESOLVED=<abs path> on success.
sentry_ensure_node() {
  local candidate="$(sentry_node_candidate)"
  local resolved="$(sentry_node_resolve "$candidate")"
  if [ -n "$resolved" ]; then
    local ver="$(sentry_node_version_of "$resolved")"
    local major="$(sentry_node_major "$ver")"
    if [ -n "$major" ] && [ "$major" -ge 22 ]; then
      echo "  [OK] Node $ver ($resolved)"
      echo "SENTRY_NODE_RESOLVED=$resolved"
      return 0
    fi
    echo "  [X] Node $ver is too old: Sentry requires Node >= 22 ($resolved)"
  else
    echo "  [X] No standalone Node.js executable found ($candidate)"
  fi
  echo "  Install on CachyOS, then rerun: sentry setup"
  echo "    sudo pacman -S --needed nodejs npm"
  return 1
}

