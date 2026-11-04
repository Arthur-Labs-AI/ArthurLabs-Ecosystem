#!/usr/bin/env bash
# Systemd readiness with installation vs enablement distinction:
#   SYSTEMD_OK                user manager fully ready
#   SYSTEMD_DISABLED          binaries present, WSL systemd not enabled
#   SYSTEMD_USER_UNAVAILABLE  enabled (or unknown), but no user manager
#   SYSTEMD_BIN_MISSING       systemctl/systemd-run absent entirely
set -u
if ! command -v systemctl >/dev/null 2>&1 || ! command -v systemd-run >/dev/null 2>&1; then
  echo SYSTEMD_BIN_MISSING
  exit 0
fi
if systemctl --user show-environment >/dev/null 2>&1 && systemd-run --user --pipe --wait /usr/bin/true >/dev/null 2>&1; then
  echo SYSTEMD_OK
  exit 0
fi
if grep -q '^systemd=true' /etc/wsl.conf 2>/dev/null; then
  echo SYSTEMD_USER_UNAVAILABLE
else
  echo SYSTEMD_DISABLED
fi
