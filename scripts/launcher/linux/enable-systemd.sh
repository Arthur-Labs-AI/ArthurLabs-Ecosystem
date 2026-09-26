#!/usr/bin/env bash
# Enable systemd in /etc/wsl.conf: backup first, preserve unrelated settings.
set -u
if [ -f /etc/wsl.conf ]; then
  sudo cp -n /etc/wsl.conf /etc/wsl.conf.sentry-bak 2>/dev/null || true
fi
if grep -q '^\[boot\]' /etc/wsl.conf 2>/dev/null; then
  if grep -q '^systemd' /etc/wsl.conf; then
    sudo sed -i 's/^systemd.*/systemd=true/' /etc/wsl.conf
  else
    sudo sed -i '/^\[boot\]/a systemd=true' /etc/wsl.conf
  fi
else
  printf '[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf >/dev/null
fi
echo '--- wsl.conf after change ---'
cat /etc/wsl.conf
