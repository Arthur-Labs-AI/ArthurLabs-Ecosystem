#!/usr/bin/env bash
# Probe systemd user services. Prints SYSTEMD_OK or SYSTEMD_MISSING.
set -u
if systemctl --user show-environment >/dev/null 2>&1 && systemd-run --user --pipe --wait /usr/bin/true >/dev/null 2>&1; then
  echo SYSTEMD_OK
else
  echo SYSTEMD_MISSING
fi
