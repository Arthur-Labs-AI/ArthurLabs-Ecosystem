#!/usr/bin/env bash
# Install Node.js 22 (NodeSource, official builds) on apt distros.
set -e
if ! command -v apt-get >/dev/null 2>&1; then
  echo APT_MISSING
  exit 3
fi
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
