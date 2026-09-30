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
. "$LINUX_DIR/lib/config.sh"
. "$LINUX_DIR/lib/shim.sh"
. "$LINUX_DIR/lib/node.sh"
. "$LINUX_DIR/lib/pnpm.sh"
. "$LINUX_DIR/lib/deploy.sh"
. "$LINUX_DIR/lib/verify.sh"
. "$LINUX_DIR/lib/agents.sh"
. "$LINUX_DIR/lib/desktop-ctl.sh"
. "$LINUX_DIR/lib/broker.sh"
. "$LINUX_DIR/distros/cachyos.sh"
. "$LINUX_DIR/commands/version.sh"
. "$LINUX_DIR/commands/doctor.sh"
. "$LINUX_DIR/commands/status.sh"
. "$LINUX_DIR/commands/open.sh"
. "$LINUX_DIR/commands/stop.sh"
. "$LINUX_DIR/commands/update.sh"
. "$LINUX_DIR/commands/cli.sh"
. "$LINUX_DIR/commands/setup.sh"

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
  setup)
    cmd_setup "$@"
    exit "$?"
    ;;
  doctor)
    sentry_require_cachyos || exit 3
    cmd_doctor "$@"
    exit "$?"
    ;;
  open)
    sentry_require_cachyos || exit 3
    cmd_open "$@"
    exit "$?"
    ;;
  stop)
    sentry_require_cachyos || exit 3
    cmd_stop "$@"
    exit "$?"
    ;;
  status)
    sentry_require_cachyos || exit 3
    cmd_status "$@"
    exit "$?"
    ;;
  update)
    sentry_require_cachyos || exit 3
    cmd_update "$@"
    exit "$?"
    ;;
  __post-update)
    sentry_require_cachyos || exit 3
    cmd_post_update "$@"
    exit "$?"
    ;;
  cli)
    sentry_require_cachyos || exit 3
    cmd_cli "$@"
    exit "$?"
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    echo "Run: sentry help" >&2
    exit 1
    ;;
esac

