#!/usr/bin/env bash
# commands/version.sh — stable, script-friendly version output.
# Works everywhere (no host gate, no node required).
set -u

cmd_version() {
  local root="$1"
  echo "Sentry v$(sentry_product_version "$root")"
  echo "Commit $(sentry_short_sha "$root")"
  local branch=""
  branch=$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  if [ -n "$branch" ]; then echo "Branch $branch"; fi
  return 0
}

