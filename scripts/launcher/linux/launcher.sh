#!/usr/bin/env bash
# Native Linux launcher framework (CachyOS only): command routing.
# Each command lives in commands/<name>.sh; shared behavior in lib/.
# help/version work on any host; every other command requires CachyOS.
set -euo pipefail

LINUX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$LINUX_DIR/../../.." && pwd)"
export SENTRY_REPO_ROOT="$REPO_ROOT"

. "$LINUX_DIR/lib/common.sh"
. "$LINUX_DIR/lib/host-gate.sh"
. "$LINUX_DIR/commands/version.sh"

cmd_help() {
  echo ""
  echo "Sentry v0.1 Beta (native Linux)"
  echo ""
  echo "Usage:"
  echo "  sentry <command>"
  echo ""
  echo "Commands:"
  echo "  setup     Prepare CachyOS host and Sentry (idempotent)"
  echo "  open      Launch Sentry Desktop"
  echo "  update    Pull latest commits and update Sentry"
  echo "  stop      Gracefully stop Sentry"
  echo "  cli       Control the running Desktop (same runtime; automation uses --json)"
  echo "  status    Show installation status"
  echo "  doctor    Run detailed diagnostics"
  echo "  version   Show version and commit"
  echo "  help      Show this help"
  echo ""
  echo "Native Linux support: CachyOS"
  return 0
}

cmd="${1:-help}"
if [ $# -gt 0 ]; then shift; fi
case "$cmd" in
  help | -h | --help)
    cmd_help
    exit 0
    ;;
  version | -v | --version)
    cmd_version "$REPO_ROOT"
    exit 0
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    echo "Run: sentry help" >&2
    exit 1
    ;;
esac

