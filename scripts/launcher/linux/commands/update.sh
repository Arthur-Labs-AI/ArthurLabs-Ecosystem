#!/usr/bin/env bash
# commands/update.sh — safe native update (tracks origin/main).
# Safety order: refuse dirty/diverged trees with zero mutations, fetch,
# fast-forward only, then re-exec the UPDATED launcher for install/build/
# deploy. runtime/current never moves until the new deploy validates, the
# previous runtime is retained, and user data/credentials are untouched.
set -u

cmd_update() {
  local repo="$REPO_ROOT"
  sentry_seed_node_env
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
  sentry_seed_node_env
  local version="$(sentry_product_version "$repo")"
  export SENTRY_NON_INTERACTIVE="${SENTRY_NON_INTERACTIVE:-0}"
  # Re-resolve toolchain from the UPDATED tree: pins may have changed, so
  # setup-time binaries are re-validated, never blindly trusted.
  local node_line=""
  node_line=$(sentry_ensure_node) || { printf '%s\n' "$node_line"; return 1; }
  printf '%s\n' "$node_line"
  local node_bin="$(printf '%s\n' "$node_line" | sed -n 's/^SENTRY_NODE_RESOLVED=//p' | head -n 1)"
  if [ -z "$node_bin" ]; then sentry_fail "Node resolution produced no executable."; return 1; fi
  export SENTRY_NODE_BINARY="$node_bin"
  export PATH="$(dirname "$node_bin"):$PATH"
  local pnpm_line=""
  pnpm_line=$(sentry_ensure_pnpm "$repo") || { printf '%s\n' "$pnpm_line"; return 1; }
  printf '%s\n' "$pnpm_line"
  local pnpm_bin="$(printf '%s\n' "$pnpm_line" | sed -n 's/^PNPM_RESOLVED=//p' | head -n 1)"
  if [ -z "$pnpm_bin" ]; then sentry_fail "pnpm resolution produced no executable."; return 1; fi
  if ! sentry_pnpm_install "$repo" "$pnpm_bin"; then
    sentry_fail "pnpm install failed after update (previous runtime preserved)."
    return 1
  fi
  if ! sentry_pnpm_build "$repo" "$pnpm_bin"; then
    sentry_fail "pnpm build failed after update (previous runtime preserved)."
    return 1
  fi
  local prev_current="NONE"
  prev_current=$(readlink "$HOME/.local/share/sentry/runtime/current" 2>/dev/null || echo NONE)
  if ! sentry_runtime_deploy "$repo" "${version}-${new_sha}" "$pnpm_bin"; then return 1; fi
  local entry="$HOME/.local/share/sentry/runtime/current/apps/runtime/dist/host.js"
  local hello_line=""
  if ! hello_line=$(sentry_verify_runtime "$entry" "$node_bin" "$repo"); then
    printf '%s\n' "$hello_line"
    sentry_rollback_runtime "$prev_current"
    sentry_fail "Runtime verification failed after update (previous runtime preserved)."
    return 1
  fi
  printf '%s\n' "$hello_line"
  # Agent pins may have changed with the update: reprovision (check first,
  # install on drift) so update never reports ready on stale binaries.
  local agents_out=""
  agents_out=$(sentry_provision_agents "$repo") || { printf '%s\n' "$agents_out"; return 1; }
  printf '%s\n' "$agents_out"
  sentry_install_shim "$repo"
  sentry_config_set SENTRY_NODE_BINARY "$node_bin"
  sentry_config_set SENTRY_PNPM_BINARY "$pnpm_bin"
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

