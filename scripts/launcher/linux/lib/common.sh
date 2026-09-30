#!/usr/bin/env bash
# lib/common.sh — shared launcher output, repo facts, and safe helpers.
# Sourced by launcher.sh and command scripts. No host mutations here.
# No secrets are ever echoed: versions/paths only, bounded with head -c.
set -u

sentry_ok() { echo "  [OK] $1"; }
sentry_warn() { echo "  [!] $1"; }
sentry_fail() { echo "  [X] $1"; }
sentry_info() { echo "  $1"; }
sentry_section() { echo ""; echo "$1"; }

# Repository product version (package.json, no node required).
sentry_product_version() {
  local root="$1"
  local ver=""
  if [ -f "$root/package.json" ]; then
    ver=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$root/package.json" 2>/dev/null | head -n 1)
  fi
  if [ -z "$ver" ]; then ver="0.1.0-beta.1"; fi
  printf '%s\n' "$ver"
}

# Short git SHA of the checkout, or 'unknown' outside git.
sentry_short_sha() {
  local root="$1"
  local sha=""
  sha=$(git -C "$root" rev-parse --short HEAD 2>/dev/null || true)
  if [ -z "$sha" ]; then sha="unknown"; fi
  printf '%s\n' "$sha"
}

# Pinned pnpm version from the packageManager field (single source).
sentry_pinned_pnpm() {
  local root="$1"
  local pin=""
  if [ -f "$root/package.json" ]; then
    pin=$(sed -n 's/^  "packageManager": "pnpm@\([0-9][0-9.]*\)".*/\1/p' "$root/package.json" 2>/dev/null | head -n 1)
  fi
  if [ -z "$pin" ]; then pin="9.12.3"; fi
  printf '%s\n' "$pin"
}

# Pin constants live in scripts/launcher/launcher-logic.mjs (single source);
# bash reads them through node only when node is already guaranteed.
sentry_logic_pin() {
  local root="$1"
  local name="$2"
  node -e "import('$root/scripts/launcher/launcher-logic.mjs').then((m) => console.log(m['$name'] ?? ''))" 2>/dev/null
}

