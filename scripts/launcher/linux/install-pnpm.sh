#!/usr/bin/env bash
# Install the pinned pnpm globally. $1 = version (e.g. 9.12.3).
set -e
VERSION="$1"
sudo npm install -g "pnpm@${VERSION}"
pnpm --version
