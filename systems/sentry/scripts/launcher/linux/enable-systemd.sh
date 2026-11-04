#!/usr/bin/env bash
# Enable systemd in /etc/wsl.conf: backup first, preserve unrelated settings.
# Runs as root via `wsl -d <distro> -u root` (no interactive sudo).
set -u
if [ -f /etc/wsl.conf ]; then
  cp -n /etc/wsl.conf /etc/wsl.conf.sentry-bak 2>/dev/null || true
fi
if grep -q '^\[boot\]' /etc/wsl.conf 2>/dev/null; then
  if grep -q '^systemd' /etc/wsl.conf; then
    sed -i 's/^systemd.*/systemd=true/' /etc/wsl.conf
  else
    sed -i '/^\[boot\]/a systemd=true' /etc/wsl.conf
  fi
else
  printf '[boot]\nsystemd=true\n' | tee -a /etc/wsl.conf >/dev/null
fi
echo '--- wsl.conf after change ---'
cat /etc/wsl.conf
