#!/usr/bin/env bash
# Base Linux utility validation for the Sentry launcher/runtime scripts.
# Emits HAVE-<tool> / MISS-<tool>. These come from standard Ubuntu packages
# (bash, coreutils, findutils, grep, sed); absence means a broken minimal
# image, so setup must fail with an actionable message, not install blindly.
# NOTE: systemctl/systemd-run are intentionally NOT checked here — systemd
# has its own repair flow (Ensure-SentrySystemd) that must stay reachable.
set -u
check() {
  bin="$1"
  if command -v "$bin" >/dev/null 2>&1; then echo "HAVE-$bin"; else echo "MISS-$bin"; fi
}
check bash
check find
check readlink
check timeout
check grep
check sed
