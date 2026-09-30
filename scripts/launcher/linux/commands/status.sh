#!/usr/bin/env bash
# commands/status.sh — installation status without starting the app.
# Desktop liveness comes only from a completed broker handshake; a stale
# socket file alone reports stopped, never alive.
set -u

cmd_status() {
  local as_json=0
  local arg
  for arg in "$@"; do
    case "$arg" in
      --json) as_json=1 ;;
      *)
        echo "Unknown status flag: $arg" >&2
        return 1
        ;;
    esac
  done
  local repo="$REPO_ROOT"
  local linux_dir="$repo/scripts/launcher/linux"
  local version="$(sentry_product_version "$repo")"
  local sha="$(sentry_short_sha "$repo")"
  local branch=""
  branch=$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  local clean="yes"
  if [ -n "$(git -C "$repo" status --porcelain 2>/dev/null || true)" ]; then clean="no"; fi
  local pretty="$(sentry_os_pretty)"
  local pretty="$(sentry_os_pretty)"
  local node_info="missing"
  if command -v node >/dev/null 2>&1; then node_info="$(node --version 2>/dev/null | head -n 1) ($(command -v node))"; fi
  local systemd="unknown"
  local sys_state="$(bash "$linux_dir/check-systemd.sh" 2>/dev/null | tail -n 1 || true)"
  if [ "$sys_state" = "SYSTEMD_OK" ]; then systemd="ready"; else systemd="unavailable"; fi
  local built="not built"
  if [ -f "$repo/apps/desktop/dist/main/index.js" ] && [ -f "$repo/apps/desktop/dist/renderer/index.html" ]; then built="built"; fi
  local current="NONE"
  current=$(readlink "$HOME/.local/share/sentry/runtime/current" 2>/dev/null || echo NONE)
  local running="no"
  local sock="$(sentry_broker_socket 2>/dev/null || true)"
  if [ -n "$sock" ] && sentry_broker_probe "$sock" >/dev/null 2>&1; then running="yes"; fi
  local tool_oc="unchecked" tool_ds="unchecked" tool_cc="unchecked"
  if bash "$linux_dir/check-opencode.sh" 2>/dev/null | grep -q '1.18.32'; then tool_oc="1.18.32"; else tool_oc="missing/unverified"; fi
  local dse="$(sed -n "s/.*DEEPSEEK_SDK_VERSION = '\([^']*\)'.*/\1/p" "$repo/packages/harness-deepseek/src/sdk.ts" | head -n 1)"
  if bash "$linux_dir/check-deepseek.sh" "$dse" 2>/dev/null | grep -q 'DSH_OK'; then tool_ds="$dse managed"; else tool_ds="missing"; fi
  if bash "$linux_dir/check-claude.sh" 2.1.270 2>/dev/null | grep -q 'MANAGED_OK\|PATH_OK'; then tool_cc="2.1.270"; else tool_cc="missing/unverified"; fi
  if [ "$as_json" = "1" ]; then
    printf '{"product":"Sentry","release":"v0.1 Beta","version":"%s","commit":"%s","branch":"%s","clean":%s,' "$version" "$sha" "$branch" "$([ "$clean" = "yes" ] && echo true || echo false)"
    printf '"host":{"platform":"linux","distribution":"%s"},' "$pretty"
    printf '"native":{"node":"%s","systemd":"%s"},' "$node_info" "$systemd"
    printf '"sentry":{"desktopBuilt":%s,"runtime":"%s","running":%s,' "$([ "$built" = "built" ] && echo true || echo false)" "$current" "$([ "$running" = "yes" ] && echo true || echo false)"
    printf '"tools":{"opencode":"%s","deepseek":"%s","claude":"%s"}}}\n' "$tool_oc" "$tool_ds" "$tool_cc"
    return 0
  fi
  echo ""
  echo "Sentry v0.1 Beta"
  echo "Repository"
  echo "  Path        $repo"
  echo "  Branch      $branch"
  echo "  Commit      $sha"
  echo "  Clean       $clean"
  echo "Host"
  echo "  Platform    CachyOS ($pretty)"
  echo "  Node        $node_info"
  echo "  systemd     $systemd"
  echo "Sentry"
  echo "  Desktop     $built"
  echo "  Runtime     $current"
  echo "Agent tools"
  echo "  OpenCode    $tool_oc"
  echo "  DeepSeek    $tool_ds"
  echo "  Claude Code $tool_cc"
  echo "  Running     $running"
  return 0
}

