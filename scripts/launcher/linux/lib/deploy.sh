#!/usr/bin/env bash
# lib/deploy.sh — native versioned runtime deployment (thin wrapper).
# Reuses apps/runtime/scripts/deploy-inner.sh through the existing
# log-decoupled deploy-wrap.sh: no new deployment logic. `current` moves
# only inside deploy-inner after build+entry validation, so a failed
# deploy leaves the previous runtime untouched by construction.
set -u

# Deploy <version> from the repo tree with an explicit pnpm executable
# ($3; defaults to PATH pnpm for backward-compatible direct use).
# Prints DEPLOY_* facts.
sentry_runtime_deploy() {
  local repo="$1"
  local version="$2"
  local safe="$(printf '%s' "$version" | tr -c 'A-Za-z0-9._-' '_' | head -c 120)"
  local logdir="$HOME/.local/share/sentry/logs"
  mkdir -p "$logdir"
  local log="$logdir/deploy-$safe.log"
  echo "  Deploying native runtime $version ..."
  local pnpm_bin="${3:-pnpm}"
  if ! bash "$repo/scripts/launcher/linux/deploy-wrap.sh" \
    "$repo/apps/runtime/scripts/deploy-inner.sh" "$repo" "$version" "$log" "$pnpm_bin"; then
    echo "  [X] Runtime deployment failed (previous runtime left untouched)."
    echo "  Log tail:"
    tail -n 15 "$log" 2>/dev/null || true
    return 1
  fi
  local current=""
  current=$(readlink "$HOME/.local/share/sentry/runtime/current" 2>/dev/null || true)
  if [ "$current" != "$version" ]; then
    echo "  [X] Deploy finished but 'current' is [$current], want [$version]."
    return 1
  fi
  echo "  [OK] Runtime deployed: $version"
  echo "DEPLOY_VERSION=$version"
  return 0
}

# Restore runtime/current after a failed verification. The previous version
# directory is always retained, so this never loses data. With the NONE
# sentinel (first install, nothing previous) the failed `current` symlink is
# REMOVED: current must never point at an unverified deployment. The failed
# version directory itself is retained for diagnostics.
sentry_rollback_runtime() {
  local prev="$1"
  local current="$HOME/.local/share/sentry/runtime/current"
  if [ "$prev" = "NONE" ] || [ -z "$prev" ]; then
    rm -f "$current"
    echo "  Removed unverified runtime/current (no previous runtime)."
    return 0
  fi
  ln -sfn "$prev" "$current"
  echo "  Rolled runtime/current back to $prev."
  return 0
}

