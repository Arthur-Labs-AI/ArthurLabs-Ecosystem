#!/usr/bin/env bash
# commands/update.sh — safe native update (tracks origin/main).
# Safety order: refuse dirty/diverged trees with zero mutations, fetch,
# fast-forward only, then re-exec the UPDATED launcher for install/build/
# deploy. runtime/current never moves until the new deploy validates, the
# previous runtime is retained, and user data/credentials are untouched.
set -u

cmd_update() {
  local repo="$REPO_ROOT"
  echo ""
  echo "Sentry update (tracks latest origin/main commits)"
  local branch=""
  branch=$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  if [ "$branch" != "main" ]; then
    sentry_fail "Sentry Beta updates track origin/main."
    echo ""
    echo "Current branch:"
    echo "    $branch"
    echo ""
    echo "Switch to main and rerun:"
    echo "    git switch main"
    echo "    sentry update"
    echo "Zero Git mutations were made."
    return 1
  fi
  local old_sha=""
  old_sha=$(git -C "$repo" rev-parse HEAD 2>/dev/null || true)
  local porcelain=""
  porcelain=$(git -C "$repo" status --porcelain 2>/dev/null || true)
  if [ -n "$porcelain" ]; then
    sentry_fail "Sentry cannot update because this repository contains local changes."
    printf '%s\n' "$porcelain" | head -n 20
    echo "Commit, stash, or discard these changes, then run: sentry update"
    echo "Sentry never resets or stashes your changes automatically."
    return 1
  fi
  echo "  git fetch --prune origin main ..."
  if ! git -C "$repo" fetch --prune origin main; then
    sentry_fail "git fetch failed (network or remote issue)."
    return 1
  fi
  local remote_sha=""
  remote_sha=$(git -C "$repo" rev-parse origin/main 2>/dev/null || true)
  if [ -z "$remote_sha" ]; then
    sentry_fail "origin/main is unavailable after fetch."
    return 1
  fi
  if [ -n "$old_sha" ] && [ "$old_sha" = "$remote_sha" ]; then
    echo "Sentry is already up to date (${old_sha:0:9})."
    return 0
  fi
  local was_running=0
  if sentry_desktop_running; then was_running=1; fi
  if [ "$was_running" = "1" ]; then
    echo "  An update is available; stopping Sentry..."
    sentry_desktop_ensure_stopped "$repo"
  fi
  echo "  git merge --ff-only origin/main ..."
  if ! git -C "$repo" merge --ff-only origin/main; then
    sentry_fail "Fast-forward to origin/main failed (local main diverged). Resolve manually, then rerun."
    echo "Sentry was stopped; reopen it with: sentry open"
    return 1
  fi
  local new_sha=""
  new_sha=$(git -C "$repo" rev-parse HEAD 2>/dev/null || echo "$remote_sha")
  echo "Updated: ${old_sha:0:9} -> ${new_sha:0:9}"
  echo "  Re-executing the updated launcher for install/build/deploy..."
  if [ "$was_running" = "1" ]; then
    exec bash "$repo/sentry" __post-update "$old_sha" "$new_sha" --was-running
  else
    exec bash "$repo/sentry" __post-update "$old_sha" "$new_sha"
  fi
}

# Second half of update, running from the UPDATED tree after the merge.
# Not advertised in help; invoked only through the handoff above.
cmd_post_update() {
  local repo="$REPO_ROOT"
  local old_sha="${1:-unknown}"
  local new_sha="${2:-unknown}"
  local was_running=0
  if [ "${3:-}" = "--was-running" ]; then was_running=1; fi
  local version="$(sentry_product_version "$repo")"
  export SENTRY_NON_INTERACTIVE="${SENTRY_NON_INTERACTIVE:-0}"
  echo "  pnpm install --frozen-lockfile ..."
  if ! (cd "$repo" && pnpm install --frozen-lockfile); then
    sentry_fail "pnpm install failed after update (previous runtime preserved)."
    return 1
  fi
  echo "  pnpm build ..."
  if ! (cd "$repo" && pnpm build); then
    sentry_fail "pnpm build failed after update (previous runtime preserved)."
    return 1
  fi
  local prev_current="$(readlink "$HOME/.local/share/sentry/runtime/current" 2>/dev/null || echo NONE)"
  if ! sentry_runtime_deploy "$repo" "${version}-${new_sha}"; then return 1; fi
  local node_bin="$(sentry_config_get SENTRY_NODE_BINARY)"
  if [ -z "$node_bin" ]; then node_bin="node"; fi
  local entry="$HOME/.local/share/sentry/runtime/current/apps/runtime/dist/host.js"
  local hello_line=""
  if ! hello_line=$(sentry_verify_runtime "$entry" "$node_bin" "$repo"); then
    printf '%s\n' "$hello_line"
    sentry_rollback_runtime "$prev_current"
    sentry_fail "Runtime verification failed after update (previous runtime preserved)."
    return 1
  fi
  printf '%s\n' "$hello_line"
  sentry_install_shim "$repo"
  sentry_config_set SENTRY_SETUP_VERSION "$version"
  sentry_config_set SENTRY_SETUP_COMMIT "$new_sha"
  echo "Updated: ${old_sha:0:9} -> ${new_sha:0:9}"
  echo "Provider settings and projects were preserved (no migration in this release)."
  if [ "$was_running" = "1" ]; then
    cmd_open
    return "$?"
  fi
  echo "Sentry was not running before; leaving it stopped."
  return 0
}

