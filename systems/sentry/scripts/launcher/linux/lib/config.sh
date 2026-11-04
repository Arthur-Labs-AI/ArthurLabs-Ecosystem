#!/usr/bin/env bash
# lib/config.sh — rootless launcher state (no secrets, ever).
# File: ~/.local/share/sentry/launcher/sentry.conf, KEY='value' lines.
# Stored: SENTRY_NODE_BINARY, SENTRY_REPO_PATH, SENTRY_SETUP_VERSION,
# SENTRY_SETUP_COMMIT, SENTRY_PNPM_PREFIX. Never credentials or keys.
set -u

sentry_config_path() {
  printf '%s\n' "$HOME/.local/share/sentry/launcher/sentry.conf"
}

sentry_config_get() {
  local key="$1"
  local file="$(sentry_config_path)"
  if [ ! -f "$file" ]; then return 0; fi
  sed -n "s/^$key='\(.*\)'$/\1/p" "$file" 2>/dev/null | tail -n 1
  return 0
}

# Values must be single-line without single quotes (paths/versions only).
sentry_config_set() {
  local key="$1"
  local value="$2"
  case "$key=$value" in
    *"'"* | *$'\n'*)
      echo "refusing to store unsafe config value for $key" >&2
      return 1
      ;;
  esac
  local file="$(sentry_config_path)"
  local dir="$(dirname "$file")"
  mkdir -p "$dir"
  # Same-directory temp file: rename(2) stays atomic on one filesystem
  # (mktemp(1) alone could land on another mount via TMPDIR).
  local tmp="$(mktemp "$dir/.sentry-conf.XXXXXX")"
  if [ -f "$file" ]; then grep -v "^$key=" "$file" > "$tmp" || true; fi
  printf "%s='%s'\n" "$key" "$value" >> "$tmp"
  chmod 0600 "$tmp"
  mv "$tmp" "$file"
  chmod 0600 "$file"
}

