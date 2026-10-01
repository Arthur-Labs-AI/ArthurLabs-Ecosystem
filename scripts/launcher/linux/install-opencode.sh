#!/usr/bin/env bash
# Install the tested OpenCode into the Sentry-managed location.
# $1 = version (e.g. 1.18.32). Managed binary:
#   $HOME/.local/share/sentry/tools/opencode/node_modules/.bin/opencode
set -e
VERSION="$1"
mkdir -p "$HOME/.local/share/sentry/tools/opencode"
cd "$HOME/.local/share/sentry/tools/opencode"
if [ ! -f package.json ]; then npm init -y >/dev/null 2>&1; fi
# --no-ignore-scripts: the managed binary requires its install scripts, so a
# user/global npm ignore-scripts=true config must not silently skip them.
# Scoped to this prefix only; the user's own config is never modified.
npm install --no-ignore-scripts "opencode-ai@${VERSION}" 2>&1 | tail -2
./node_modules/.bin/opencode --version
