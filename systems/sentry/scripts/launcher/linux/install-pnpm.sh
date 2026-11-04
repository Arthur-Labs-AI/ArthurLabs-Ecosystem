#!/usr/bin/env bash
# Install the pinned pnpm globally for direct `wsl -- pnpm` execution.
# Runs as root via `wsl -d <distro> -u root` (no interactive sudo).
# $1 = version (e.g. 9.12.3).
set -e
VERSION="$1"
command -v npm >/dev/null 2>&1 || { echo NPM_MISSING; exit 4; }
npm install -g "pnpm@${VERSION}"
pnpm --version
