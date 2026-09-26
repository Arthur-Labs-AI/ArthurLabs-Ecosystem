#!/usr/bin/env bash
# Install Node.js 22 system-wide (NodeSource, official builds).
# Runs as root via `wsl -d <distro> -u root` (no interactive sudo).
set -e
if ! command -v apt-get >/dev/null 2>&1; then
  echo APT_MISSING
  exit 3
fi
apt-get update
apt-get install -y ca-certificates curl gnupg
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version
