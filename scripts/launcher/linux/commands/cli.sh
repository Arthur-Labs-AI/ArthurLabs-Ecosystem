#!/usr/bin/env bash
# commands/cli.sh — forward to the Sentry automation CLI (same contract).
# The Desktop must be running: the CLI is a frontend and never starts
# its own runtime. Mirrors the Windows `sentry cli` forwarding exactly.
set -u

sentry_cli_help() {
  echo ""
  echo "Sentry CLI (same runtime as Desktop)"
  echo ""
  echo "Usage:"
  echo "  sentry cli <command>"
  echo ""
  echo "Sentry Desktop must be running (sentry open). The CLI is a frontend:"
  echo "it never opens the database or starts its own runtime."
  echo ""
  echo "Commands:"
  echo "  capabilities [--json]"
  echo "  project list [--json]"
  echo "  project add \"<path>\" [--json]"
  echo "  project show <project-id> [--json]"
  echo "  project update <project-id> [path] [--json]"
  echo "  project delete <project-id> --yes [--json]"
  echo "  project revisions <project-id> [--json]"
  echo "  project doctor <project-id> [--json]"
  echo "  agent list [--json]"
  echo "  agent doctor opencode|deepseek|glm [--json]"
  echo "  run start <project-id> --mode full|targeted [--agents opencode,deepseek,glm] [--paths a,b] [--wait] [--timeout-ms <ms>] [--json]"
  echo "  run list <project-id> [--json]"
  echo "  run show <run-id> [--json]"
  echo "  run status <run-id> [--json]"
  echo "  run cancel <run-id> [--json]"
  echo "  run result <run-id> [--json]"
  echo "  run export <run-id> --format log|json --out <path> [--json]"
  echo "  issue list <project-id> [--json]"
  echo "  issue show <issue-id> [--json]"
  echo "  issue history <issue-id> [--json]"
  echo "  retest start <issue-id> [--revision <id>] [--agents opencode,deepseek,glm] --wait [--json]"
  echo "  retest show <retest-run-id> [--json]"
  echo "  retest cancel <retest-run-id> [--json]"
  echo ""
  echo "Automation (Nexus): always pass --json and parse stdout with JSON.parse."
  return 0
}

cmd_cli() {
  local repo="$REPO_ROOT"
  if [ $# -eq 0 ]; then sentry_cli_help; return 0; fi
  local arg
  for arg in "$@"; do
    case "$arg" in
      --help | -h) sentry_cli_help; return 0 ;;
    esac
  done
  local entry="$repo/apps/cli/dist/index.js"
  if [ ! -f "$entry" ]; then
    sentry_fail "Sentry CLI is not built. Run: sentry setup"
    return 1
  fi
  local node_bin="$(sentry_preferred_node)"
  if [ -z "$node_bin" ]; then node_bin="node"; fi
  "$node_bin" "$entry" "$@"
  return "$?"
}

