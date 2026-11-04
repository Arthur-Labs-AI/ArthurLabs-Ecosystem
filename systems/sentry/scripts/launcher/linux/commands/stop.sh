#!/usr/bin/env bash
# commands/stop.sh — graceful Sentry shutdown (never broad-kills).
set -u

cmd_stop() {
  sentry_desktop_stop_graceful "$REPO_ROOT" 45
  return "$?"
}

